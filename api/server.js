// VerseTools API Server
// Phase 2: Public read endpoints + admin auth + admin write endpoints

// Load .env BEFORE importing db.js / auth.js, since those modules read
// process.env at module-load time. Production sets these via DigitalOcean
// App Platform env vars and has no .env file; the dotenv call is a no-op
// there.
import 'dotenv/config';

import express from 'express';
import cors from 'cors';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { dbEnabled, ensureReady, exportFullDb, pool, normalizeMode, syncPtuFromLive, getConfig, setSetting, recordChangelogEntry, getChangelogHistory, refreshUexShopPrices } from './db.js';
import { authConfigured, totpConfigured, verifyCredentials, verifyTotp, generateTotpSetup, issueToken, requireAdmin, checkRateLimit, recordFailedAttempt, clearRateLimit } from './auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy headers (DigitalOcean load balancer sets X-Forwarded-For)
app.set('trust proxy', 1);

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
      const mode = normalizeMode(req.query.mode);
      const data = await exportFullDb(mode);
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

  // Rate limit check
  const ip = req.ip || 'unknown';
  const rl = checkRateLimit(ip);
  if (!rl.allowed) {
    return res.status(429).json({
      error: `Too many login attempts. Try again in ${rl.retryAfterSec} seconds.`,
      retryAfterSec: rl.retryAfterSec,
    });
  }

  const { username, password, totp } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }
  if (!verifyCredentials(username, password)) {
    recordFailedAttempt(ip);
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  if (!verifyTotp(totp)) {
    recordFailedAttempt(ip);
    return res.status(401).json({ error: 'Invalid or missing 2FA code', totpRequired: true });
  }

  clearRateLimit(ip);
  const token = issueToken(username);
  res.json({ token, username, role: 'admin', totpEnabled: totpConfigured });
};

// TOTP setup — generates a secret and provisioning URI for scanning with
// an authenticator app. Only works when TOTP is not yet configured.
const totpSetupHandler = (req, res) => {
  if (totpConfigured) {
    return res.status(400).json({ error: 'TOTP is already configured. To reconfigure, remove TOTP_SECRET env var and restart.' });
  }
  const setup = generateTotpSetup();
  res.json({
    secret: setup.secret,
    uri: setup.uri,
    instructions: 'Scan the URI as a QR code in your authenticator app, then set TOTP_SECRET=' + setup.secret + ' in your server environment variables and restart.',
  });
};

const meHandler = (req, res) => {
  res.json({ ok: true, username: req.admin.sub, role: req.admin.role, totpEnabled: totpConfigured });
};

app.post('/admin/login', loginHandler);
app.post('/api/admin/login', loginHandler);
app.get('/admin/totp/setup', requireAdmin, totpSetupHandler);
app.get('/api/admin/totp/setup', requireAdmin, totpSetupHandler);
app.get('/admin/me', requireAdmin, meHandler);
app.get('/api/admin/me', requireAdmin, meHandler);

// ─── Admin writes ────────────────────────────────────────────────────

async function logAudit(client, userName, action, entityType, entityKey, entityMode, fieldName, oldValue, newValue) {
  await client.query(
    'INSERT INTO audit_log (user_name, action, entity_type, entity_key, entity_mode, field_name, old_value, new_value) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [userName, action, entityType, entityKey, entityMode, fieldName, oldValue, newValue]
  );
}

// Generic JSONB patcher used by both ship and item endpoints. Loads the
// row, merges the supplied fields into the JSON blob, marks source as
// 'curated', and writes one audit_log entry per field that actually
// changed value. Operates on the live or ptu copy based on the ?mode
// query param (default live).
function makePatchHandler({ table, entityType }) {
  return async (req, res) => {
    if (!dbEnabled) return res.status(503).json({ error: 'Database not available' });
    const { className } = req.params;
    const mode = normalizeMode(req.query.mode);
    const patch = req.body;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return res.status(400).json({ error: 'Body must be an object of fields to update' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT data FROM ${table} WHERE class_name = $1 AND mode = $2 FOR UPDATE`,
        [className, mode]
      );
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: `${entityType} not found`, className, mode });
      }
      const before = rows[0].data;
      const after = { ...before, ...patch };

      await client.query(
        `UPDATE ${table} SET data = $1, source = 'curated', updated_at = NOW() WHERE class_name = $2 AND mode = $3`,
        [after, className, mode]
      );

      for (const key of Object.keys(patch)) {
        if (JSON.stringify(before[key]) !== JSON.stringify(patch[key])) {
          await logAudit(
            client,
            req.admin.sub,
            `patch_${entityType}`,
            entityType,
            className,
            mode,
            key,
            JSON.stringify(before[key] ?? null),
            JSON.stringify(patch[key] ?? null)
          );
        }
      }

      await client.query('COMMIT');
      res.json({ ok: true, className, mode, updated: Object.keys(patch) });
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

// Create a new ship or item in the chosen mode. Body must contain
// `className`. All other fields are optional and stored as the initial
// JSONB blob. Mode comes from the ?mode query param (default live).
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
    const mode = normalizeMode(req.query.mode);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        `SELECT 1 FROM ${table} WHERE class_name = $1 AND mode = $2`,
        [className, mode]
      );
      if (existing.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Already exists', className, mode });
      }

      await client.query(
        `INSERT INTO ${table} (class_name, mode, data, source) VALUES ($1, $2, $3, 'curated')`,
        [className, mode, body]
      );
      await logAudit(
        client,
        req.admin.sub,
        `create_${entityType}`,
        entityType,
        className,
        mode,
        null,
        null,
        JSON.stringify(body)
      );
      await client.query('COMMIT');
      res.status(201).json({ ok: true, className, mode });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`create ${entityType} failed:`, err);
      res.status(500).json({ error: 'Create failed', detail: err.message });
    } finally {
      client.release();
    }
  };
}

// Hard-delete a ship or item from the chosen mode. The full pre-delete
// JSON is recorded in the audit log so deletions are recoverable.
function makeDeleteHandler({ table, entityType }) {
  return async (req, res) => {
    if (!dbEnabled) return res.status(503).json({ error: 'Database not available' });
    const { className } = req.params;
    const mode = normalizeMode(req.query.mode);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT data FROM ${table} WHERE class_name = $1 AND mode = $2 FOR UPDATE`,
        [className, mode]
      );
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: `${entityType} not found`, className, mode });
      }
      const before = rows[0].data;
      await client.query(`DELETE FROM ${table} WHERE class_name = $1 AND mode = $2`, [className, mode]);
      await logAudit(
        client,
        req.admin.sub,
        `delete_${entityType}`,
        entityType,
        className,
        mode,
        null,
        JSON.stringify(before),
        null
      );
      await client.query('COMMIT');
      res.json({ ok: true, className, mode });
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

// Flip an entity's source flag to 'curated' without changing data.
// Used when an entity has manually-corrected values (e.g., scatterguns
// with hand-fixed DPS) that should be protected from re-extraction
// overwrites in the diff/import flow.
function makeCurateHandler({ table, entityType }) {
  return async (req, res) => {
    if (!dbEnabled) return res.status(503).json({ error: 'Database not available' });
    const { className } = req.params;
    const mode = normalizeMode(req.query.mode);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT source FROM ${table} WHERE class_name = $1 AND mode = $2 FOR UPDATE`,
        [className, mode]
      );
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: `${entityType} not found`, className, mode });
      }
      const before = rows[0].source;
      if (before !== 'curated') {
        await client.query(
          `UPDATE ${table} SET source = 'curated', updated_at = NOW() WHERE class_name = $1 AND mode = $2`,
          [className, mode]
        );
        await logAudit(
          client,
          req.admin.sub,
          `mark_curated_${entityType}`,
          entityType,
          className,
          mode,
          'source',
          before,
          'curated'
        );
      }
      await client.query('COMMIT');
      res.json({ ok: true, className, mode, source: 'curated', alreadyCurated: before === 'curated' });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`curate ${entityType} failed:`, err);
      res.status(500).json({ error: 'Curate failed', detail: err.message });
    } finally {
      client.release();
    }
  };
}

const curateShipHandler = makeCurateHandler({ table: 'ships', entityType: 'ship' });
const curateItemHandler = makeCurateHandler({ table: 'items', entityType: 'item' });

app.post('/admin/ships/:className/curate', requireAdmin, curateShipHandler);
app.post('/api/admin/ships/:className/curate', requireAdmin, curateShipHandler);
app.post('/admin/items/:className/curate', requireAdmin, curateItemHandler);
app.post('/api/admin/items/:className/curate', requireAdmin, curateItemHandler);

app.post('/admin/ships', requireAdmin, createShipHandler);
app.post('/api/admin/ships', requireAdmin, createShipHandler);
app.post('/admin/items', requireAdmin, createItemHandler);
app.post('/api/admin/items', requireAdmin, createItemHandler);
app.delete('/admin/ships/:className', requireAdmin, deleteShipHandler);
app.delete('/api/admin/ships/:className', requireAdmin, deleteShipHandler);
app.delete('/admin/items/:className', requireAdmin, deleteItemHandler);
app.delete('/api/admin/items/:className', requireAdmin, deleteItemHandler);

// ─── Shop prices: UEX refresh ─────────────────────────────────────────
//
// Replaces all source='uex' rows in versedb.shop_prices with a fresh
// pull from UEX Corp's API. Manual entries (source='manual') are
// untouched. Records a price_refresh entry in the build changelog and
// an audit_log entry. Synchronous: blocks until complete (typically
// 5-15 seconds depending on UEX response time).
const refreshShopPricesHandler = async (req, res) => {
  if (!dbEnabled) return res.status(503).json({ error: 'Database not available' });
  try {
    const summary = await refreshUexShopPrices({ actor: req.user?.username || 'unknown' });
    res.json({ ok: true, summary });
  } catch (err) {
    console.error('[shop-prices/refresh] failed:', err);
    res.status(500).json({ error: err.message || 'Refresh failed' });
  }
};
app.post('/admin/shop-prices/refresh', requireAdmin, refreshShopPricesHandler);
app.post('/api/admin/shop-prices/refresh', requireAdmin, refreshShopPricesHandler);

// ─── Diff / import review ────────────────────────────────────────────
//
// The pipeline: re-extract the game's data into versedb_data.json,
// upload it via the admin panel, and compare against the database.
// The diff endpoint returns a per-field summary; the apply endpoint
// commits only the changes the admin explicitly selected so curated
// edits aren't clobbered by extraction.

// Order-insensitive deep equals: object keys are compared as sets (key
// order doesn't matter), arrays are compared positionally (element order
// matters). Used by diffEntity below to avoid flagging cosmetic JSON
// key-order differences as field modifications, which previously
// generated dozens of false-positive review entries during admin import
// (the extractor and Postgres JSONB don't preserve key insertion order
// across writes, so the same data round-trips through different orderings).
function deepEqualUnordered(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqualUnordered(a[i], b[i])) return false;
    }
    return true;
  }
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqualUnordered(a[k], b[k])) return false;
  }
  return true;
}

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
    if (!deepEqualUnordered(a, b)) {
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
  const mode = normalizeMode(req.query.mode);

  try {
    const [shipRows, itemRows] = await Promise.all([
      pool.query('SELECT class_name, data, source FROM ships WHERE mode = $1', [mode]),
      pool.query('SELECT class_name, data, source FROM items WHERE mode = $1', [mode]),
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
      mode,
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
  const meta = body.meta && typeof body.meta === 'object' ? body.meta : null;
  // Full uploaded arrays — used by the changelog recorder so the
  // changelog reflects the entire build, not just the user's selection.
  const fullShips = Array.isArray(body.fullShips) ? body.fullShips : null;
  const fullItems = Array.isArray(body.fullItems) ? body.fullItems : null;
  const mode = normalizeMode(req.query.mode);

  const client = await pool.connect();
  let applied = { ships: 0, items: 0, meta: false, changelog: null };
  try {
    await client.query('BEGIN');

    for (const change of ships) {
      await applyEntityChange(client, 'ships', 'ship', change, req.admin.sub, mode);
      applied.ships++;
    }
    for (const change of items) {
      await applyEntityChange(client, 'items', 'item', change, req.admin.sub, mode);
      applied.items++;
    }

    // Always overwrite meta when an upload includes it. Meta is pure
    // extraction metadata (game version, counts, timestamp) — there is
    // nothing to curate, so no per-field review is needed. This is what
    // makes the version string in the public header advance after an
    // import.
    if (meta) {
      const oldRes = await client.query('SELECT data FROM meta WHERE id = 1');
      const before = oldRes.rows[0]?.data ?? null;
      await client.query(
        `INSERT INTO meta (id, data, updated_at) VALUES (1, $1, NOW())
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
        [meta]
      );
      await logAudit(
        client,
        req.admin.sub,
        'import_meta',
        'meta',
        'meta',
        null,
        null,
        before ? JSON.stringify(before) : null,
        JSON.stringify(meta)
      );
      applied.meta = true;
    }

    await client.query('COMMIT');

    // Record a changelog entry AFTER the apply transaction commits.
    // Done outside the transaction so a changelog failure can never
    // roll back a successful apply. Idempotent / de-duped on duplicate
    // builds.
    if (fullShips && fullItems && meta?.version) {
      try {
        const result = await recordChangelogEntry({
          toVersion: meta.version,
          toChannel: mode,
          ships: fullShips,
          items: fullItems,
        });
        applied.changelog = result;
      } catch (clErr) {
        console.error('changelog record failed (apply still succeeded):', clErr);
        applied.changelog = { error: clErr.message };
      }
    }

    res.json({ ok: true, mode, applied });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('diff apply failed:', err);
    res.status(500).json({ error: 'Apply failed', detail: err.message });
  } finally {
    client.release();
  }
};

async function applyEntityChange(client, table, entityType, change, userName, mode) {
  const { className, action, fields, data } = change;
  if (!className || !action) {
    throw new Error('change requires className and action');
  }

  if (action === 'create') {
    if (!data) throw new Error(`create ${entityType} requires data`);
    await client.query(
      `INSERT INTO ${table} (class_name, mode, data, source) VALUES ($1, $2, $3, 'extracted') ON CONFLICT (class_name, mode) DO NOTHING`,
      [className, mode, data]
    );
    await logAudit(client, userName, `import_create_${entityType}`, entityType, className, mode, null, null, JSON.stringify(data));
    return;
  }

  if (action === 'delete') {
    const { rows } = await client.query(`SELECT data FROM ${table} WHERE class_name = $1 AND mode = $2`, [className, mode]);
    if (rows.length === 0) return;
    await client.query(`DELETE FROM ${table} WHERE class_name = $1 AND mode = $2`, [className, mode]);
    await logAudit(client, userName, `import_delete_${entityType}`, entityType, className, mode, null, JSON.stringify(rows[0].data), null);
    return;
  }

  if (action === 'modify') {
    if (!data) throw new Error(`modify ${entityType} requires data`);
    const { rows } = await client.query(
      `SELECT data FROM ${table} WHERE class_name = $1 AND mode = $2 FOR UPDATE`,
      [className, mode]
    );
    if (rows.length === 0) {
      throw new Error(`${entityType} ${className} not found in ${mode}`);
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
      `UPDATE ${table} SET data = $1, updated_at = NOW() WHERE class_name = $2 AND mode = $3`,
      [after, className, mode]
    );
    await logAudit(
      client,
      userName,
      `import_modify_${entityType}`,
      entityType,
      className,
      mode,
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
    'SELECT id, user_name, action, entity_type, entity_key, entity_mode, field_name, old_value, new_value, created_at FROM audit_log ORDER BY id DESC LIMIT $1',
    [limit]
  );
  res.json({ entries: rows });
};

app.get('/admin/audit', requireAdmin, auditHandler);
app.get('/api/admin/audit', requireAdmin, auditHandler);

// ─── PTU sync (replace PTU with current LIVE) ────────────────────────

const syncPtuHandler = async (req, res) => {
  if (!dbEnabled) return res.status(503).json({ error: 'Database not available' });
  try {
    const result = await syncPtuFromLive(req.admin.sub);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('sync ptu failed:', err);
    res.status(500).json({ error: 'Sync failed', detail: err.message });
  }
};

app.post('/admin/sync-ptu', requireAdmin, syncPtuHandler);
app.post('/api/admin/sync-ptu', requireAdmin, syncPtuHandler);

// ─── Changelog (live vs ptu diff, public) ────────────────────────────
//
// Returns the same shape as the diff preview, but built by comparing
// the LIVE rows to the PTU rows directly. Public endpoint so anyone
// can see "what's coming in PTU" without admin auth.

const changelogHandler = async (req, res) => {
  if (!dbEnabled) return res.status(503).json({ error: 'Database not available' });
  try {
    const [liveShips, ptuShips, liveItems, ptuItems] = await Promise.all([
      pool.query(`SELECT class_name, data FROM ships WHERE mode = 'live'`),
      pool.query(`SELECT class_name, data FROM ships WHERE mode = 'ptu'`),
      pool.query(`SELECT class_name, data FROM items WHERE mode = 'live'`),
      pool.query(`SELECT class_name, data FROM items WHERE mode = 'ptu'`),
    ]);
    const liveShipMap = new Map(liveShips.rows.map((r) => [r.class_name, r.data]));
    const ptuShipMap = new Map(ptuShips.rows.map((r) => [r.class_name, r.data]));
    const liveItemMap = new Map(liveItems.rows.map((r) => [r.class_name, r.data]));
    const ptuItemMap = new Map(ptuItems.rows.map((r) => [r.class_name, r.data]));

    const result = { ships: [], items: [] };

    for (const [cls, ptuData] of ptuShipMap) {
      const liveData = liveShipMap.get(cls);
      if (!liveData) {
        result.ships.push({ className: cls, action: 'create', changes: [] });
      } else {
        const changes = diffEntity(ptuData, liveData);
        if (changes.length > 0) {
          result.ships.push({ className: cls, action: 'modify', changes });
        }
      }
    }
    for (const [cls] of liveShipMap) {
      if (!ptuShipMap.has(cls)) {
        result.ships.push({ className: cls, action: 'delete', changes: [] });
      }
    }

    for (const [cls, ptuData] of ptuItemMap) {
      const liveData = liveItemMap.get(cls);
      if (!liveData) {
        result.items.push({ className: cls, action: 'create', changes: [] });
      } else {
        const changes = diffEntity(ptuData, liveData);
        if (changes.length > 0) {
          result.items.push({ className: cls, action: 'modify', changes });
        }
      }
    }
    for (const [cls] of liveItemMap) {
      if (!ptuItemMap.has(cls)) {
        result.items.push({ className: cls, action: 'delete', changes: [] });
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
    console.error('changelog failed:', err);
    res.status(500).json({ error: 'Changelog failed', detail: err.message });
  }
};

app.get('/changelog', changelogHandler);
app.get('/api/changelog', changelogHandler);

// ─── Build-import changelog history (public) ─────────────────────────

const changelogHistoryHandler = async (req, res) => {
  if (!dbEnabled) return res.json({ entries: [] });
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 6, 12);
    const rows = await getChangelogHistory(limit);
    // Re-shape into the same format the existing /changelog UI uses
    const changelog = rows.map((r) => ({
      fromVersion: r.from_version,
      fromChannel: r.from_channel,
      toVersion: r.to_version,
      toChannel: r.to_channel,
      date: r.imported_at,
      changes: [
        ...(r.ship_changes || []),
        ...(r.item_changes || []),
      ],
      added: [
        ...(r.ship_added || []),
        ...(r.item_added || []),
      ],
      removed: [
        ...(r.ship_removed || []),
        ...(r.item_removed || []),
      ],
    }));
    res.json({
      meta: {
        generatedAt: rows[0]?.imported_at ?? null,
        entries: rows.length,
      },
      changelog,
    });
  } catch (err) {
    console.error('changelog history failed:', err);
    res.status(500).json({ error: 'Failed to load changelog history' });
  }
};

app.get('/changelog/history', changelogHistoryHandler);
app.get('/api/changelog/history', changelogHistoryHandler);

// ─── Admin: clear changelog entries ────────────────────────────────────
// DELETE /api/admin/changelog/clear — wipes all changelog_entries rows
app.delete('/admin/changelog/clear', requireAdmin, async (req, res) => {
  try {
    const { pool } = await import('./db.js');
    await pool.query('DELETE FROM changelog_entries');
    res.json({ ok: true, message: 'All changelog entries cleared' });
  } catch (err) {
    console.error('changelog clear failed:', err);
    res.status(500).json({ error: err.message });
  }
});
app.delete('/api/admin/changelog/clear', requireAdmin, async (req, res) => {
  try {
    const { pool } = await import('./db.js');
    await pool.query('DELETE FROM changelog_entries');
    res.json({ ok: true, message: 'All changelog entries cleared' });
  } catch (err) {
    console.error('changelog clear failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Community submissions ──────────────────────────────────────────
//
// Public submission flow for community-tested ship acceleration data.
// The form is unauthenticated; submissions land in the queue and an
// admin reviews/approves/rejects from /admin/submissions. Approval
// applies the values to the ship's LIVE row and marks them curated.

const ACCEL_FIELDS = [
  'accelFwd', 'accelAbFwd',
  'accelRetro', 'accelAbRetro',
  'accelStrafe', 'accelAbStrafe',
  'accelUp', 'accelAbUp',
  'accelDown', 'accelAbDown',
];

const submitAccelHandler = async (req, res) => {
  if (!dbEnabled) return res.status(503).json({ error: 'Database not available' });
  const body = req.body || {};
  const shipClassName = String(body.shipClassName || '').trim();
  const submitterName = String(body.submitterName || '').trim();
  if (!shipClassName) return res.status(400).json({ error: 'shipClassName is required' });
  if (!submitterName) return res.status(400).json({ error: 'submitterName is required' });

  const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  try {
    const { rows } = await pool.query(
      `INSERT INTO accel_submissions
       (ship_class_name, ship_name, submitter_name,
        accel_fwd, accel_ab_fwd, accel_retro, accel_ab_retro,
        accel_strafe, accel_ab_strafe, accel_up, accel_ab_up,
        accel_down, accel_ab_down, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id, submitted_at`,
      [
        shipClassName,
        body.shipName || null,
        submitterName,
        num(body.accelFwd),
        num(body.accelAbFwd),
        num(body.accelRetro),
        num(body.accelAbRetro),
        num(body.accelStrafe),
        num(body.accelAbStrafe),
        num(body.accelUp),
        num(body.accelAbUp),
        num(body.accelDown),
        num(body.accelAbDown),
        body.notes ? String(body.notes).trim() : null,
      ]
    );
    res.status(201).json({ ok: true, id: rows[0].id, submittedAt: rows[0].submitted_at });
  } catch (err) {
    console.error('submit accel failed:', err);
    res.status(500).json({ error: 'Submission failed', detail: err.message });
  }
};

app.post('/submissions/accel', submitAccelHandler);
app.post('/api/submissions/accel', submitAccelHandler);

const submitFeedbackHandler = async (req, res) => {
  if (!dbEnabled) return res.status(503).json({ error: 'Database not available' });
  const body = req.body || {};
  const text = String(body.feedbackText || '').trim();
  if (!text) return res.status(400).json({ error: 'feedbackText is required' });
  try {
    await pool.query(
      `INSERT INTO feedback_submissions (feedback_type, feedback_text, submitter_name, submitter_email)
       VALUES ($1, $2, $3, $4)`,
      [
        body.feedbackType || null,
        text,
        body.feedbackName ? String(body.feedbackName).trim() : null,
        body.feedbackEmail ? String(body.feedbackEmail).trim() : null,
      ]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('submit feedback failed:', err);
    res.status(500).json({ error: 'Submission failed', detail: err.message });
  }
};

app.post('/submissions/feedback', submitFeedbackHandler);
app.post('/api/submissions/feedback', submitFeedbackHandler);

// Admin: list submissions (default: pending only, query param ?status=all|pending|approved|rejected)
const listAccelSubmissionsHandler = async (req, res) => {
  if (!dbEnabled) return res.status(503).json({ error: 'Database not available' });
  const status = String(req.query.status || 'pending').toLowerCase();
  const where = status === 'all' ? '' : 'WHERE status = $1';
  const params = status === 'all' ? [] : [status];
  try {
    const { rows } = await pool.query(
      `SELECT * FROM accel_submissions ${where} ORDER BY submitted_at DESC LIMIT 200`,
      params
    );
    res.json({ entries: rows });
  } catch (err) {
    console.error('list submissions failed:', err);
    res.status(500).json({ error: 'List failed', detail: err.message });
  }
};

app.get('/admin/submissions/accel', requireAdmin, listAccelSubmissionsHandler);
app.get('/api/admin/submissions/accel', requireAdmin, listAccelSubmissionsHandler);

// Admin: pending submission count (cheap call for sidebar badge)
const submissionCountHandler = async (req, res) => {
  if (!dbEnabled) return res.json({ pending: 0 });
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS pending FROM accel_submissions WHERE status = 'pending'`
    );
    res.json({ pending: rows[0].pending });
  } catch (err) {
    res.json({ pending: 0 });
  }
};

app.get('/admin/submissions/count', requireAdmin, submissionCountHandler);
app.get('/api/admin/submissions/count', requireAdmin, submissionCountHandler);

// Admin: approve submission. Body { mode: 'live'|'ptu' (default live) }.
// Applies the submission's accel values to the ship in the chosen mode,
// marks the ship as curated, marks the submission approved, and audits.
const approveAccelHandler = async (req, res) => {
  if (!dbEnabled) return res.status(503).json({ error: 'Database not available' });
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  const mode = normalizeMode((req.body && req.body.mode) || 'live');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const subRes = await client.query(
      `SELECT * FROM accel_submissions WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (subRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'submission not found' });
    }
    const sub = subRes.rows[0];
    if (sub.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `submission already ${sub.status}` });
    }

    // Build the patch from the submission's accel fields
    // Postgres NUMERIC columns arrive as strings in node-pg — coerce to numbers.
    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
    const patch = {
      accelFwd: num(sub.accel_fwd),
      accelAbFwd: num(sub.accel_ab_fwd),
      accelRetro: num(sub.accel_retro),
      accelAbRetro: num(sub.accel_ab_retro),
      accelStrafe: num(sub.accel_strafe),
      accelAbStrafe: num(sub.accel_ab_strafe),
      accelUp: num(sub.accel_up),
      accelAbUp: num(sub.accel_ab_up),
      accelDown: num(sub.accel_down),
      accelAbDown: num(sub.accel_ab_down),
      accelTestedDate: (sub.submitted_at instanceof Date ? sub.submitted_at : new Date(sub.submitted_at))
        .toISOString().slice(0, 10),
      accelCheckedBy: sub.submitter_name,
    };
    // Drop null/empty entries so we don't overwrite existing values with nulls
    for (const k of Object.keys(patch)) {
      if (patch[k] === null || patch[k] === undefined) delete patch[k];
    }

    // Find and update the ship
    const shipRes = await client.query(
      `SELECT data FROM ships WHERE class_name = $1 AND mode = $2 FOR UPDATE`,
      [sub.ship_class_name, mode]
    );
    if (shipRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'ship not found in target mode', shipClassName: sub.ship_class_name, mode });
    }
    const before = shipRes.rows[0].data;
    const after = { ...before, ...patch };
    await client.query(
      `UPDATE ships SET data = $1, source = 'curated', updated_at = NOW() WHERE class_name = $2 AND mode = $3`,
      [after, sub.ship_class_name, mode]
    );

    // Audit each changed field
    for (const key of Object.keys(patch)) {
      if (JSON.stringify(before[key]) !== JSON.stringify(patch[key])) {
        await logAudit(
          client,
          req.admin.sub,
          'approve_accel_submission',
          'ship',
          sub.ship_class_name,
          mode,
          key,
          JSON.stringify(before[key] ?? null),
          JSON.stringify(patch[key])
        );
      }
    }

    // Mark the submission approved
    await client.query(
      `UPDATE accel_submissions SET status = 'approved', reviewed_by = $1, reviewed_at = NOW() WHERE id = $2`,
      [req.admin.sub, id]
    );

    await client.query('COMMIT');
    res.json({ ok: true, id, shipClassName: sub.ship_class_name, mode });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('approve accel failed:', err);
    res.status(500).json({ error: 'Approve failed', detail: err.message });
  } finally {
    client.release();
  }
};

app.post('/admin/submissions/accel/:id/approve', requireAdmin, approveAccelHandler);
app.post('/api/admin/submissions/accel/:id/approve', requireAdmin, approveAccelHandler);

// Admin: reject submission. Body { note: '...' }
const rejectAccelHandler = async (req, res) => {
  if (!dbEnabled) return res.status(503).json({ error: 'Database not available' });
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  const note = req.body && typeof req.body.note === 'string' ? req.body.note.trim() : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const subRes = await client.query(
      `SELECT id, status, ship_class_name FROM accel_submissions WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (subRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'submission not found' });
    }
    if (subRes.rows[0].status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `submission already ${subRes.rows[0].status}` });
    }
    await client.query(
      `UPDATE accel_submissions SET status = 'rejected', reviewer_note = $1, reviewed_by = $2, reviewed_at = NOW() WHERE id = $3`,
      [note, req.admin.sub, id]
    );
    await logAudit(
      client,
      req.admin.sub,
      'reject_accel_submission',
      'ship',
      subRes.rows[0].ship_class_name,
      null,
      'submission_id',
      String(id),
      note ? `rejected: ${note}` : 'rejected'
    );
    await client.query('COMMIT');
    res.json({ ok: true, id });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('reject accel failed:', err);
    res.status(500).json({ error: 'Reject failed', detail: err.message });
  } finally {
    client.release();
  }
};

app.post('/admin/submissions/accel/:id/reject', requireAdmin, rejectAccelHandler);
app.post('/api/admin/submissions/accel/:id/reject', requireAdmin, rejectAccelHandler);

// ─── Cooling observations (admin-only) ───────────────────────────────

const listCoolingObsHandler = async (req, res) => {
  if (!dbEnabled) return res.json({ observations: [] });
  try {
    const status = req.query.status || 'all';
    const where = status === 'all' ? '' : `WHERE status = $1`;
    const params = status === 'all' ? [] : [status];
    const { rows } = await pool.query(
      `SELECT * FROM versedb.cooling_observations ${where} ORDER BY submitted_at DESC LIMIT 200`,
      params
    );
    res.json({ observations: rows });
  } catch (err) {
    console.error('list cooling obs failed:', err);
    res.status(500).json({ error: 'List failed', detail: err.message });
  }
};

app.get('/admin/cooling-observations', requireAdmin, listCoolingObsHandler);
app.get('/api/admin/cooling-observations', requireAdmin, listCoolingObsHandler);

const createCoolingObsHandler = async (req, res) => {
  if (!dbEnabled) return res.status(503).json({ error: 'Database not available' });
  const { shipClassName, shipName, buildVersion, pipAllocation, reportedCoolingPct,
          predictedCoolingPct, reportedIrValue, loadoutNote, notes } = req.body || {};
  if (!shipClassName || !buildVersion || reportedCoolingPct == null) {
    return res.status(400).json({ error: 'shipClassName, buildVersion, and reportedCoolingPct are required' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO versedb.cooling_observations
       (ship_class_name, ship_name, build_version, pip_allocation,
        reported_cooling_pct, predicted_cooling_pct, reported_ir_value, loadout_note, notes, submitter)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'admin')
       RETURNING id`,
      [shipClassName, shipName || null, buildVersion,
       pipAllocation ? JSON.stringify(pipAllocation) : null,
       reportedCoolingPct, predictedCoolingPct || null,
       reportedIrValue != null ? reportedIrValue : null,
       loadoutNote || null, notes || null]
    );
    res.json({ id: rows[0].id, ok: true });
  } catch (err) {
    console.error('create cooling obs failed:', err);
    res.status(500).json({ error: 'Insert failed', detail: err.message });
  }
};

app.post('/admin/cooling-observations', requireAdmin, createCoolingObsHandler);
app.post('/api/admin/cooling-observations', requireAdmin, createCoolingObsHandler);

const deleteCoolingObsHandler = async (req, res) => {
  if (!dbEnabled) return res.status(503).json({ error: 'Database not available' });
  try {
    await pool.query('DELETE FROM versedb.cooling_observations WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('delete cooling obs failed:', err);
    res.status(500).json({ error: 'Delete failed', detail: err.message });
  }
};

app.delete('/admin/cooling-observations/:id', requireAdmin, deleteCoolingObsHandler);
app.delete('/api/admin/cooling-observations/:id', requireAdmin, deleteCoolingObsHandler);

// ─── Site config (PTU toggle, label) ─────────────────────────────────

const configReadHandler = async (req, res) => {
  if (!dbEnabled) {
    // No DB → return safe defaults so the public site still loads
    return res.json({ ptuEnabled: false, ptuLabel: '' });
  }
  try {
    const cfg = await getConfig();
    res.json(cfg);
  } catch (err) {
    console.error('config read failed:', err);
    res.json({ ptuEnabled: false, ptuLabel: '' });
  }
};

app.get('/config', configReadHandler);
app.get('/api/config', configReadHandler);

const configWriteHandler = async (req, res) => {
  if (!dbEnabled) return res.status(503).json({ error: 'Database not available' });
  const body = req.body || {};
  try {
    if (typeof body.ptuEnabled === 'boolean') {
      await setSetting('ptu_enabled', body.ptuEnabled);
    }
    if (typeof body.ptuLabel === 'string') {
      await setSetting('ptu_label', body.ptuLabel);
    }
    const cfg = await getConfig();
    res.json({ ok: true, ...cfg });
  } catch (err) {
    console.error('config write failed:', err);
    res.status(500).json({ error: 'Config write failed', detail: err.message });
  }
};

app.post('/admin/config', requireAdmin, configWriteHandler);
app.post('/api/admin/config', requireAdmin, configWriteHandler);

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
      // ensureReady runs initSchema, all migrations, and importIfEmpty
      // in the correct order, so any schema evolution lands before we
      // accept the first request.
      await ensureReady();
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
