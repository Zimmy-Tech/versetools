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
