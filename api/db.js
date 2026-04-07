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

export const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      // DigitalOcean managed Postgres requires SSL but uses a self-signed cert
      ssl: { rejectUnauthorized: false },
    })
  : null;

export const dbEnabled = !!pool;

// Run schema.sql (idempotent — uses CREATE TABLE IF NOT EXISTS)
export async function initSchema() {
  if (!pool) return;
  const schemaPath = join(__dirname, 'schema.sql');
  const sql = readFileSync(schemaPath, 'utf-8');
  await pool.query(sql);
  console.log('[db] schema initialized');
}

// One-time importer: if the ships table is empty, populate everything
// from data/versedb_data.json. Safe to call on every boot.
export async function importIfEmpty() {
  if (!pool) return;
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM ships');
  if (rows[0].n > 0) {
    console.log(`[db] ships table already populated (${rows[0].n} rows), skipping import`);
    return;
  }

  const jsonPath = join(__dirname, 'data', 'versedb_data.json');
  const data = JSON.parse(readFileSync(jsonPath, 'utf-8'));
  console.log(`[db] importing ${data.ships.length} ships, ${data.items.length} items...`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const ship of data.ships) {
      await client.query(
        'INSERT INTO ships (class_name, data, source) VALUES ($1, $2, $3) ON CONFLICT (class_name) DO NOTHING',
        [ship.className, ship, 'extracted']
      );
    }

    for (const item of data.items) {
      await client.query(
        'INSERT INTO items (class_name, data, source) VALUES ($1, $2, $3) ON CONFLICT (class_name) DO NOTHING',
        [item.className, item, 'extracted']
      );
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

// Assemble the same JSON shape the Angular app expects from versedb_data.json
export async function exportFullDb() {
  if (!pool) throw new Error('Database not configured');

  const [shipsRes, itemsRes, locsRes, elsRes, metaRes] = await Promise.all([
    pool.query('SELECT data FROM ships ORDER BY class_name'),
    pool.query('SELECT data FROM items ORDER BY class_name'),
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
