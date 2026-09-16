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
  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plant_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(plant_id) REFERENCES plants(id) ON DELETE CASCADE
  );
`);

// One-time, idempotent migration: plants.photo_filename was the old
// single-photo column. Any plant that still has one set but no rows
// in `photos` yet gets it carried over as photo #1. The column itself
// is left in place (unused from here on) rather than dropped, since
// dropping columns on someone's live data isn't worth the risk for a
// column that just sits there harmlessly.
db.exec(`
  INSERT INTO photos (plant_id, filename, position)
  SELECT id, photo_filename, 0 FROM plants
  WHERE photo_filename IS NOT NULL
  AND id NOT IN (SELECT plant_id FROM photos)
`);

// One-time seed on first boot (empty DB only) -- decodes any embedded
// base64 photos from seed-data.json into real files under PHOTOS_DIR.
const existingCount = db.prepare('SELECT COUNT(*) AS c FROM plants').get().c;
if (existingCount === 0) {
  const seedPath = path.join(__dirname, 'seed-data.json');
  if (fs.existsSync(seedPath)) {
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    const insertPlant = db.prepare(`
      INSERT INTO plants (id, name, room, group_name, status, notes, propagating, new_location)
      VALUES (@id, @name, @room, @group_name, @status, @notes, @propagating, @new_location)
    `);
    const insertLog = db.prepare(
      'INSERT INTO logs (plant_id, date, type, note) VALUES (?, ?, ?, ?)'
    );
    const insertPhoto = db.prepare(
      'INSERT INTO photos (plant_id, filename, position) VALUES (?, ?, ?)'
    );
    const seedTx = db.transaction((items) => {
      for (const p of items) {
        insertPlant.run({
          id: p.id,
          name: p.name,
          room: p.room,
          group_name: p.group || 'unsure',
          status: p.status || 'confirmed',
          notes: p.notes || '',
          propagating: p.propagating ? 1 : 0,
          new_location: p.newLocation || '',
        });
        if (p.photo && p.photo.startsWith('data:image')) {
          const b64 = p.photo.split(',')[1];
          const photoFilename = `${p.id}.jpg`;
          fs.writeFileSync(path.join(PHOTOS_DIR, photoFilename), Buffer.from(b64, 'base64'));
          insertPhoto.run(p.id, photoFilename, 0);
        }
        (p.log || []).forEach((l) => insertLog.run(p.id, l.date, l.type, l.note || ''));
      }
    });
    seedTx(seed);
    console.log(`Seeded ${seed.length} plants from seed-data.json`);
  }
}

const app = express();

// Single shared-password lock. This is a backstop, not the primary
// control -- the real access boundary is the NPM Access List in front
// of this container. Exempts /api/health so Docker's own HEALTHCHECK
// (which sends no credentials) keeps working.
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';
if (!AUTH_PASSWORD) {
  console.warn('AUTH_PASSWORD not set -- app-level lock is DISABLED. Set AUTH_PASSWORD to enable it.');
} else {
  // Brute-force guard. There's one shared password and no per-user
  // accounts, so this tracks failures globally rather than per-IP
  // (per-IP would need to trust X-Forwarded-For from the NPM proxy,
  // which is one more thing to get wrong for little benefit here).
  // Each wrong guess gets slower, and repeated lockouts back off
  // exponentially, up to a cap.
  const MAX_ATTEMPTS = 5;
  const BASE_LOCKOUT_MS = 30 * 1000;
  const MAX_LOCKOUT_MS = 15 * 60 * 1000;
  let failedAttempts = 0;
  let consecutiveLockouts = 0;
  let lockedUntil = 0;

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  app.use(async (req, res, next) => {
    if (req.path === '/api/health') return next();

    const now = Date.now();
    if (now < lockedUntil) {
      res.set('Retry-After', String(Math.ceil((lockedUntil - now) / 1000)));
      return res.status(429).send('Too many failed attempts. Try again later.');
    }

    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');
    let suppliedPassword = '';
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      suppliedPassword = decoded.slice(decoded.indexOf(':') + 1);
    }
    const supplied = Buffer.from(suppliedPassword);
    const expected = Buffer.from(AUTH_PASSWORD);
    const match = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);

    if (!match) {
      failedAttempts++;
      await delay(Math.min(failedAttempts, 10) * 250);
      if (failedAttempts >= MAX_ATTEMPTS) {
        const lockoutMs = Math.min(BASE_LOCKOUT_MS * 2 ** consecutiveLockouts, MAX_LOCKOUT_MS);
        lockedUntil = Date.now() + lockoutMs;
        consecutiveLockouts++;
        failedAttempts = 0;
        console.warn(`AUTH_PASSWORD: locked out for ${lockoutMs / 1000}s after repeated failed attempts`);
      }
      res.set('WWW-Authenticate', 'Basic realm="Plant Ledger"');
      return res.status(401).send('Authentication required');
    }

    failedAttempts = 0;
    consecutiveLockouts = 0;
    next();
  });
}

app.use(express.json({ limit: '2mb' }));
app.use('/photos', express.static(PHOTOS_DIR, { maxAge: '30d' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

function rowToPlant(row) {
  const logs = db
    .prepare('SELECT date, type, note FROM logs WHERE plant_id = ? ORDER BY id DESC')
    .all(row.id);
  const photos = db
    .prepare('SELECT id, filename FROM photos WHERE plant_id = ? ORDER BY position, id')
    .all(row.id)
    .map((p) => ({ id: p.id, url: `/photos/${p.filename}` }));
  return {
    id: row.id,
    name: row.name,
    room: row.room,
    group: row.group_name,
    status: row.status,
    notes: row.notes,
    propagating: !!row.propagating,
    newLocation: row.new_location || '',
    photos,
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
  const photos = db.prepare('SELECT filename FROM photos WHERE plant_id = ?').all(req.params.id);
  photos.forEach((p) => {
    const fp = path.join(PHOTOS_DIR, p.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  });
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

// Bulk operations, meant for an agent acting on several plants from one
// natural-language request ("mark these three confirmed", "I fertilized
// everything in the office"). Deliberately no bulk delete -- removing a
// plant stays one call per plant so a single bad request can't wipe out
// several at once. Callers are expected to resolve names to ids via
// GET /api/plants first; these never do fuzzy name matching themselves.
const BULK_UPDATE_FIELDS = ['name', 'room', 'group', 'status', 'notes', 'propagating', 'newLocation'];

app.post('/api/plants/bulk-update', (req, res) => {
  const { ids, changes } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids must be a non-empty array' });
  if (!changes || typeof changes !== 'object') return res.status(400).json({ error: 'changes object is required' });

  const updated = [];
  const notFound = [];
  const applyOne = db.transaction((id) => {
    const existing = db.prepare('SELECT * FROM plants WHERE id = ?').get(id);
    if (!existing) { notFound.push(id); return; }
    db.prepare(`
      UPDATE plants SET name=?, room=?, group_name=?, status=?, notes=?, propagating=?, new_location=?
      WHERE id=?
    `).run(
      changes.name ?? existing.name,
      changes.room ?? existing.room,
      changes.group ?? existing.group_name,
      changes.status ?? existing.status,
      changes.notes ?? existing.notes,
      changes.propagating !== undefined ? (changes.propagating ? 1 : 0) : existing.propagating,
      changes.newLocation !== undefined ? changes.newLocation : existing.new_location,
      id
    );
    updated.push(rowToPlant(db.prepare('SELECT * FROM plants WHERE id = ?').get(id)));
  });
  ids.forEach(applyOne);
  res.json({ updated, notFound });
});

app.post('/api/plants/bulk-logs', (req, res) => {
  const { ids, type, note } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids must be a non-empty array' });
  if (!type) return res.status(400).json({ error: 'type is required' });
  const date = new Date().toISOString().slice(0, 10);

  const updated = [];
  const notFound = [];
  const applyOne = db.transaction((id) => {
    const existing = db.prepare('SELECT * FROM plants WHERE id = ?').get(id);
    if (!existing) { notFound.push(id); return; }
    db.prepare('INSERT INTO logs (plant_id, date, type, note) VALUES (?, ?, ?, ?)').run(id, date, type, note || '');
    updated.push(rowToPlant(db.prepare('SELECT * FROM plants WHERE id = ?').get(id)));
  });
  ids.forEach(applyOne);
  res.json({ updated, notFound });
});

// Applies every plant's pending "planned new spot" (newLocation) as its
// actual room, same as the single-plant "Confirm move" button in the UI,
// just for many at once. Pass {ids: [...]} to restrict it, or omit ids
// to apply every plant that currently has a pending move.
app.post('/api/plants/confirm-moves', (req, res) => {
  const { ids } = req.body || {};
  const candidates = Array.isArray(ids) && ids.length
    ? ids.map((id) => db.prepare('SELECT * FROM plants WHERE id = ?').get(id)).filter(Boolean)
    : db.prepare("SELECT * FROM plants WHERE new_location IS NOT NULL AND new_location != ''").all();

  const moved = [];
  const applyOne = db.transaction((plant) => {
    if (!plant.new_location) return;
    db.prepare('UPDATE plants SET room = ?, new_location = ? WHERE id = ?').run(plant.new_location, '', plant.id);
    db.prepare('INSERT INTO logs (plant_id, date, type, note) VALUES (?, ?, ?, ?)').run(
      plant.id,
      new Date().toISOString().slice(0, 10),
      'Other',
      `Moved to ${plant.new_location}`
    );
    moved.push(rowToPlant(db.prepare('SELECT * FROM plants WHERE id = ?').get(plant.id)));
  });
  candidates.forEach(applyOne);
  res.json({ moved });
});

// Multiple photos per plant. Uploading adds one to the end of the
// list rather than replacing what's there; deleting removes just the
// one photo named.
app.post('/api/plants/:id/photos', upload.single('photo'), async (req, res) => {
  const plant = db.prepare('SELECT * FROM plants WHERE id = ?').get(req.params.id);
  if (!plant) return res.status(404).json({ error: 'not found' });
  if (!req.file) return res.status(400).json({ error: 'no file uploaded' });

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

  const nextPosition = db
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM photos WHERE plant_id = ?')
    .get(req.params.id).pos;
  db.prepare('INSERT INTO photos (plant_id, filename, position) VALUES (?, ?, ?)').run(
    req.params.id,
    filename,
    nextPosition
  );
  res.json(rowToPlant(db.prepare('SELECT * FROM plants WHERE id = ?').get(req.params.id)));
});

app.delete('/api/plants/:id/photos/:photoId', (req, res) => {
  const plant = db.prepare('SELECT * FROM plants WHERE id = ?').get(req.params.id);
  if (!plant) return res.status(404).json({ error: 'not found' });
  const photo = db
    .prepare('SELECT * FROM photos WHERE id = ? AND plant_id = ?')
    .get(req.params.photoId, req.params.id);
  if (!photo) return res.status(404).json({ error: 'photo not found' });

  const fp = path.join(PHOTOS_DIR, photo.filename);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  db.prepare('DELETE FROM photos WHERE id = ?').run(photo.id);
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

// One-shot snapshot for an LLM agent to fetch: everything /api/plants
// has, plus every photo embedded as a base64 data URI so a single
// authenticated request gets the full picture (literally) with no
// follow-up fetches against /photos. Meant for occasional "what's the
// current state of my plants" checks, not polling -- it reads every
// photo file off disk on every call.
app.get('/api/claude-snapshot', (req, res) => {
  const rows = db.prepare('SELECT * FROM plants ORDER BY room, name').all();
  const plants = rows.map((row) => {
    const plant = rowToPlant(row);
    plant.photos = plant.photos.map((p) => {
      const filename = p.url.split('/').pop();
      let data = null;
      try {
        const buf = fs.readFileSync(path.join(PHOTOS_DIR, filename));
        data = `data:image/jpeg;base64,${buf.toString('base64')}`;
      } catch (err) {
        // file missing/unreadable -- omit the data URI, keep the url
      }
      return { id: p.id, url: p.url, data };
    });
    return plant;
  });
  res.json({ generatedAt: new Date().toISOString(), plants });
});

const server = app.listen(PORT, () => console.log(`Plant Ledger listening on port ${PORT}`));

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  // Force-exit if connections don't drain in time (e.g. a stuck upload).
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  process.exit(1);
});
