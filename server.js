const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const multer = require('multer');
const sharp = require('sharp');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'plants.db');
const PHOTOS_DIR = process.env.PHOTOS_DIR || path.join(path.dirname(DB_PATH), 'photos');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(PHOTOS_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS plants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    room TEXT NOT NULL,
    group_name TEXT,
    status TEXT DEFAULT 'confirmed',
    notes TEXT,
    propagating INTEGER DEFAULT 0,
    new_location TEXT,
    photo_filename TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plant_id TEXT NOT NULL,
    date TEXT NOT NULL,
    type TEXT NOT NULL,
    note TEXT,
    FOREIGN KEY(plant_id) REFERENCES plants(id) ON DELETE CASCADE
  );
`);

// One-time seed on first boot (empty DB only) -- decodes any embedded
// base64 photos from seed-data.json into real files under PHOTOS_DIR.
const existingCount = db.prepare('SELECT COUNT(*) AS c FROM plants').get().c;
if (existingCount === 0) {
  const seedPath = path.join(__dirname, 'seed-data.json');
  if (fs.existsSync(seedPath)) {
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    const insertPlant = db.prepare(`
      INSERT INTO plants (id, name, room, group_name, status, notes, propagating, new_location, photo_filename)
      VALUES (@id, @name, @room, @group_name, @status, @notes, @propagating, @new_location, @photo_filename)
    `);
    const insertLog = db.prepare(
      'INSERT INTO logs (plant_id, date, type, note) VALUES (?, ?, ?, ?)'
    );
    const seedTx = db.transaction((items) => {
      for (const p of items) {
        let photoFilename = null;
        if (p.photo && p.photo.startsWith('data:image')) {
          const b64 = p.photo.split(',')[1];
          photoFilename = `${p.id}.jpg`;
          fs.writeFileSync(path.join(PHOTOS_DIR, photoFilename), Buffer.from(b64, 'base64'));
        }
        insertPlant.run({
          id: p.id,
          name: p.name,
          room: p.room,
          group_name: p.group || 'unsure',
          status: p.status || 'confirmed',
          notes: p.notes || '',
          propagating: p.propagating ? 1 : 0,
          new_location: p.newLocation || '',
          photo_filename: photoFilename,
        });
        (p.log || []).forEach((l) => insertLog.run(p.id, l.date, l.type, l.note || ''));
      }
    });
    seedTx(seed);
    console.log(`Seeded ${seed.length} plants from seed-data.json`);
  }
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/photos', express.static(PHOTOS_DIR, { maxAge: '30d' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

function rowToPlant(row) {
  const logs = db
    .prepare('SELECT date, type, note FROM logs WHERE plant_id = ? ORDER BY id DESC')
    .all(row.id);
  return {
    id: row.id,
    name: row.name,
    room: row.room,
    group: row.group_name,
    status: row.status,
    notes: row.notes,
    propagating: !!row.propagating,
    newLocation: row.new_location || '',
    photoUrl: row.photo_filename ? `/photos/${row.photo_filename}` : '',
    log: logs,
  };
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/plants', (req, res) => {
  const rows = db.prepare('SELECT * FROM plants ORDER BY room, name').all();
  res.json(rows.map(rowToPlant));
});

app.post('/api/plants', (req, res) => {
  const { name, room, group, status, notes, propagating, newLocation } = req.body;
  if (!name || !room) return res.status(400).json({ error: 'name and room are required' });
  const id = 'p' + crypto.randomBytes(6).toString('hex');
  db.prepare(`
    INSERT INTO plants (id, name, room, group_name, status, notes, propagating, new_location)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, room, group || 'unsure', status || 'confirmed', notes || '', propagating ? 1 : 0, newLocation || '');
  res.json(rowToPlant(db.prepare('SELECT * FROM plants WHERE id = ?').get(id)));
});

app.put('/api/plants/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM plants WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const b = req.body;
  db.prepare(`
    UPDATE plants SET name=?, room=?, group_name=?, status=?, notes=?, propagating=?, new_location=?
    WHERE id=?
  `).run(
    b.name ?? existing.name,
    b.room ?? existing.room,
    b.group ?? existing.group_name,
    b.status ?? existing.status,
    b.notes ?? existing.notes,
    b.propagating !== undefined ? (b.propagating ? 1 : 0) : existing.propagating,
    b.newLocation !== undefined ? b.newLocation : existing.new_location,
    req.params.id
  );
  res.json(rowToPlant(db.prepare('SELECT * FROM plants WHERE id = ?').get(req.params.id)));
});

app.delete('/api/plants/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM plants WHERE id = ?').get(req.params.id);
  if (row && row.photo_filename) {
    const fp = path.join(PHOTOS_DIR, row.photo_filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  db.prepare('DELETE FROM plants WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/plants/:id/logs', (req, res) => {
  const plant = db.prepare('SELECT * FROM plants WHERE id = ?').get(req.params.id);
  if (!plant) return res.status(404).json({ error: 'not found' });
  const { type, note } = req.body;
  const date = new Date().toISOString().slice(0, 10);
  db.prepare('INSERT INTO logs (plant_id, date, type, note) VALUES (?, ?, ?, ?)').run(
    req.params.id,
    date,
    type,
    note || ''
  );
  res.json(rowToPlant(db.prepare('SELECT * FROM plants WHERE id = ?').get(req.params.id)));
});

app.post('/api/plants/:id/photo', upload.single('photo'), async (req, res) => {
  const plant = db.prepare('SELECT * FROM plants WHERE id = ?').get(req.params.id);
  if (!plant) return res.status(404).json({ error: 'not found' });
  if (!req.file) return res.status(400).json({ error: 'no file uploaded' });

  if (plant.photo_filename) {
    const old = path.join(PHOTOS_DIR, plant.photo_filename);
    if (fs.existsSync(old)) fs.unlinkSync(old);
  }

  const filename = `${req.params.id}-${Date.now()}.jpg`;
  try {
    await sharp(req.file.buffer)
      .rotate()
      .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 74 })
      .toFile(path.join(PHOTOS_DIR, filename));
  } catch (err) {
    return res.status(400).json({ error: 'could not process image' });
  }

  db.prepare('UPDATE plants SET photo_filename = ? WHERE id = ?').run(filename, req.params.id);
  res.json(rowToPlant(db.prepare('SELECT * FROM plants WHERE id = ?').get(req.params.id)));
});

app.delete('/api/plants/:id/photo', (req, res) => {
  const plant = db.prepare('SELECT * FROM plants WHERE id = ?').get(req.params.id);
  if (!plant) return res.status(404).json({ error: 'not found' });
  if (plant.photo_filename) {
    const fp = path.join(PHOTOS_DIR, plant.photo_filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  db.prepare('UPDATE plants SET photo_filename = NULL WHERE id = ?').run(req.params.id);
  res.json(rowToPlant(db.prepare('SELECT * FROM plants WHERE id = ?').get(req.params.id)));
});

// Convenience JSON export (metadata + photo URLs). The real backup is the
// /data volume itself -- see README for the recommended way to back that up.
app.get('/api/export', (req, res) => {
  const rows = db.prepare('SELECT * FROM plants').all().map(rowToPlant);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="plant-ledger-export-${new Date().toISOString().slice(0, 10)}.json"`
  );
  res.json(rows);
});

app.listen(PORT, () => console.log(`Plant Ledger listening on port ${PORT}`));
