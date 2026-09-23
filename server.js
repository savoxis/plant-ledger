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
const TRASH_RETENTION_DAYS = Number(process.env.TRASH_RETENTION_DAYS) || 30;

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
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plant_id TEXT NOT NULL,
    field TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    source TEXT NOT NULL DEFAULT 'agent',
    created_at TEXT DEFAULT (datetime('now'))
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

// One-time, idempotent migrations: add columns this DB predates.
// ALTER TABLE ADD COLUMN is additive and safe against live data; the
// existence check just keeps re-runs from erroring on a column
// that's already there.
const plantsCols = db.prepare("PRAGMA table_info(plants)").all().map((c) => c.name);
if (!plantsCols.includes('price_paid')) {
  db.exec('ALTER TABLE plants ADD COLUMN price_paid REAL');
}
if (!plantsCols.includes('deleted_at')) {
  db.exec('ALTER TABLE plants ADD COLUMN deleted_at TEXT');
}
if (!plantsCols.includes('potted_at')) {
  db.exec('ALTER TABLE plants ADD COLUMN potted_at TEXT');
}
if (!plantsCols.includes('parent_id')) {
  db.exec('ALTER TABLE plants ADD COLUMN parent_id TEXT');
}
if (!plantsCols.includes('flagged')) {
  db.exec('ALTER TABLE plants ADD COLUMN flagged INTEGER DEFAULT 0');
}

// One-time seed on first boot (empty DB only) -- decodes any embedded
// base64 photos from seed-data.json into real files under PHOTOS_DIR.
const existingCount = db.prepare('SELECT COUNT(*) AS c FROM plants').get().c;
if (existingCount === 0) {
  const seedPath = path.join(__dirname, 'seed-data.json');
  if (fs.existsSync(seedPath)) {
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    const insertPlant = db.prepare(`
      INSERT INTO plants (id, name, room, group_name, status, notes, propagating, new_location, price_paid)
      VALUES (@id, @name, @room, @group_name, @status, @notes, @propagating, @new_location, @price_paid)
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
          price_paid: p.pricePaid ?? null,
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

// Trash retention sweep. No scheduler in this app, so this runs once
// at boot -- fine for a personal app that gets restarted regularly
// anyway (deploys, host reboots), and worst case a purge is a day or
// two late, which is harmless for a retention window measured in
// weeks.
function purgePlantFiles(plantId) {
  const photos = db.prepare('SELECT filename FROM photos WHERE plant_id = ?').all(plantId);
  photos.forEach((p) => {
    const fp = path.join(PHOTOS_DIR, p.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  });
}
function purgeExpiredTrash() {
  const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const expired = db.prepare('SELECT id FROM plants WHERE deleted_at IS NOT NULL AND deleted_at < ?').all(cutoff);
  expired.forEach((row) => {
    purgePlantFiles(row.id);
    db.prepare('DELETE FROM plants WHERE id = ?').run(row.id);
  });
  if (expired.length) {
    console.log(`Purged ${expired.length} plant(s) from trash past the ${TRASH_RETENTION_DAYS}-day retention window`);
  }
}
purgeExpiredTrash();

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

// The frontend tags every one of its own requests with X-Source: ui.
// Anything without that header -- which is exactly how curl/an agent
// naturally calls this API, with zero extra effort required of them
// -- is recorded as 'agent'. Lets a human reviewing the audit log
// tell what they clicked versus what an AI touched.
function getSource(req) {
  return req.header('X-Source') === 'ui' ? 'ui' : 'agent';
}

function logAudit(plantId, field, oldValue, newValue, source) {
  db.prepare('INSERT INTO audit_log (plant_id, field, old_value, new_value, source) VALUES (?, ?, ?, ?, ?)').run(
    plantId,
    field,
    oldValue === null || oldValue === undefined ? null : String(oldValue),
    newValue === null || newValue === undefined ? null : String(newValue),
    source
  );
}

// Coerces an incoming pricePaid value to either a finite number or
// null. Empty string / undefined / null all mean "not recorded" (not
// the same as 0, which means "free"). Anything non-numeric is
// rejected rather than silently dropped, so a bad request tells you
// why instead of quietly saving NULL.
function normalizePrice(value) {
  if (value === undefined) return undefined; // caller decides whether to touch the column at all
  if (value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('pricePaid must be a number, null, or omitted');
  return n;
}

// Flags (doesn't block) a save where notes mentions a different room
// than the one on record -- the thing that let entries drift out of
// sync with reality (notes saying "moved to the coffee table",
// `room` column never touched). Only fires when notes is changing but
// room isn't in the same request, since that's specifically the gap.
function detectRoomNotesDrift(notes, room) {
  if (!notes) return null;
  const candidates = new Set(['Office', 'Living Room', 'Plant Room', 'Outside', 'Other']);
  db.prepare("SELECT DISTINCT room FROM plants WHERE deleted_at IS NULL").all().forEach((r) => candidates.add(r.room));
  const lowerNotes = notes.toLowerCase();
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.toLowerCase() === (room || '').toLowerCase()) continue;
    if (lowerNotes.includes(candidate.toLowerCase())) {
      return `Notes mention "${candidate}" but room is still "${room}" -- did you mean to update room too?`;
    }
  }
  return null;
}

function rowToPlant(row) {
  const logs = db
    .prepare('SELECT date, type, note FROM logs WHERE plant_id = ? ORDER BY id DESC')
    .all(row.id);
  const photos = db
    .prepare('SELECT id, filename FROM photos WHERE plant_id = ? ORDER BY position, id')
    .all(row.id)
    .map((p) => ({ id: p.id, url: `/photos/${p.filename}` }));
  let parentName = null;
  if (row.parent_id) {
    const parent = db.prepare('SELECT name FROM plants WHERE id = ?').get(row.parent_id);
    parentName = parent ? parent.name : null;
  }
  return {
    id: row.id,
    name: row.name,
    room: row.room,
    group: row.group_name,
    status: row.status,
    notes: row.notes,
    propagating: !!row.propagating,
    newLocation: row.new_location || '',
    pricePaid: row.price_paid,
    parentId: row.parent_id || null,
    parentName,
    pottedAt: row.potted_at || null,
    deletedAt: row.deleted_at || null,
    flagged: !!row.flagged,
    photos,
    log: logs,
  };
}

// Applies a partial update to one plant: resolves each field (existing
// value if the caller didn't send that field), auto-stamps pottedAt
// the moment propagating flips true -> false, writes one audit_log row
// per field that actually changed, and returns the updated plant (or
// null if the id doesn't exist / is in the trash). Shared by PUT and
// bulk-update so both stay consistent instead of maintaining two
// copies of this logic.
function applyPlantUpdate(id, changes, source) {
  const existing = db.prepare('SELECT * FROM plants WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!existing) return null;

  const price = normalizePrice(changes.pricePaid); // may throw -- let it propagate to the caller

  const next = {
    name: changes.name ?? existing.name,
    room: changes.room ?? existing.room,
    group_name: changes.group ?? existing.group_name,
    status: changes.status ?? existing.status,
    notes: changes.notes ?? existing.notes,
    propagating: changes.propagating !== undefined ? (changes.propagating ? 1 : 0) : existing.propagating,
    new_location: changes.newLocation !== undefined ? changes.newLocation : existing.new_location,
    price_paid: price !== undefined ? price : existing.price_paid,
    parent_id: changes.parentId !== undefined ? (changes.parentId || null) : existing.parent_id,
    flagged: changes.flagged !== undefined ? (changes.flagged ? 1 : 0) : existing.flagged,
  };

  let pottedAt = existing.potted_at;
  if (existing.propagating && !next.propagating) pottedAt = new Date().toISOString();
  if (!existing.propagating && next.propagating) pottedAt = null;

  db.prepare(`
    UPDATE plants SET name=?, room=?, group_name=?, status=?, notes=?, propagating=?, new_location=?, price_paid=?, parent_id=?, potted_at=?, flagged=?
    WHERE id=?
  `).run(
    next.name, next.room, next.group_name, next.status, next.notes,
    next.propagating, next.new_location, next.price_paid, next.parent_id, pottedAt, next.flagged,
    id
  );

  // flagged (the "gather list" toggle) is deliberately not audited or
  // undoable -- it's ephemeral task state from walking through plants
  // during a watering round, not a durable fact worth a permanent
  // history entry.
  const fieldDiffs = [
    ['name', existing.name, next.name],
    ['room', existing.room, next.room],
    ['group', existing.group_name, next.group_name],
    ['status', existing.status, next.status],
    ['notes', existing.notes, next.notes],
    ['propagating', !!existing.propagating, !!next.propagating],
    ['newLocation', existing.new_location, next.new_location],
    ['pricePaid', existing.price_paid, next.price_paid],
    ['parentId', existing.parent_id, next.parent_id],
  ];
  fieldDiffs.forEach(([field, oldV, newV]) => {
    if (String(oldV ?? '') !== String(newV ?? '')) logAudit(id, field, oldV, newV, source);
  });

  return rowToPlant(db.prepare('SELECT * FROM plants WHERE id = ?').get(id));
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/plants', (req, res) => {
  const rows = db.prepare('SELECT * FROM plants WHERE deleted_at IS NULL ORDER BY room, name').all();
  res.json(rows.map(rowToPlant));
});

app.get('/api/plants/trash', (req, res) => {
  const rows = db.prepare('SELECT * FROM plants WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC').all();
  res.json(rows.map(rowToPlant));
});

app.get('/api/plants/:id/audit', (req, res) => {
  const rows = db
    .prepare('SELECT field, old_value, new_value, source, created_at FROM audit_log WHERE plant_id = ? ORDER BY id DESC LIMIT 200')
    .all(req.params.id);
  res.json(rows.map((r) => ({ field: r.field, oldValue: r.old_value, newValue: r.new_value, source: r.source, at: r.created_at })));
});

app.post('/api/plants', (req, res) => {
  const { name, room, group, status, notes, propagating, newLocation, pricePaid, parentId } = req.body;
  if (!name || !room) return res.status(400).json({ error: 'name and room are required' });
  let price;
  try {
    price = normalizePrice(pricePaid);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const id = 'p' + crypto.randomBytes(6).toString('hex');
  db.prepare(`
    INSERT INTO plants (id, name, room, group_name, status, notes, propagating, new_location, price_paid, parent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, room, group || 'unsure', status || 'confirmed', notes || '', propagating ? 1 : 0, newLocation || '', price ?? null, parentId || null);
  logAudit(id, '(created)', null, name, getSource(req));
  res.json(rowToPlant(db.prepare('SELECT * FROM plants WHERE id = ?').get(id)));
});

app.put('/api/plants/:id', (req, res) => {
  let plant;
  try {
    plant = applyPlantUpdate(req.params.id, req.body, getSource(req));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (!plant) return res.status(404).json({ error: 'not found' });

  const warning = req.body.notes !== undefined && req.body.room === undefined
    ? detectRoomNotesDrift(req.body.notes, plant.room)
    : null;
  res.json(warning ? { ...plant, warning } : plant);
});

app.delete('/api/plants/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM plants WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const deletedAt = new Date().toISOString();
  db.prepare('UPDATE plants SET deleted_at = ? WHERE id = ?').run(deletedAt, req.params.id);
  logAudit(req.params.id, '(deleted)', null, deletedAt, getSource(req));
  res.json({ ok: true });
});

app.post('/api/plants/:id/restore', (req, res) => {
  const existing = db.prepare('SELECT * FROM plants WHERE id = ? AND deleted_at IS NOT NULL').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not in trash' });
  db.prepare('UPDATE plants SET deleted_at = NULL WHERE id = ?').run(req.params.id);
  logAudit(req.params.id, '(restored)', existing.deleted_at, null, getSource(req));
  res.json(rowToPlant(db.prepare('SELECT * FROM plants WHERE id = ?').get(req.params.id)));
});

// Permanently removes a plant that's already in the trash -- never an
// active one, so this can't be used as a shortcut around the soft
// delete above. Skips the retention window rather than waiting for it.
app.delete('/api/plants/:id/permanent', (req, res) => {
  const existing = db.prepare('SELECT * FROM plants WHERE id = ? AND deleted_at IS NOT NULL').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not in trash (soft-delete it first)' });
  purgePlantFiles(req.params.id);
  db.prepare('DELETE FROM plants WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Reverts the most recent `count` (default 1) field changes made to a
// plant via PUT/bulk-update/confirm-moves -- not deletes (use restore)
// and not photos (individually add/remove them). Each revert is
// itself written as a new audit_log row (source 'undo') rather than
// erasing history, so the log stays an honest append-only record of
// what actually happened, undo included.
const UNDOABLE_FIELDS = ['name', 'room', 'group', 'status', 'notes', 'propagating', 'newLocation', 'pricePaid', 'parentId'];
const FIELD_TO_COLUMN = {
  name: 'name', room: 'room', group: 'group_name', status: 'status', notes: 'notes',
  propagating: 'propagating', newLocation: 'new_location', pricePaid: 'price_paid', parentId: 'parent_id',
};
function coerceAuditValue(field, stored) {
  if (stored === null || stored === undefined) return null;
  if (field === 'propagating') return stored === 'true' ? 1 : 0;
  if (field === 'pricePaid') return Number(stored);
  return stored;
}

app.post('/api/plants/:id/undo', (req, res) => {
  const existing = db.prepare('SELECT * FROM plants WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const count = Math.max(1, Math.min(20, Number(req.body?.count) || 1));

  // Eligible for undo means: this field's MOST RECENT row isn't itself
  // an undo. Filtering out undo-sourced rows alone isn't enough -- the
  // original row a completed undo reverted stays in the table and,
  // without this, would get picked again on the next call instead of
  // moving on to the next field that actually still needs reverting.
  const placeholders = UNDOABLE_FIELDS.map(() => '?').join(',');
  const recent = db
    .prepare(`
      SELECT a.* FROM audit_log a
      WHERE a.plant_id = ? AND a.field IN (${placeholders}) AND a.source != 'undo'
      AND a.id = (SELECT MAX(b.id) FROM audit_log b WHERE b.plant_id = a.plant_id AND b.field = a.field)
      ORDER BY a.id DESC LIMIT ?
    `)
    .all(req.params.id, ...UNDOABLE_FIELDS, count);
  if (!recent.length) return res.status(400).json({ error: 'nothing to undo' });

  const reverted = [];
  recent.forEach((entry) => {
    const column = FIELD_TO_COLUMN[entry.field];
    const restoreValue = coerceAuditValue(entry.field, entry.old_value);
    const current = db.prepare(`SELECT ${column} AS v FROM plants WHERE id = ?`).get(req.params.id).v;
    db.prepare(`UPDATE plants SET ${column} = ? WHERE id = ?`).run(restoreValue, req.params.id);
    logAudit(req.params.id, entry.field, current, restoreValue, 'undo');
    reverted.push({ field: entry.field, revertedTo: entry.old_value });
  });

  res.json({ plant: rowToPlant(db.prepare('SELECT * FROM plants WHERE id = ?').get(req.params.id)), reverted });
});

app.post('/api/plants/:id/logs', (req, res) => {
  const plant = db.prepare('SELECT * FROM plants WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
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
app.post('/api/plants/bulk-update', (req, res) => {
  const { ids, changes } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids must be a non-empty array' });
  if (!changes || typeof changes !== 'object') return res.status(400).json({ error: 'changes object is required' });

  const source = getSource(req);
  const updated = [];
  const notFound = [];
  let badRequestError = null;
  const applyOne = db.transaction((id) => {
    let plant;
    try {
      plant = applyPlantUpdate(id, changes, source);
    } catch (err) {
      badRequestError = err.message;
      return;
    }
    if (!plant) { notFound.push(id); return; }
    updated.push(plant);
  });
  for (const id of ids) {
    applyOne(id);
    if (badRequestError) return res.status(400).json({ error: badRequestError });
  }

  const warning = changes.notes !== undefined && changes.room === undefined && updated.length
    ? detectRoomNotesDrift(changes.notes, updated[0].room)
    : null;
  res.json(warning ? { updated, notFound, warning } : { updated, notFound });
});

app.post('/api/plants/bulk-logs', (req, res) => {
  const { ids, type, note } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids must be a non-empty array' });
  if (!type) return res.status(400).json({ error: 'type is required' });
  const date = new Date().toISOString().slice(0, 10);

  const updated = [];
  const notFound = [];
  const applyOne = db.transaction((id) => {
    const existing = db.prepare('SELECT * FROM plants WHERE id = ? AND deleted_at IS NULL').get(id);
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
  const source = getSource(req);
  const candidates = Array.isArray(ids) && ids.length
    ? ids.map((id) => db.prepare('SELECT * FROM plants WHERE id = ? AND deleted_at IS NULL').get(id)).filter(Boolean)
    : db.prepare("SELECT * FROM plants WHERE deleted_at IS NULL AND new_location IS NOT NULL AND new_location != ''").all();

  const moved = [];
  const applyOne = db.transaction((plant) => {
    if (!plant.new_location) return;
    db.prepare('UPDATE plants SET room = ?, new_location = ? WHERE id = ?').run(plant.new_location, '', plant.id);
    logAudit(plant.id, 'room', plant.room, plant.new_location, source);
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
  const plant = db.prepare('SELECT * FROM plants WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
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
  logAudit(req.params.id, 'photo_added', null, filename, getSource(req));
  res.json(rowToPlant(db.prepare('SELECT * FROM plants WHERE id = ?').get(req.params.id)));
});

app.delete('/api/plants/:id/photos/:photoId', (req, res) => {
  const plant = db.prepare('SELECT * FROM plants WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!plant) return res.status(404).json({ error: 'not found' });
  const photo = db
    .prepare('SELECT * FROM photos WHERE id = ? AND plant_id = ?')
    .get(req.params.photoId, req.params.id);
  if (!photo) return res.status(404).json({ error: 'photo not found' });

  const fp = path.join(PHOTOS_DIR, photo.filename);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  db.prepare('DELETE FROM photos WHERE id = ?').run(photo.id);
  logAudit(req.params.id, 'photo_removed', photo.filename, null, getSource(req));
  res.json(rowToPlant(db.prepare('SELECT * FROM plants WHERE id = ?').get(req.params.id)));
});

// Convenience JSON export (metadata + photo URLs). The real backup is the
// /data volume itself -- see README for the recommended way to back that up.
app.get('/api/export', (req, res) => {
  const rows = db.prepare('SELECT * FROM plants WHERE deleted_at IS NULL').all().map(rowToPlant);
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
  const rows = db.prepare('SELECT * FROM plants WHERE deleted_at IS NULL ORDER BY room, name').all();
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
