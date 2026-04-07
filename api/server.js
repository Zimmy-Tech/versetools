// VerseTools API Server
// Phase 2: Public read endpoints + admin auth + admin write endpoints

import express from 'express';
import cors from 'cors';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { dbEnabled, initSchema, importIfEmpty, exportFullDb, pool } from './db.js';
import { authConfigured, verifyCredentials, issueToken, requireAdmin } from './auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// CORS — allow the frontend (DO static site + GitHub Pages + localhost dev)
app.use(cors({
  origin: [
    'http://localhost:4200',
    'https://verse-tools-app-95jai.ondigitalocean.app',
    'https://zimmy-tech.github.io',
    'https://versetools.com',
  ],
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));

// Routes are registered both with and without /api prefix so the server
// works regardless of whether DigitalOcean strips the route prefix.

const healthHandler = (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '0.2.0',
    phase: 'Phase 2 — admin auth',
    db: dbEnabled,
    auth: authConfigured,
  });
};

const dbHandler = async (req, res) => {
  try {
    if (dbEnabled) {
      const data = await exportFullDb();
      res.setHeader('Content-Type', 'application/json');
      res.json(data);
    } else {
      // Fallback: serve the static JSON file
      const jsonPath = join(__dirname, 'data', 'versedb_data.json');
      const data = readFileSync(jsonPath, 'utf-8');
      res.setHeader('Content-Type', 'application/json');
      res.send(data);
    }
  } catch (err) {
    console.error('Failed to load db:', err);
    res.status(500).json({ error: 'Failed to load database', detail: err.message });
  }
};

app.get('/health', healthHandler);
app.get('/api/health', healthHandler);
app.get('/db', dbHandler);
app.get('/api/db', dbHandler);

// ─── Admin auth ──────────────────────────────────────────────────────

const loginHandler = (req, res) => {
  if (!authConfigured) {
    return res.status(503).json({ error: 'Admin auth not configured on server' });
  }
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }
  if (!verifyCredentials(username, password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = issueToken(username);
  res.json({ token, username, role: 'admin' });
};

const meHandler = (req, res) => {
  res.json({ ok: true, username: req.admin.sub, role: req.admin.role });
};

app.post('/admin/login', loginHandler);
app.post('/api/admin/login', loginHandler);
app.get('/admin/me', requireAdmin, meHandler);
app.get('/api/admin/me', requireAdmin, meHandler);

// ─── Admin writes ────────────────────────────────────────────────────

async function logAudit(client, userName, action, entityType, entityKey, fieldName, oldValue, newValue) {
  await client.query(
    'INSERT INTO audit_log (user_name, action, entity_type, entity_key, field_name, old_value, new_value) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [userName, action, entityType, entityKey, fieldName, oldValue, newValue]
  );
}

// Generic JSONB patcher used by both ship and item endpoints. Loads the
// row, merges the supplied fields into the JSON blob, marks source as
// 'curated', and writes one audit_log entry per field that actually
// changed value.
function makePatchHandler({ table, entityType }) {
  return async (req, res) => {
    if (!dbEnabled) return res.status(503).json({ error: 'Database not available' });
    const { className } = req.params;
    const patch = req.body;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return res.status(400).json({ error: 'Body must be an object of fields to update' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT data FROM ${table} WHERE class_name = $1 FOR UPDATE`,
        [className]
      );
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: `${entityType} not found`, className });
      }
      const before = rows[0].data;
      const after = { ...before, ...patch };

      await client.query(
        `UPDATE ${table} SET data = $1, source = 'curated', updated_at = NOW() WHERE class_name = $2`,
        [after, className]
      );

      for (const key of Object.keys(patch)) {
        if (JSON.stringify(before[key]) !== JSON.stringify(patch[key])) {
          await logAudit(
            client,
            req.admin.sub,
            `patch_${entityType}`,
            entityType,
            className,
            key,
            JSON.stringify(before[key] ?? null),
            JSON.stringify(patch[key] ?? null)
          );
        }
      }

      await client.query('COMMIT');
      res.json({ ok: true, className, updated: Object.keys(patch) });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`patch ${entityType} failed:`, err);
      res.status(500).json({ error: 'Update failed', detail: err.message });
    } finally {
      client.release();
    }
  };
}

const patchShipHandler = makePatchHandler({ table: 'ships', entityType: 'ship' });
const patchItemHandler = makePatchHandler({ table: 'items', entityType: 'item' });

app.patch('/admin/ships/:className', requireAdmin, patchShipHandler);
app.patch('/api/admin/ships/:className', requireAdmin, patchShipHandler);
app.patch('/admin/items/:className', requireAdmin, patchItemHandler);
app.patch('/api/admin/items/:className', requireAdmin, patchItemHandler);

// ─── Create / delete ─────────────────────────────────────────────────

// Create a new ship or item. Body must contain `className`. All other
// fields are optional and stored as the initial JSONB blob.
function makeCreateHandler({ table, entityType }) {
  return async (req, res) => {
    if (!dbEnabled) return res.status(503).json({ error: 'Database not available' });
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Body must be an object' });
    }
    const { className } = body;
    if (!className || typeof className !== 'string' || !className.trim()) {
      return res.status(400).json({ error: 'className is required' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        `SELECT 1 FROM ${table} WHERE class_name = $1`,
        [className]
      );
      if (existing.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Already exists', className });
      }

      await client.query(
        `INSERT INTO ${table} (class_name, data, source) VALUES ($1, $2, 'curated')`,
        [className, body]
      );
      await logAudit(
        client,
        req.admin.sub,
        `create_${entityType}`,
        entityType,
        className,
        null,
        null,
        JSON.stringify(body)
      );
      await client.query('COMMIT');
      res.status(201).json({ ok: true, className });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`create ${entityType} failed:`, err);
      res.status(500).json({ error: 'Create failed', detail: err.message });
    } finally {
      client.release();
    }
  };
}

// Hard-delete a ship or item. The full pre-delete JSON is recorded in
// the audit log so deletions are recoverable from there.
function makeDeleteHandler({ table, entityType }) {
  return async (req, res) => {
    if (!dbEnabled) return res.status(503).json({ error: 'Database not available' });
    const { className } = req.params;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT data FROM ${table} WHERE class_name = $1 FOR UPDATE`,
        [className]
      );
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: `${entityType} not found`, className });
      }
      const before = rows[0].data;
      await client.query(`DELETE FROM ${table} WHERE class_name = $1`, [className]);
      await logAudit(
        client,
        req.admin.sub,
        `delete_${entityType}`,
        entityType,
        className,
        null,
        JSON.stringify(before),
        null
      );
      await client.query('COMMIT');
      res.json({ ok: true, className });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`delete ${entityType} failed:`, err);
      res.status(500).json({ error: 'Delete failed', detail: err.message });
    } finally {
      client.release();
    }
  };
}

const createShipHandler = makeCreateHandler({ table: 'ships', entityType: 'ship' });
const createItemHandler = makeCreateHandler({ table: 'items', entityType: 'item' });
const deleteShipHandler = makeDeleteHandler({ table: 'ships', entityType: 'ship' });
const deleteItemHandler = makeDeleteHandler({ table: 'items', entityType: 'item' });

app.post('/admin/ships', requireAdmin, createShipHandler);
app.post('/api/admin/ships', requireAdmin, createShipHandler);
app.post('/admin/items', requireAdmin, createItemHandler);
app.post('/api/admin/items', requireAdmin, createItemHandler);
app.delete('/admin/ships/:className', requireAdmin, deleteShipHandler);
app.delete('/api/admin/ships/:className', requireAdmin, deleteShipHandler);
app.delete('/admin/items/:className', requireAdmin, deleteItemHandler);
app.delete('/api/admin/items/:className', requireAdmin, deleteItemHandler);

// ─── Diff / import review ────────────────────────────────────────────
//
// The pipeline: re-extract the game's data into versedb_data.json,
// upload it via the admin panel, and compare against the database.
// The diff endpoint returns a per-field summary; the apply endpoint
// commits only the changes the admin explicitly selected so curated
// edits aren't clobbered by extraction.

function diffEntity(uploaded, current) {
  // Returns a list of { field, oldValue, newValue } describing fields
  // that differ between the uploaded blob and the current DB blob.
  const changes = [];
  const allKeys = new Set([
    ...Object.keys(uploaded || {}),
    ...Object.keys(current || {}),
  ]);
  for (const key of allKeys) {
    const a = current ? current[key] : undefined;
    const b = uploaded ? uploaded[key] : undefined;
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      changes.push({
        field: key,
        oldValue: a === undefined ? null : a,
        newValue: b === undefined ? null : b,
      });
    }
  }
  return changes;
}

const diffPreviewHandler = async (req, res) => {
  if (!dbEnabled) return res.status(503).json({ error: 'Database not available' });
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Body must be an object containing ships and items arrays' });
  }
  const uploadedShips = Array.isArray(body.ships) ? body.ships : [];
  const uploadedItems = Array.isArray(body.items) ? body.items : [];

  try {
    const [shipRows, itemRows] = await Promise.all([
      pool.query('SELECT class_name, data, source FROM ships'),
      pool.query('SELECT class_name, data, source FROM items'),
    ]);

    const currentShips = new Map(shipRows.rows.map((r) => [r.class_name, { data: r.data, source: r.source }]));
    const currentItems = new Map(itemRows.rows.map((r) => [r.class_name, { data: r.data, source: r.source }]));

    const result = { ships: [], items: [] };

    // Pass 1: walk uploaded entities (modifies + creates)
    for (const ship of uploadedShips) {
      if (!ship || !ship.className) continue;
      const cur = currentShips.get(ship.className);
      if (!cur) {
        result.ships.push({
          className: ship.className,
          action: 'create',
          currentSource: null,
          changes: [{ field: '*', oldValue: null, newValue: ship }],
        });
      } else {
        const changes = diffEntity(ship, cur.data);
        if (changes.length > 0) {
          result.ships.push({
            className: ship.className,
            action: 'modify',
            currentSource: cur.source,
            changes,
          });
        }
      }
    }

    for (const item of uploadedItems) {
      if (!item || !item.className) continue;
      const cur = currentItems.get(item.className);
      if (!cur) {
        result.items.push({
          className: item.className,
          action: 'create',
          currentSource: null,
          changes: [{ field: '*', oldValue: null, newValue: item }],
        });
      } else {
        const changes = diffEntity(item, cur.data);
        if (changes.length > 0) {
          result.items.push({
            className: item.className,
            action: 'modify',
            currentSource: cur.source,
            changes,
          });
        }
      }
    }

    // Pass 2: entities in DB but missing from upload (potential deletes)
    const uploadedShipKeys = new Set(uploadedShips.map((s) => s?.className).filter(Boolean));
    const uploadedItemKeys = new Set(uploadedItems.map((i) => i?.className).filter(Boolean));
    for (const [className, cur] of currentShips) {
      if (!uploadedShipKeys.has(className)) {
        result.ships.push({
          className,
          action: 'delete',
          currentSource: cur.source,
          changes: [{ field: '*', oldValue: cur.data, newValue: null }],
        });
      }
    }
    for (const [className, cur] of currentItems) {
      if (!uploadedItemKeys.has(className)) {
        result.items.push({
          className,
          action: 'delete',
          currentSource: cur.source,
          changes: [{ field: '*', oldValue: cur.data, newValue: null }],
        });
      }
    }

    res.json({
      ships: result.ships,
      items: result.items,
      stats: {
        shipChanges: result.ships.length,
        itemChanges: result.items.length,
      },
    });
  } catch (err) {
    console.error('diff preview failed:', err);
    res.status(500).json({ error: 'Diff failed', detail: err.message });
  }
};

// Apply selected changes from a diff. Body shape:
//   {
//     ships: [{ className, action, fields: ['scmSpeed', ...] | '*' }],
//     items: [...]
//   }
// For 'modify': only the listed fields are merged in (or '*' for full).
// For 'create': inserts the full provided data.
// For 'delete': deletes the row.
const diffApplyHandler = async (req, res) => {
  if (!dbEnabled) return res.status(503).json({ error: 'Database not available' });
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Body must be an object' });
  }
  const ships = Array.isArray(body.ships) ? body.ships : [];
  const items = Array.isArray(body.items) ? body.items : [];

  const client = await pool.connect();
  let applied = { ships: 0, items: 0 };
  try {
    await client.query('BEGIN');

    for (const change of ships) {
      await applyEntityChange(client, 'ships', 'ship', change, req.admin.sub);
      applied.ships++;
    }
    for (const change of items) {
      await applyEntityChange(client, 'items', 'item', change, req.admin.sub);
      applied.items++;
    }

    await client.query('COMMIT');
    res.json({ ok: true, applied });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('diff apply failed:', err);
    res.status(500).json({ error: 'Apply failed', detail: err.message });
  } finally {
    client.release();
  }
};

async function applyEntityChange(client, table, entityType, change, userName) {
  const { className, action, fields, data } = change;
  if (!className || !action) {
    throw new Error('change requires className and action');
  }

  if (action === 'create') {
    if (!data) throw new Error(`create ${entityType} requires data`);
    await client.query(
      `INSERT INTO ${table} (class_name, data, source) VALUES ($1, $2, 'extracted') ON CONFLICT (class_name) DO NOTHING`,
      [className, data]
    );
    await logAudit(client, userName, `import_create_${entityType}`, entityType, className, null, null, JSON.stringify(data));
    return;
  }

  if (action === 'delete') {
    const { rows } = await client.query(`SELECT data FROM ${table} WHERE class_name = $1`, [className]);
    if (rows.length === 0) return;
    await client.query(`DELETE FROM ${table} WHERE class_name = $1`, [className]);
    await logAudit(client, userName, `import_delete_${entityType}`, entityType, className, null, JSON.stringify(rows[0].data), null);
    return;
  }

  if (action === 'modify') {
    if (!data) throw new Error(`modify ${entityType} requires data`);
    const { rows } = await client.query(
      `SELECT data FROM ${table} WHERE class_name = $1 FOR UPDATE`,
      [className]
    );
    if (rows.length === 0) {
      throw new Error(`${entityType} ${className} not found`);
    }
    const before = rows[0].data;
    let after;
    if (fields === '*' || !Array.isArray(fields)) {
      after = data;
    } else {
      after = { ...before };
      for (const f of fields) after[f] = data[f];
    }
    await client.query(
      `UPDATE ${table} SET data = $1, updated_at = NOW() WHERE class_name = $2`,
      [after, className]
    );
    await logAudit(
      client,
      userName,
      `import_modify_${entityType}`,
      entityType,
      className,
      Array.isArray(fields) ? fields.join(',') : '*',
      JSON.stringify(before),
      JSON.stringify(after)
    );
    return;
  }

  throw new Error(`unknown action: ${action}`);
}

app.post('/admin/diff/preview', requireAdmin, diffPreviewHandler);
app.post('/api/admin/diff/preview', requireAdmin, diffPreviewHandler);
app.post('/admin/diff/apply', requireAdmin, diffApplyHandler);
app.post('/api/admin/diff/apply', requireAdmin, diffApplyHandler);

// ─── Audit log read ──────────────────────────────────────────────────

const auditHandler = async (req, res) => {
  if (!dbEnabled) return res.status(503).json({ error: 'Database not available' });
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const { rows } = await pool.query(
    'SELECT id, user_name, action, entity_type, entity_key, field_name, old_value, new_value, created_at FROM audit_log ORDER BY id DESC LIMIT $1',
    [limit]
  );
  res.json({ entries: rows });
};

app.get('/admin/audit', requireAdmin, auditHandler);
app.get('/api/admin/audit', requireAdmin, auditHandler);

// Root — useful for sanity checking
app.get('/', (req, res) => {
  res.json({
    service: 'versetools-api',
    see: ['/api/health', '/api/db', '/api/admin/login', '/api/admin/me'],
  });
});

async function start() {
  if (dbEnabled) {
    try {
      await initSchema();
      await importIfEmpty();
    } catch (err) {
      console.error('[db] init failed:', err);
      // Don't crash — fall back to file proxy so the site stays up
    }
  } else {
    console.log('[db] DATABASE_URL not set — running in file-proxy mode');
  }

  app.listen(PORT, () => {
    console.log(`VerseTools API listening on port ${PORT}`);
    console.log(`Health: http://localhost:${PORT}/health (external: /api/health)`);
    console.log(`DB:     http://localhost:${PORT}/db     (external: /api/db)`);
  });
}

start();
