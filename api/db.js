// Postgres connection pool + initialization helpers
//
// If DATABASE_URL is not set (e.g. local dev with no DB), `pool` is null
// and the server falls back to file-based proxy mode.

import pg from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { Pool } = pg;

// Log the DATABASE_URL with the password redacted so we can see what
// DO is actually injecting at runtime.
if (process.env.DATABASE_URL) {
  try {
    const u = new URL(process.env.DATABASE_URL);
    const redacted = `${u.protocol}//${u.username}:***@${u.hostname}:${u.port}${u.pathname}${u.search}`;
    console.log('[db] DATABASE_URL =', redacted);
  } catch (err) {
    console.log('[db] DATABASE_URL is set but failed to parse as URL:', err.message);
    console.log('[db] raw value (first 80 chars):', String(process.env.DATABASE_URL).slice(0, 80));
  }
} else {
  console.log('[db] DATABASE_URL is not set');
}

// Build the pool from parsed URL parts so our SSL config can't be
// overridden by sslmode= in the connection string. DO's managed Postgres
// presents a CA-signed cert that Node's default trust store rejects.
function buildPool() {
  if (!process.env.DATABASE_URL) return null;
  const u = new URL(process.env.DATABASE_URL);
  return new Pool({
    host: u.hostname,
    port: u.port ? Number(u.port) : 5432,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, '') || 'defaultdb',
    ssl: { rejectUnauthorized: false },
    // Set search_path via session option so every backend connection
    // already has it before we issue a query (avoids racing client.query()
    // inside a 'connect' handler, which pg v9 deprecates).
    options: '-c search_path=versedb,public',
  });
}

export const pool = buildPool();

export const dbEnabled = !!pool;

// Run schema.sql (idempotent — uses CREATE TABLE IF NOT EXISTS)
export async function initSchema() {
  if (!pool) return;
  const schemaPath = join(__dirname, 'schema.sql');
  const sql = readFileSync(schemaPath, 'utf-8');
  await pool.query(sql);
  console.log('[db] schema initialized');
}

// Migrate an existing single-mode database to the dual-mode schema.
// Idempotent: detects whether the `mode` column already exists and
// bails out if so. On first run it adds the column, swaps the primary
// key, and seeds a PTU copy of every existing row so PTU starts as a
// clone of LIVE.
export async function migrateAddModeColumn() {
  if (!pool) return;
  const { rows } = await pool.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'versedb' AND table_name = 'ships' AND column_name = 'mode'
  `);
  if (rows.length > 0) return; // already migrated

  console.log('[db] migrating to dual-mode (live/ptu) schema...');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // ships
    await client.query(`ALTER TABLE versedb.ships ADD COLUMN mode TEXT NOT NULL DEFAULT 'live'`);
    await client.query(`ALTER TABLE versedb.ships DROP CONSTRAINT IF EXISTS ships_pkey`);
    await client.query(`ALTER TABLE versedb.ships ADD PRIMARY KEY (class_name, mode)`);
    // items
    await client.query(`ALTER TABLE versedb.items ADD COLUMN mode TEXT NOT NULL DEFAULT 'live'`);
    await client.query(`ALTER TABLE versedb.items DROP CONSTRAINT IF EXISTS items_pkey`);
    await client.query(`ALTER TABLE versedb.items ADD PRIMARY KEY (class_name, mode)`);
    // audit_log mode column
    const auditCol = await client.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'versedb' AND table_name = 'audit_log' AND column_name = 'entity_mode'
    `);
    if (auditCol.rows.length === 0) {
      await client.query(`ALTER TABLE versedb.audit_log ADD COLUMN entity_mode TEXT`);
    }
    // Seed PTU copy
    await client.query(`
      INSERT INTO versedb.ships (class_name, mode, data, source, created_at, updated_at)
      SELECT class_name, 'ptu', data, source, NOW(), NOW() FROM versedb.ships WHERE mode = 'live'
    `);
    await client.query(`
      INSERT INTO versedb.items (class_name, mode, data, source, created_at, updated_at)
      SELECT class_name, 'ptu', data, source, NOW(), NOW() FROM versedb.items WHERE mode = 'live'
    `);
    await client.query('COMMIT');
    console.log('[db] dual-mode migration complete');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Settings helpers ─────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  ptu_enabled: false,
  ptu_label: '',
};

export async function getSetting(key, fallback = null) {
  if (!pool) return fallback;
  const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  if (rows.length === 0) return fallback ?? DEFAULT_SETTINGS[key] ?? null;
  return rows[0].value;
}

export async function setSetting(key, value) {
  if (!pool) return;
  await pool.query(
    'INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()',
    [key, JSON.stringify(value)]
  );
}

export async function getConfig() {
  return {
    ptuEnabled: await getSetting('ptu_enabled', false),
    ptuLabel: await getSetting('ptu_label', ''),
  };
}

// Replace all PTU rows with the current LIVE rows. Used after a CIG
// patch lands LIVE so PTU starts the next test cycle from a clean
// baseline. Atomic: either both tables flip together or nothing changes.
export async function syncPtuFromLive(userName) {
  if (!pool) throw new Error('Database not configured');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const shipDel = await client.query(`DELETE FROM versedb.ships WHERE mode = 'ptu'`);
    const itemDel = await client.query(`DELETE FROM versedb.items WHERE mode = 'ptu'`);
    const shipIns = await client.query(`
      INSERT INTO versedb.ships (class_name, mode, data, source, created_at, updated_at)
      SELECT class_name, 'ptu', data, source, NOW(), NOW() FROM versedb.ships WHERE mode = 'live'
    `);
    const itemIns = await client.query(`
      INSERT INTO versedb.items (class_name, mode, data, source, created_at, updated_at)
      SELECT class_name, 'ptu', data, source, NOW(), NOW() FROM versedb.items WHERE mode = 'live'
    `);
    await client.query(
      `INSERT INTO versedb.audit_log (user_name, action, entity_type, entity_key, entity_mode, new_value)
       VALUES ($1, 'sync_ptu_from_live', 'system', 'all', 'ptu', $2)`,
      [userName, `ships:${shipIns.rowCount}, items:${itemIns.rowCount}`]
    );
    await client.query('COMMIT');
    return {
      shipsDeleted: shipDel.rowCount,
      shipsCopied: shipIns.rowCount,
      itemsDeleted: itemDel.rowCount,
      itemsCopied: itemIns.rowCount,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// One-time importer: if the ships table is empty, populate everything
// from data/versedb_data.json. Safe to call on every boot. Imports the
// JSON into BOTH live and ptu modes so a fresh deployment starts with
// a clone on each side.
export async function importIfEmpty() {
  if (!pool) return;
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM ships');
  if (rows[0].n > 0) {
    console.log(`[db] ships table already populated (${rows[0].n} rows), skipping import`);
    return;
  }

  const jsonPath = join(__dirname, 'data', 'versedb_data.json');
  const data = JSON.parse(readFileSync(jsonPath, 'utf-8'));
  console.log(`[db] importing ${data.ships.length} ships, ${data.items.length} items into live + ptu...`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const mode of ['live', 'ptu']) {
      for (const ship of data.ships) {
        await client.query(
          'INSERT INTO ships (class_name, mode, data, source) VALUES ($1, $2, $3, $4) ON CONFLICT (class_name, mode) DO NOTHING',
          [ship.className, mode, ship, 'extracted']
        );
      }
      for (const item of data.items) {
        await client.query(
          'INSERT INTO items (class_name, mode, data, source) VALUES ($1, $2, $3, $4) ON CONFLICT (class_name, mode) DO NOTHING',
          [item.className, mode, item, 'extracted']
        );
      }
    }

    for (const loc of data.miningLocations || []) {
      await client.query('INSERT INTO mining_locations (data) VALUES ($1)', [loc]);
    }

    for (const el of data.miningElements || []) {
      await client.query('INSERT INTO mining_elements (data) VALUES ($1)', [el]);
    }

    if (data.meta) {
      await client.query(
        'INSERT INTO meta (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()',
        [data.meta]
      );
    }

    await client.query('COMMIT');
    console.log('[db] import complete');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Check whether the schema/data is present, and run init/import if not.
// Safe to call repeatedly — every step is idempotent.
export async function ensureReady() {
  if (!pool) return;
  const { rows } = await pool.query(
    "SELECT to_regclass('versedb.ships') IS NOT NULL AS has_ships"
  );
  if (!rows[0].has_ships) {
    console.log('[db] ships table missing, running schema init...');
    await initSchema();
  }
  await migrateAddModeColumn();
  await importIfEmpty();
}

/** Coerce arbitrary input into a valid mode value. */
export function normalizeMode(input) {
  return input === 'ptu' ? 'ptu' : 'live';
}

// Assemble the same JSON shape the Angular app expects from versedb_data.json
// for the requested mode (defaults to 'live').
export async function exportFullDb(mode = 'live') {
  if (!pool) throw new Error('Database not configured');
  await ensureReady();
  const m = normalizeMode(mode);

  const [shipsRes, itemsRes, locsRes, elsRes, metaRes] = await Promise.all([
    pool.query('SELECT data FROM ships WHERE mode = $1 ORDER BY class_name', [m]),
    pool.query('SELECT data FROM items WHERE mode = $1 ORDER BY class_name', [m]),
    pool.query('SELECT data FROM mining_locations ORDER BY id'),
    pool.query('SELECT data FROM mining_elements ORDER BY id'),
    pool.query('SELECT data FROM meta WHERE id = 1'),
  ]);

  return {
    meta: metaRes.rows[0]?.data ?? { shipCount: shipsRes.rowCount, itemCount: itemsRes.rowCount },
    ships: shipsRes.rows.map((r) => r.data),
    items: itemsRes.rows.map((r) => r.data),
    miningLocations: locsRes.rows.map((r) => r.data),
    miningElements: elsRes.rows.map((r) => r.data),
  };
}
