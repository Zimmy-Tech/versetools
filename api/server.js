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

// ─── Admin writes: ships ─────────────────────────────────────────────

async function logAudit(client, userName, action, entityType, entityKey, fieldName, oldValue, newValue) {
  await client.query(
    'INSERT INTO audit_log (user_name, action, entity_type, entity_key, field_name, old_value, new_value) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [userName, action, entityType, entityKey, fieldName, oldValue, newValue]
  );
}

// PATCH a ship: merge the supplied fields into the existing JSON blob.
// Used by targeted editors (e.g. acceleration form) that only touch a
// few fields without needing to know the rest of the ship object.
const patchShipHandler = async (req, res) => {
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
      'SELECT data FROM ships WHERE class_name = $1 FOR UPDATE',
      [className]
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Ship not found', className });
    }
    const before = rows[0].data;
    const after = { ...before, ...patch };

    await client.query(
      "UPDATE ships SET data = $1, source = 'curated', updated_at = NOW() WHERE class_name = $2",
      [after, className]
    );

    // Log each changed field individually so the audit log is searchable
    for (const key of Object.keys(patch)) {
      if (JSON.stringify(before[key]) !== JSON.stringify(patch[key])) {
        await logAudit(
          client,
          req.admin.sub,
          'patch_ship',
          'ship',
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
    console.error('patch ship failed:', err);
    res.status(500).json({ error: 'Update failed', detail: err.message });
  } finally {
    client.release();
  }
};

app.patch('/admin/ships/:className', requireAdmin, patchShipHandler);
app.patch('/api/admin/ships/:className', requireAdmin, patchShipHandler);

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
