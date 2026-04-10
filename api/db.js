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

// ─── Changelog history ──────────────────────────────────────────────

const CHANGELOG_RETENTION = 6; // keep this many most-recent entries

function categorizeItem(item) {
  const t = item?.type || '';
  if (t === 'WeaponGun' || t === 'WeaponTachyon') return 'weapon';
  if (t === 'TractorBeam') return 'tractor';
  if (t === 'Shield') return 'shield';
  if (t === 'PowerPlant') return 'powerplant';
  if (t === 'Cooler') return 'cooler';
  if (t === 'QuantumDrive') return 'quantumdrive';
  if (t === 'Radar') return 'radar';
  if (t === 'MissileLauncher' || t === 'BombLauncher') return 'missilelauncher';
  if (t === 'Missile') return 'missile';
  return t.toLowerCase() || 'other';
}

function diffArraysForChangelog(prevArr, nextArr, isShip) {
  const prevMap = new Map((prevArr || []).map((e) => [e.className, e]));
  const nextMap = new Map((nextArr || []).map((e) => [e.className, e]));
  const allKeys = new Set([...prevMap.keys(), ...nextMap.keys()]);
  const changes = [];
  const added = [];
  const removed = [];
  for (const key of [...allKeys].sort()) {
    const prev = prevMap.get(key);
    const next = nextMap.get(key);
    if (!prev && next) {
      added.push({
        category: isShip ? 'ship' : categorizeItem(next),
        className: key,
        name: next.name || key,
      });
      continue;
    }
    if (prev && !next) {
      removed.push({
        category: isShip ? 'ship' : categorizeItem(prev),
        className: key,
        name: prev.name || key,
      });
      continue;
    }
    // Compare every top-level field
    const fieldDiffs = [];
    const allFieldKeys = new Set([...Object.keys(prev || {}), ...Object.keys(next || {})]);
    for (const f of allFieldKeys) {
      const ov = prev[f];
      const nv = next[f];
      if (ov === undefined && nv === undefined) continue;
      if (JSON.stringify(ov) !== JSON.stringify(nv)) {
        fieldDiffs.push({ field: f, old: ov ?? null, new: nv ?? null });
      }
    }
    if (fieldDiffs.length > 0) {
      changes.push({
        category: isShip ? 'ship' : categorizeItem(next),
        className: key,
        name: next.name || key,
        fields: fieldDiffs,
      });
    }
  }
  return { changes, added, removed };
}

/** Records a new changelog entry by diffing the supplied build against
 *  the most recent stored entry's snapshot. Idempotent: if the most
 *  recent entry already has the same to_version + to_channel, skips.
 *  Prunes older entries beyond CHANGELOG_RETENTION. */
export async function recordChangelogEntry({ toVersion, toChannel, ships, items }) {
  if (!pool) return null;
  if (!toVersion || !toChannel) {
    throw new Error('toVersion and toChannel are required');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Only compare against previous BUILD entries — skip price_refresh
    // entries so UEX price updates don't pollute the build changelog.
    const { rows: prevRows } = await client.query(
      `SELECT id, to_version, to_channel, ship_snapshot, item_snapshot
       FROM changelog_entries
       WHERE entry_type IS DISTINCT FROM 'price_refresh'
       ORDER BY id DESC LIMIT 1`
    );
    const prev = prevRows[0] || null;

    if (prev && prev.to_version === toVersion && prev.to_channel === toChannel) {
      // De-dup: same build re-imported. Skip.
      await client.query('COMMIT');
      return { skipped: true, reason: 'duplicate' };
    }

    const prevShips = prev?.ship_snapshot || [];
    const prevItems = prev?.item_snapshot || [];

    const shipDiff = diffArraysForChangelog(prevShips, ships, true);
    const itemDiff = diffArraysForChangelog(prevItems, items, false);

    const insRes = await client.query(
      `INSERT INTO changelog_entries
       (from_version, from_channel, to_version, to_channel,
        ship_changes, item_changes, ship_added, item_added, ship_removed, item_removed,
        ship_snapshot, item_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        prev?.to_version ?? null,
        prev?.to_channel ?? null,
        toVersion,
        toChannel,
        JSON.stringify(shipDiff.changes),
        JSON.stringify(itemDiff.changes),
        JSON.stringify(shipDiff.added),
        JSON.stringify(itemDiff.added),
        JSON.stringify(shipDiff.removed),
        JSON.stringify(itemDiff.removed),
        JSON.stringify(ships || []),
        JSON.stringify(items || []),
      ]
    );

    // Prune older entries beyond the retention window
    await client.query(
      `DELETE FROM changelog_entries
       WHERE id NOT IN (
         SELECT id FROM changelog_entries ORDER BY id DESC LIMIT $1
       )`,
      [CHANGELOG_RETENTION]
    );

    await client.query('COMMIT');
    return { id: insRes.rows[0].id, skipped: false };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Returns the most recent changelog entries, newest first.
 *  Snapshots are not returned (they're internal — used to compute
 *  the next diff). */
export async function getChangelogHistory(limit = CHANGELOG_RETENTION) {
  if (!pool) return [];
  // Only return build entries — price_refresh entries are separate
  const { rows } = await pool.query(
    `SELECT id, from_version, from_channel, to_version, to_channel,
            imported_at, ship_changes, item_changes,
            ship_added, item_added, ship_removed, item_removed
     FROM changelog_entries
     WHERE entry_type IS DISTINCT FROM 'price_refresh'
     ORDER BY id DESC
     LIMIT $1`,
    [Math.min(limit, CHANGELOG_RETENTION * 2)]
  );
  return rows;
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

// Migrate from the old schema where shopPrices lived inside the
// ships/items JSONB blob to the standalone shop_prices table. Also
// extends changelog_entries with price_* columns.
//
// Idempotent: detects whether changelog_entries already has the
// entry_type column (which only exists post-migration) and bails out
// if so. On first run it:
//   1. ALTERs changelog_entries to add entry_type, actor, and price_* columns
//   2. Walks LIVE ships/items, pulls each shopPrices array out of the
//      data JSONB, inserts the entries into shop_prices (deduped via
//      ON CONFLICT, since LIVE/PTU were seeded as identical clones)
//   3. UPDATEs ships and items to remove the now-extracted shopPrices
//      field from their data JSONB
// Location columns (star_system, planet, etc.) are left NULL on this
// initial extraction; the next UEX refresh fills them in.
export async function migrateExtractShopPrices() {
  if (!pool) return;
  const { rows: hasCol } = await pool.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'versedb' AND table_name = 'changelog_entries' AND column_name = 'entry_type'
  `);
  if (hasCol.length > 0) {
    // Already migrated. Ensure the type index exists for fresh installs
    // where this function returns early on first run after schema.sql
    // created the column directly (no ALTER needed). No-op otherwise.
    await pool.query(`
      CREATE INDEX IF NOT EXISTS changelog_entries_type_idx
        ON versedb.changelog_entries (entry_type, id DESC)
    `);
    return;
  }

  console.log('[db] migrating: extracting shopPrices into standalone shop_prices table...');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Extend changelog_entries with the new columns
    await client.query(`
      ALTER TABLE versedb.changelog_entries
        ADD COLUMN entry_type     TEXT NOT NULL DEFAULT 'build_import',
        ADD COLUMN actor          TEXT,
        ADD COLUMN price_changes  JSONB NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN price_added    JSONB NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN price_removed  JSONB NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN price_snapshot JSONB
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS changelog_entries_type_idx
        ON versedb.changelog_entries (entry_type, id DESC)
    `);

    // 2. Extract from LIVE ships (PTU is an identical clone — we'd just
    //    re-insert duplicates that ON CONFLICT would discard anyway).
    let shipPricesExtracted = 0;
    const { rows: shipRows } = await client.query(`
      SELECT class_name, data->'shopPrices' AS prices
      FROM versedb.ships
      WHERE mode = 'live'
        AND data ? 'shopPrices'
        AND jsonb_typeof(data->'shopPrices') = 'array'
    `);

    for (const row of shipRows) {
      for (const p of (row.prices || [])) {
        if (!p?.shop || typeof p?.price !== 'number') continue;
        await client.query(`
          INSERT INTO versedb.shop_prices
            (entity_type, entity_class, shop_nickname, price_buy, source)
          VALUES ('ship', $1, $2, $3, 'uex')
          ON CONFLICT (entity_type, entity_class, shop_nickname, source) DO NOTHING
        `, [row.class_name, p.shop, p.price]);
        shipPricesExtracted++;
      }
    }

    // 3. Strip shopPrices from BOTH live and ptu ships rows.
    const stripShipsRes = await client.query(
      `UPDATE versedb.ships SET data = data - 'shopPrices' WHERE data ? 'shopPrices'`
    );

    // 4. Same for items.
    let itemPricesExtracted = 0;
    const { rows: itemRows } = await client.query(`
      SELECT class_name, data->'shopPrices' AS prices
      FROM versedb.items
      WHERE mode = 'live'
        AND data ? 'shopPrices'
        AND jsonb_typeof(data->'shopPrices') = 'array'
    `);

    for (const row of itemRows) {
      for (const p of (row.prices || [])) {
        if (!p?.shop || typeof p?.price !== 'number') continue;
        await client.query(`
          INSERT INTO versedb.shop_prices
            (entity_type, entity_class, shop_nickname, price_buy, source)
          VALUES ('item', $1, $2, $3, 'uex')
          ON CONFLICT (entity_type, entity_class, shop_nickname, source) DO NOTHING
        `, [row.class_name, p.shop, p.price]);
        itemPricesExtracted++;
      }
    }

    const stripItemsRes = await client.query(
      `UPDATE versedb.items SET data = data - 'shopPrices' WHERE data ? 'shopPrices'`
    );

    await client.query('COMMIT');
    console.log(
      `[db] shop_prices migration complete: ` +
      `extracted ${shipPricesExtracted} ship prices (stripped from ${stripShipsRes.rowCount} ship rows), ` +
      `${itemPricesExtracted} item prices (stripped from ${stripItemsRes.rowCount} item rows)`
    );
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Check whether the schema/data is present, and run init/import if not.
// Safe to call repeatedly — every step is idempotent.
//
// initSchema must run on every startup, not just when ships is missing,
// because schema.sql also defines newer tables (shop_prices) and indexes
// that existing installs would otherwise never receive. The whole file
// Add reported_ir_value column to cooling_observations if it doesn't exist.
async function migrateCoolingIrColumn() {
  if (!pool) return;
  const { rows } = await pool.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'versedb' AND table_name = 'cooling_observations' AND column_name = 'reported_ir_value'
  `);
  if (rows.length > 0) return;
  await pool.query(`ALTER TABLE versedb.cooling_observations ADD COLUMN reported_ir_value REAL`);
  console.log('[db] added reported_ir_value to cooling_observations');
}

// uses CREATE TABLE / INDEX IF NOT EXISTS so re-running it on a populated
// database is a no-op for everything that already exists.
export async function ensureReady() {
  if (!pool) return;
  await initSchema();
  await migrateAddModeColumn();
  await importIfEmpty();
  await migrateExtractShopPrices();
  await migrateCoolingIrColumn();
}

/** Coerce arbitrary input into a valid mode value. */
export function normalizeMode(input) {
  return input === 'ptu' ? 'ptu' : 'live';
}

// ─── Shop prices: UEX refresh ──────────────────────────────────────────

/** Refresh the source='uex' shop prices from UEX Corp's API. Manual
 *  entries (source='manual') are never touched. The whole operation
 *  runs in a single transaction so a partial failure leaves the table
 *  in its prior state.
 *
 *  Side effects:
 *    - DELETE all existing source='uex' rows
 *    - INSERT freshly fetched rows
 *    - INSERT one changelog_entries row of entry_type='price_refresh'
 *      with the per-(entity,shop) diff lists and a full snapshot of
 *      the new UEX state for the next refresh to diff against
 *    - INSERT one audit_log entry summarizing the refresh
 *
 *  @param {{ actor: string }} options - actor is the admin username
 *  @returns {Promise<{
 *    shipsMatched: number, itemsMatched: number,
 *    shipPricesInserted: number, itemPricesInserted: number,
 *    priceChanges: number, priceAdded: number, priceRemoved: number,
 *    unmatchedShipNames: string[], unmatchedItemNames: string[],
 *    changelogEntryId: number,
 *  }>}
 */
export async function refreshUexShopPrices({ actor }) {
  if (!pool) throw new Error('Database not configured');
  if (!actor) throw new Error('actor is required');

  const {
    fetchUexTerminals,
    fetchUexVehiclePrices,
    fetchUexItemPrices,
    matchUexVehiclesToShips,
    matchUexItemsToItems,
  } = await import('./uex.js');

  // 1. Fetch from UEX (in parallel)
  const [terminals, vehiclePrices, itemPrices] = await Promise.all([
    fetchUexTerminals(),
    fetchUexVehiclePrices(),
    fetchUexItemPrices(),
  ]);

  // 2. Get current ship and item lists from the DB. We only need
  //    className/name/subType for matching — pull these from the LIVE
  //    side since both modes are mode-agnostic for prices.
  const [shipsRes, itemsRes] = await Promise.all([
    pool.query("SELECT data->>'className' AS class_name, data->>'name' AS name FROM versedb.ships WHERE mode = 'live'"),
    pool.query("SELECT data->>'className' AS class_name, data->>'name' AS name, data->>'subType' AS sub_type FROM versedb.items WHERE mode = 'live'"),
  ]);
  const ships = shipsRes.rows.map(r => ({ className: r.class_name, name: r.name }));
  const items = itemsRes.rows.map(r => ({ className: r.class_name, name: r.name, subType: r.sub_type }));

  // 3. Match
  const shipMatch = matchUexVehiclesToShips(vehiclePrices, terminals, ships);
  const itemMatch = matchUexItemsToItems(itemPrices, terminals, items);
  const newRows = [...shipMatch.rows, ...itemMatch.rows];

  // 4. Capture the previous UEX state for the diff
  const { rows: prevRows } = await pool.query(`
    SELECT entity_type, entity_class, shop_nickname, price_buy
    FROM versedb.shop_prices
    WHERE source = 'uex'
  `);
  const diff = computeShopPriceDiff(prevRows, newRows);

  // 5. Apply the changes transactionally
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query("DELETE FROM versedb.shop_prices WHERE source = 'uex'");

    // Batched multi-row INSERT — orders of magnitude faster than one
    // statement per row for the ~4k rows a typical refresh produces.
    // Postgres allows ~65k bind params per statement, so 16 cols × 500 rows
    // = 8000 params per batch is well within bounds.
    const BATCH_ROWS = 500;
    let shipPricesInserted = 0;
    let itemPricesInserted = 0;
    for (let i = 0; i < newRows.length; i += BATCH_ROWS) {
      const batch = newRows.slice(i, i + BATCH_ROWS);
      const valueClauses = [];
      const params = [];
      let p = 1;
      for (const row of batch) {
        valueClauses.push(
          `($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, ` +
          `$${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`
        );
        params.push(
          row.entity_type, row.entity_class, row.shop_nickname, row.shop_company,
          row.star_system, row.planet, row.moon, row.orbit, row.space_station, row.city, row.outpost,
          row.price_buy, row.price_sell, row.source, row.uex_terminal_id, row.notes
        );
        if (row.entity_type === 'ship') shipPricesInserted++;
        else itemPricesInserted++;
      }
      await client.query(
        `INSERT INTO versedb.shop_prices
          (entity_type, entity_class, shop_nickname, shop_company,
           star_system, planet, moon, orbit, space_station, city, outpost,
           price_buy, price_sell, source, uex_terminal_id, notes)
         VALUES ${valueClauses.join(', ')}
         ON CONFLICT (entity_type, entity_class, shop_nickname, source) DO NOTHING`,
        params
      );
    }

    // 6. Record the changelog entry
    const refreshTimestamp = new Date().toISOString();
    const insRes = await client.query(
      `INSERT INTO versedb.changelog_entries
        (entry_type, from_version, from_channel, to_version, to_channel, actor,
         price_changes, price_added, price_removed, price_snapshot)
       VALUES ('price_refresh', $1, $2, $3, 'uex', $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        diff.fromVersion,
        diff.fromVersion ? 'uex' : null,
        refreshTimestamp,
        actor,
        JSON.stringify(diff.changes),
        JSON.stringify(diff.added),
        JSON.stringify(diff.removed),
        JSON.stringify(newRows.map(r => ({
          entity_type: r.entity_type,
          entity_class: r.entity_class,
          shop_nickname: r.shop_nickname,
          price_buy: r.price_buy,
        }))),
      ]
    );
    const changelogEntryId = insRes.rows[0].id;

    // Prune older entries beyond retention (same logic as build imports)
    await client.query(
      `DELETE FROM versedb.changelog_entries
       WHERE id NOT IN (
         SELECT id FROM versedb.changelog_entries ORDER BY id DESC LIMIT $1
       )`,
      [CHANGELOG_RETENTION]
    );

    // 7. Audit log entry
    await client.query(
      `INSERT INTO versedb.audit_log (user_name, action, entity_type, entity_key, new_value)
       VALUES ($1, 'shop_prices_refresh', 'shop_prices', NULL, $2)`,
      [
        actor,
        JSON.stringify({
          shipPricesInserted,
          itemPricesInserted,
          priceChanges: diff.changes.length,
          priceAdded: diff.added.length,
          priceRemoved: diff.removed.length,
        }),
      ]
    );

    await client.query('COMMIT');

    return {
      shipsMatched: shipMatch.matchedShipCount,
      itemsMatched: itemMatch.matchedItemCount,
      shipPricesInserted,
      itemPricesInserted,
      priceChanges: diff.changes.length,
      priceAdded: diff.added.length,
      priceRemoved: diff.removed.length,
      unmatchedShipNames: shipMatch.unmatchedUexNames,
      unmatchedItemNames: itemMatch.unmatchedUexNames,
      changelogEntryId,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Compute the diff between the previous source='uex' shop_prices state
 *  and the new set of rows about to be inserted. Returns lists for the
 *  changelog: changes (same key, different price), added (new keys),
 *  removed (keys that disappeared). The "key" here is
 *  (entity_type, entity_class, shop_nickname). */
function computeShopPriceDiff(prevRows, newRows) {
  const keyOf = (r) => `${r.entity_type}\u0001${r.entity_class}\u0001${r.shop_nickname}`;
  const prevMap = new Map(prevRows.map(r => [keyOf(r), r]));
  const newMap = new Map(newRows.map(r => [keyOf(r), r]));

  const changes = [];
  const added = [];
  const removed = [];

  for (const [k, n] of newMap.entries()) {
    const p = prevMap.get(k);
    if (!p) {
      added.push({
        entity_type: n.entity_type,
        entity_class: n.entity_class,
        shop_nickname: n.shop_nickname,
        new_price: n.price_buy,
      });
    } else if (Number(p.price_buy) !== Number(n.price_buy)) {
      changes.push({
        entity_type: n.entity_type,
        entity_class: n.entity_class,
        shop_nickname: n.shop_nickname,
        old_price: Number(p.price_buy),
        new_price: Number(n.price_buy),
      });
    }
  }
  for (const [k, p] of prevMap.entries()) {
    if (!newMap.has(k)) {
      removed.push({
        entity_type: p.entity_type,
        entity_class: p.entity_class,
        shop_nickname: p.shop_nickname,
        old_price: Number(p.price_buy),
      });
    }
  }

  return {
    fromVersion: prevRows.length > 0 ? `prev:${prevRows.length}` : null,
    changes,
    added,
    removed,
  };
}

// Assemble the same JSON shape the Angular app expects from versedb_data.json
// for the requested mode (defaults to 'live').
//
// Shop prices are stored in their own mode-agnostic table and reattached
// here so the frontend payload shape is unchanged from the days when
// shopPrices lived inside each ship/item JSONB blob.
export async function exportFullDb(mode = 'live') {
  if (!pool) throw new Error('Database not configured');
  await ensureReady();
  const m = normalizeMode(mode);

  const [shipsRes, itemsRes, locsRes, elsRes, metaRes, shopPricesRes] = await Promise.all([
    pool.query('SELECT data FROM ships WHERE mode = $1 ORDER BY class_name', [m]),
    pool.query('SELECT data FROM items WHERE mode = $1 ORDER BY class_name', [m]),
    pool.query('SELECT data FROM mining_locations ORDER BY id'),
    pool.query('SELECT data FROM mining_elements ORDER BY id'),
    pool.query('SELECT data FROM meta WHERE id = 1'),
    pool.query(`
      SELECT entity_type, entity_class, shop_nickname, shop_company,
             star_system, planet, moon, orbit, space_station, city, outpost,
             price_buy, price_sell, source, notes
      FROM shop_prices
      ORDER BY entity_type, entity_class, shop_nickname
    `),
  ]);

  // Group shop prices by entity for fast lookup
  const shipPriceMap = new Map();
  const itemPriceMap = new Map();
  for (const row of shopPricesRes.rows) {
    // Build the legacy {price, shop} entry the frontend expects today,
    // plus the richer fields appended for future use. Existing UI code
    // reads `.shop` and `.price` and is unaffected by the extra keys.
    const entry = {
      shop: row.shop_nickname,
      price: row.price_buy,
      // Richer location/source data — opt-in for new UI features:
      shopCompany: row.shop_company,
      starSystem: row.star_system,
      planet: row.planet,
      moon: row.moon,
      orbit: row.orbit,
      spaceStation: row.space_station,
      city: row.city,
      outpost: row.outpost,
      priceSell: row.price_sell,
      source: row.source,
      notes: row.notes,
    };
    const map = row.entity_type === 'ship' ? shipPriceMap : itemPriceMap;
    if (!map.has(row.entity_class)) map.set(row.entity_class, []);
    map.get(row.entity_class).push(entry);
  }

  // Reattach shopPrices to each ship/item without mutating the stored
  // JSONB rows. We spread into a new object so the cached row data
  // stays clean for any other reader.
  const ships = shipsRes.rows.map((r) => {
    const ship = r.data;
    const prices = shipPriceMap.get(ship.className);
    return prices ? { ...ship, shopPrices: prices } : ship;
  });
  const items = itemsRes.rows.map((r) => {
    const item = r.data;
    const prices = itemPriceMap.get(item.className);
    return prices ? { ...item, shopPrices: prices } : item;
  });

  return {
    meta: metaRes.rows[0]?.data ?? { shipCount: shipsRes.rowCount, itemCount: itemsRes.rowCount },
    ships,
    items,
    miningLocations: locsRes.rows.map((r) => r.data),
    miningElements: elsRes.rows.map((r) => r.data),
  };
}
