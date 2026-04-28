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
    // search_path is set as a default on the versedb_app role via
    //   ALTER ROLE versedb_app IN DATABASE versedb SET search_path TO versedb, public;
    // This lets us connect through PgBouncer (which rejects arbitrary
    // startup options) while still landing in the right schema.
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

// Whitelist of fields that produce changelog entries. Keep in sync with
// TRACKED_FIELDS in PY SCRIPTS/versedb_extract.py. Anything not listed
// here is treated as internal/metadata and won't generate noise.
const CHANGELOG_TRACKED_FIELDS = {
  ship: ['mass', 'hp', 'cargoCapacity', 'weaponPowerPoolSize', 'thrusterPowerBars',
         'armorPhysical', 'armorEnergy', 'armorDistortion', 'armorThermal'],
  WeaponGun: ['dps', 'alphaDamage', 'fireRate', 'projectileSpeed', 'range',
              'maxHeat', 'heatPerShot', 'overheatCooldown', 'ammoCount',
              'maxRegenPerSec', 'powerDraw'],
  WeaponTachyon: ['dps', 'alphaDamage', 'fireRate', 'projectileSpeed', 'range',
                  'maxHeat', 'heatPerShot', 'overheatCooldown', 'ammoCount',
                  'maxRegenPerSec', 'powerDraw'],
  TractorBeam: ['dps', 'alphaDamage', 'fireRate', 'powerDraw'],
  Shield: ['hp', 'regenRate', 'damagedRegenDelay', 'downedRegenDelay',
           'resistPhysMax', 'resistPhysMin', 'resistEnrgMax', 'resistEnrgMin',
           'resistDistMax', 'resistDistMin'],
  PowerPlant: ['powerOutput'],
  Cooler: ['coolingRate'],
  QuantumDrive: ['speed', 'spoolTime', 'fuelRate'],
  Radar: ['aimMin', 'aimMax'],
  MissileLauncher: ['missileSize', 'capacity'],
  Missile: ['alphaDamage', 'speed', 'lockTime', 'lockRangeMax'],
};

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
    const trackedKey = isShip ? 'ship' : (next?.type || prev?.type || '');
    const fieldsToCheck = CHANGELOG_TRACKED_FIELDS[trackedKey] || [];
    const fieldDiffs = [];
    for (const f of fieldsToCheck) {
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
// Lightweight per-className diff for FPS streams. Added/removed capture
// new + gone entries; changes capture any className whose stringified
// data differs between builds. We don't drill into field-level diffs
// for FPS here — the Items DB shows current values directly, so the
// changelog just needs to signal "FPS X changed this build" for review.
function diffFpsStreamForChangelog(prevArr, nextArr) {
  const prevMap = new Map((prevArr || []).map((e) => [e.className, e]));
  const nextMap = new Map((nextArr || []).map((e) => [e.className, e]));
  const added = [], removed = [], changes = [];
  for (const key of new Set([...prevMap.keys(), ...nextMap.keys()])) {
    const prev = prevMap.get(key);
    const next = nextMap.get(key);
    if (!prev && next) { added.push({ className: key, name: next.name || key }); continue; }
    if (prev && !next) { removed.push({ className: key, name: prev.name || key }); continue; }
    if (JSON.stringify(prev) !== JSON.stringify(next)) {
      changes.push({ className: key, name: next.name || key });
    }
  }
  return { changes, added, removed };
}

export async function recordChangelogEntry({ toVersion, toChannel, ships, items, fpsItems, fpsGear, fpsArmor, missions, missionRefs }) {
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
      `SELECT id, to_version, to_channel, ship_snapshot, item_snapshot,
              fps_items_snapshot, fps_gear_snapshot, fps_armor_snapshot,
              missions_snapshot, mission_refs_snapshot
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
    const prevFpsItems = prev?.fps_items_snapshot || [];
    const prevFpsGear  = prev?.fps_gear_snapshot  || [];
    const prevFpsArmor = prev?.fps_armor_snapshot || [];
    const prevMissions = prev?.missions_snapshot  || [];

    // A stream is "present in this import" only if the caller supplied a
    // non-null, non-empty array. Missing / null / empty → carry forward
    // the prior snapshot and write [] to the changes list (no change
    // recorded for this stream this build). Applies symmetrically to
    // every stream so any-order / any-mix imports can't corrupt another
    // stream's history, even if malformed input slips past the
    // request-level guards in diffApplyHandler.
    const hasShips    = Array.isArray(ships)    && ships.length    > 0;
    const hasItems    = Array.isArray(items)    && items.length    > 0;
    const hasFpsItems = Array.isArray(fpsItems) && fpsItems.length > 0;
    const hasFpsGear  = Array.isArray(fpsGear)  && fpsGear.length  > 0;
    const hasFpsArmor = Array.isArray(fpsArmor) && fpsArmor.length > 0;
    const hasMissions = Array.isArray(missions) && missions.length > 0;
    // missionRefs is a non-array singleton blob; "present" = non-null object.
    const hasMissionRefs = missionRefs && typeof missionRefs === 'object';

    const shipDiff     = hasShips    ? diffArraysForChangelog(prevShips, ships, true)      : null;
    const itemDiff     = hasItems    ? diffArraysForChangelog(prevItems, items, false)     : null;
    const fpsItemsDiff = hasFpsItems ? diffFpsStreamForChangelog(prevFpsItems, fpsItems)   : null;
    const fpsGearDiff  = hasFpsGear  ? diffFpsStreamForChangelog(prevFpsGear,  fpsGear)    : null;
    const fpsArmorDiff = hasFpsArmor ? diffFpsStreamForChangelog(prevFpsArmor, fpsArmor)   : null;
    const missionsDiff = hasMissions ? diffFpsStreamForChangelog(prevMissions, missions)   : null;

    // Carry-forward snapshots for streams absent from this import.
    const shipSnapshot         = hasShips        ? JSON.stringify(ships)       : (prev?.ship_snapshot         != null ? JSON.stringify(prev.ship_snapshot)         : null);
    const itemSnapshot         = hasItems        ? JSON.stringify(items)       : (prev?.item_snapshot         != null ? JSON.stringify(prev.item_snapshot)         : null);
    const fpsItemsSnapshot     = hasFpsItems     ? JSON.stringify(fpsItems)    : (prev?.fps_items_snapshot    != null ? JSON.stringify(prev.fps_items_snapshot)    : null);
    const fpsGearSnapshot      = hasFpsGear      ? JSON.stringify(fpsGear)     : (prev?.fps_gear_snapshot     != null ? JSON.stringify(prev.fps_gear_snapshot)     : null);
    const fpsArmorSnapshot     = hasFpsArmor     ? JSON.stringify(fpsArmor)    : (prev?.fps_armor_snapshot    != null ? JSON.stringify(prev.fps_armor_snapshot)    : null);
    const missionsSnapshot     = hasMissions     ? JSON.stringify(missions)    : (prev?.missions_snapshot     != null ? JSON.stringify(prev.missions_snapshot)     : null);
    const missionRefsSnapshot  = hasMissionRefs  ? JSON.stringify(missionRefs) : (prev?.mission_refs_snapshot != null ? JSON.stringify(prev.mission_refs_snapshot) : null);

    const insRes = await client.query(
      `INSERT INTO changelog_entries
       (from_version, from_channel, to_version, to_channel,
        ship_changes, item_changes, ship_added, item_added, ship_removed, item_removed,
        ship_snapshot, item_snapshot,
        fps_items_changes, fps_gear_changes, fps_armor_changes,
        fps_items_snapshot, fps_gear_snapshot, fps_armor_snapshot,
        missions_changes, missions_snapshot, mission_refs_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
       RETURNING id`,
      [
        prev?.to_version ?? null,
        prev?.to_channel ?? null,
        toVersion,
        toChannel,
        JSON.stringify(shipDiff?.changes ?? []),
        JSON.stringify(itemDiff?.changes ?? []),
        JSON.stringify(shipDiff?.added   ?? []),
        JSON.stringify(itemDiff?.added   ?? []),
        JSON.stringify(shipDiff?.removed ?? []),
        JSON.stringify(itemDiff?.removed ?? []),
        shipSnapshot,
        itemSnapshot,
        JSON.stringify(fpsItemsDiff?.changes ?? []),
        JSON.stringify(fpsGearDiff?.changes ?? []),
        JSON.stringify(fpsArmorDiff?.changes ?? []),
        fpsItemsSnapshot,
        fpsGearSnapshot,
        fpsArmorSnapshot,
        JSON.stringify(missionsDiff?.changes ?? []),
        missionsSnapshot,
        missionRefsSnapshot,
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
      // Seed both mode rows from the same payload — at first import time
      // we don't have separate LIVE/PTU bundles. Subsequent admin imports
      // will overwrite the mode-specific row.
      for (const seedMode of ['live', 'ptu']) {
        await client.query(
          `INSERT INTO meta (mode, data) VALUES ($1, $2)
           ON CONFLICT (mode) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
          [seedMode, data.meta]
        );
      }
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

// Add FPS + missions snapshot/change columns to changelog_entries on
// existing DBs that predate those pipeline promotions. Fresh installs
// get them from schema.sql directly; this migration backfills older
// databases. Covers both the FPS triplet and the missions pair
// (contracts array + ref-data singleton).
async function migrateChangelogStreamColumns() {
  if (!pool) return;
  const cols = [
    // FPS
    'fps_items_snapshot', 'fps_gear_snapshot', 'fps_armor_snapshot',
    'fps_items_changes', 'fps_gear_changes', 'fps_armor_changes',
    // Missions
    'missions_snapshot', 'mission_refs_snapshot', 'missions_changes',
  ];
  for (const col of cols) {
    const { rows } = await pool.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'versedb' AND table_name = 'changelog_entries' AND column_name = $1
    `, [col]);
    if (rows.length > 0) continue;
    const isSnapshot = col.endsWith('_snapshot');
    const defClause = isSnapshot ? '' : " NOT NULL DEFAULT '[]'::jsonb";
    await pool.query(`ALTER TABLE versedb.changelog_entries ADD COLUMN ${col} JSONB${defClause}`);
    console.log(`[db] added ${col} to changelog_entries`);
  }
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
  await migrateChangelogStreamColumns();
  await migrateMetaAddModeColumn();
}

// Make the singleton `meta` table mode-aware. Without this, a PTU import
// overwrites the only row and the LIVE-mode export then returns PTU's
// `meta.version` (so the build label in the header is wrong on LIVE).
//
// Migration:
//   1. Add `mode TEXT` column with default 'ptu' (the existing row's data
//      currently reflects the most recent import — likely a PTU push if
//      this migration is running for the first time after the 4.8 PTU
//      session).
//   2. Drop the id=1 CHECK that prevented multiple rows.
//   3. Add UNIQUE(mode) so we can ON CONFLICT (mode) DO UPDATE.
//
// After the migration the LIVE row simply doesn't exist yet — the next
// admin import of LIVE data will create it. exportFullDb's meta query
// falls back to any existing row when the requested mode is missing,
// so the LIVE-mode response keeps working (with whatever meta is
// available) until LIVE is re-imported.
export async function migrateMetaAddModeColumn() {
  if (!pool) return;
  const { rows } = await pool.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'versedb' AND table_name = 'meta' AND column_name = 'mode'
  `);
  if (rows.length > 0) return; // already migrated

  console.log('[db] migrating: making meta table mode-aware...');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Drop the singleton-id check so multiple rows are allowed.
    await client.query(`ALTER TABLE versedb.meta DROP CONSTRAINT IF EXISTS meta_id_check`);
    // Add mode column. Default 'ptu' — the only existing row's data is
    // whatever was last imported, and after the 4.8 push that's PTU.
    await client.query(`ALTER TABLE versedb.meta ADD COLUMN mode TEXT NOT NULL DEFAULT 'ptu'`);
    // Future inserts use mode as the conflict key instead of id.
    await client.query(`ALTER TABLE versedb.meta ADD CONSTRAINT meta_mode_unique UNIQUE (mode)`);
    await client.query('COMMIT');
    console.log('[db] meta mode-aware migration complete');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
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

  // 2. Get current ship / item / FPS lists from the DB. We only need
  //    className/name/subType for matching — pull these from the LIVE
  //    side since both modes are mode-agnostic for prices.
  const [shipsRes, itemsRes, fpsItemsRes, fpsGearRes, fpsArmorRes] = await Promise.all([
    pool.query("SELECT data->>'className' AS class_name, data->>'name' AS name FROM versedb.ships WHERE mode = 'live'"),
    pool.query("SELECT data->>'className' AS class_name, data->>'name' AS name, data->>'subType' AS sub_type FROM versedb.items WHERE mode = 'live'"),
    pool.query("SELECT data->>'className' AS class_name, data->>'name' AS name, data->>'subType' AS sub_type FROM versedb.fps_items WHERE mode = 'live'"),
    pool.query("SELECT data->>'className' AS class_name, data->>'name' AS name, data->>'subType' AS sub_type FROM versedb.fps_gear  WHERE mode = 'live'"),
    pool.query("SELECT data->>'className' AS class_name, data->>'name' AS name FROM versedb.fps_armor WHERE mode = 'live'"),
  ]);
  const ships = shipsRes.rows.map(r => ({ className: r.class_name, name: r.name }));
  const items = itemsRes.rows.map(r => ({ className: r.class_name, name: r.name, subType: r.sub_type }));
  const fpsAll = [
    ...fpsItemsRes.rows.map(r => ({ className: r.class_name, name: r.name, subType: r.sub_type })),
    ...fpsGearRes.rows.map(r  => ({ className: r.class_name, name: r.name, subType: r.sub_type })),
    ...fpsArmorRes.rows.map(r => ({ className: r.class_name, name: r.name })),
  ];

  // 3. Match
  const shipMatch = matchUexVehiclesToShips(vehiclePrices, terminals, ships);
  const itemMatch = matchUexItemsToItems(itemPrices, terminals, items);
  const fpsMatch  = matchUexItemsToItems(itemPrices, terminals, fpsAll, 'fps_item');
  const newRows = [...shipMatch.rows, ...itemMatch.rows, ...fpsMatch.rows];

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
    let fpsItemPricesInserted = 0;
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
        else if (row.entity_type === 'fps_item') fpsItemPricesInserted++;
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
          fpsItemPricesInserted,
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
      fpsItemsMatched: fpsMatch.matchedItemCount,
      shipPricesInserted,
      itemPricesInserted,
      fpsItemPricesInserted,
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

// ─── Ship wiki metadata: community-wiki refresh ────────────────────────

/** Refresh the ship_wiki_metadata table from api.star-citizen.wiki.
 *  Each refresh is a full DELETE + INSERT inside one transaction: the
 *  wiki is the sole source for this table, there are no manual overrides
 *  to preserve, and the full set is small (~300 rows). An import failure
 *  rolls back cleanly, leaving the previous snapshot intact.
 *
 *  className normalization runs at ingest via buildNormalizer so the
 *  stored class_name column matches what exportFullDb's LEFT JOIN will
 *  look for. Wiki entries that can't be normalized to any existing
 *  ship are still stored under their raw class_name so they light up
 *  automatically if/when the DCB extractor picks up a matching ship.
 *
 *  Audit log gets one summary row per refresh. No changelog_entries
 *  ceremony — that table is for player-visible build deltas, and wiki
 *  role drift isn't one.
 *
 *  @returns {{ total: number, inserted: number, matched: number,
 *    unmatched: number, fetchedAt: string }}
 */
export async function refreshShipWikiMetadata({ actor }) {
  if (!pool) throw new Error('Database not configured');
  if (!actor) throw new Error('actor is required');

  const { fetchShipWikiVehicles, buildNormalizer, buildWikiRows } =
    await import('./ship-wiki.js');

  const { vehicles, totalInApi } = await fetchShipWikiVehicles();

  // Use LIVE ships for className normalization. The wiki doesn't
  // distinguish LIVE vs PTU; a single metadata row applies to both
  // modes, matched at JOIN time by class_name equality.
  const shipsRes = await pool.query(
    "SELECT data->>'className' AS class_name, data->>'name' AS name FROM versedb.ships WHERE mode = 'live'"
  );
  const ships = shipsRes.rows.map(r => ({ className: r.class_name, name: r.name }));
  const normalize = buildNormalizer(ships);

  const rows = buildWikiRows(vehicles, normalize);

  // Classification for the summary — does the normalized class_name
  // correspond to a ship we actually carry?
  const shipClassSet = new Set(ships.map(s => String(s.className || '').toLowerCase()));
  let matched = 0;
  for (const r of rows) if (shipClassSet.has(r.class_name)) matched += 1;
  const unmatched = rows.length - matched;

  const fetchedAt = new Date().toISOString();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM versedb.ship_wiki_metadata');

    // Batched multi-row INSERT. 300 rows × 5 cols = 1500 params, well
    // within Postgres' ~65k bind-param limit; one statement suffices.
    if (rows.length) {
      const valueClauses = [];
      const params = [];
      let p = 1;
      for (const r of rows) {
        valueClauses.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
        params.push(r.class_name, r.role, r.career, r.ship_matrix_name, fetchedAt);
      }
      await client.query(
        `INSERT INTO versedb.ship_wiki_metadata
          (class_name, role, career, ship_matrix_name, fetched_at)
         VALUES ${valueClauses.join(', ')}`,
        params
      );
    }

    await client.query(
      `INSERT INTO versedb.audit_log (user_name, action, entity_type, entity_key, new_value)
       VALUES ($1, 'ship_wiki_refresh', 'ship_wiki_metadata', NULL, $2)`,
      [actor, JSON.stringify({
        totalInApi, inserted: rows.length, matched, unmatched, fetchedAt,
      })]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return {
    total: totalInApi,
    inserted: rows.length,
    matched,
    unmatched,
    fetchedAt,
  };
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

  const [shipsRes, itemsRes, locsRes, elsRes, metaRes, shopPricesRes, wikiRes,
         fpsItemsRes, fpsGearRes, fpsArmorRes, missionsRes, missionRefsRes] = await Promise.all([
    pool.query('SELECT data FROM ships WHERE mode = $1 ORDER BY class_name', [m]),
    pool.query('SELECT data FROM items WHERE mode = $1 ORDER BY class_name', [m]),
    pool.query('SELECT data FROM mining_locations ORDER BY id'),
    pool.query('SELECT data FROM mining_elements ORDER BY id'),
    // Mode-aware meta. Falls back to any row if the requested mode
    // hasn't been populated yet (e.g. after the mode-column migration
    // before LIVE has been re-imported). Keeps the build badge filled
    // during the transition; the next mode-specific import sets it
    // correctly.
    pool.query(
      `SELECT data FROM versedb.meta
       WHERE mode = $1
       UNION ALL
       SELECT data FROM versedb.meta
       WHERE NOT EXISTS (SELECT 1 FROM versedb.meta WHERE mode = $1)
       LIMIT 1`,
      [m]
    ),
    pool.query(`
      SELECT entity_type, entity_class, shop_nickname, shop_company,
             star_system, planet, moon, orbit, space_station, city, outpost,
             price_buy, price_sell, source, notes
      FROM shop_prices
      ORDER BY entity_type, entity_class, shop_nickname
    `),
    pool.query(`
      SELECT class_name, role, career, ship_matrix_name
      FROM ship_wiki_metadata
    `),
    pool.query('SELECT data FROM fps_items WHERE mode = $1 ORDER BY class_name', [m]),
    pool.query('SELECT data FROM fps_gear  WHERE mode = $1 ORDER BY class_name', [m]),
    pool.query('SELECT data FROM fps_armor WHERE mode = $1 ORDER BY class_name', [m]),
    pool.query('SELECT data FROM missions  WHERE mode = $1 ORDER BY class_name', [m]),
    pool.query('SELECT data FROM mission_refs WHERE mode = $1', [m]),
  ]);

  // Group shop prices by entity for fast lookup
  const shipPriceMap = new Map();
  const itemPriceMap = new Map();
  const fpsPriceMap  = new Map();
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
    const map =
      row.entity_type === 'ship'     ? shipPriceMap :
      row.entity_type === 'fps_item' ? fpsPriceMap  :
                                       itemPriceMap;
    if (!map.has(row.entity_class)) map.set(row.entity_class, []);
    map.get(row.entity_class).push(entry);
  }

  // Ship wiki metadata map — keyed by lowercased class_name. Normalization
  // happened at ingest, so lookups here are a straightforward case-
  // insensitive equality against ship.className.
  const wikiMap = new Map();
  for (const row of wikiRes.rows) {
    wikiMap.set(String(row.class_name || '').toLowerCase(), {
      role: row.role,
      career: row.career,
      shipMatrixName: row.ship_matrix_name,
    });
  }

  // Reattach shopPrices + wiki role/career to each ship without mutating
  // the stored JSONB rows. Spread into a new object so the cached row
  // stays clean for any other reader. DCB `role` and `career` on the
  // ship are preserved; wiki values land on new `roleFull` / `careerFull`
  // fields so consumers can choose which to display (Ship Explorer and
  // Loadout prefer roleFull when present; all other pages that already
  // read `role` are unaffected).
  const ships = shipsRes.rows.map((r) => {
    const ship = r.data;
    const prices = shipPriceMap.get(ship.className);
    const wiki = wikiMap.get(String(ship.className || '').toLowerCase());
    const next = prices ? { ...ship, shopPrices: prices } : ship;
    if (!wiki) return next;
    return {
      ...(next === ship ? { ...ship } : next),
      roleFull: wiki.role ?? undefined,
      careerFull: wiki.career ?? undefined,
      shipMatrixName: wiki.shipMatrixName ?? undefined,
    };
  });
  const items = itemsRes.rows.map((r) => {
    const item = r.data;
    const prices = itemPriceMap.get(item.className);
    return prices ? { ...item, shopPrices: prices } : item;
  });

  // Reattach shop prices to FPS rows. fpsItems / fpsGear / fpsArmor
  // share the 'fps_item' entity_type bucket — overlaps between the three
  // arrays are a curiosity of how DCB groups them, not separate items,
  // so a single map keyed by className is sufficient.
  const reattachFps = (rows) => rows.map((r) => {
    const entity = r.data;
    const prices = fpsPriceMap.get(entity.className);
    return prices ? { ...entity, shopPrices: prices } : entity;
  });

  return {
    meta: metaRes.rows[0]?.data ?? { shipCount: shipsRes.rowCount, itemCount: itemsRes.rowCount },
    ships,
    items,
    miningLocations: locsRes.rows.map((r) => r.data),
    miningElements: elsRes.rows.map((r) => r.data),
    fpsItems: reattachFps(fpsItemsRes.rows),
    fpsGear:  reattachFps(fpsGearRes.rows),
    fpsArmor: reattachFps(fpsArmorRes.rows),
    missions: missionsRes.rows.map((r) => r.data),
    missionRefs: missionRefsRes.rows[0]?.data ?? null,
  };
}
