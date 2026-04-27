// UEX Corp API client + matching logic
//
// Pure functions, no DB access. Given a list of ships/items from our
// database, fetches UEX's vehicle and item price endpoints (plus the
// terminals lookup for richer location data) and produces a list of
// shop_prices rows ready for INSERT.
//
// The DB write side lives in db.js / the refresh endpoint. This module
// only fetches and matches.

const UEX_BASE = 'https://api.uexcorp.space/2.0';
const UEX_VEHICLE_URL = `${UEX_BASE}/vehicles_purchases_prices_all`;
const UEX_ITEM_URL = `${UEX_BASE}/items_prices_all`;
const UEX_TERMINALS_URL = `${UEX_BASE}/terminals`;

const HTTP_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'VerseTools-API/1.0',
};

const FETCH_TIMEOUT_MS = 30_000;

// Some UEX terminal nicknames are slightly off — they label the terminal
// after the planet/system instead of the in-game city. The legacy Python
// extractor remapped these to keep the displayed shop name aligned with
// the actual location. We preserve the same mapping so existing display
// strings ("New Deal Orison") don't suddenly become ("New Deal Crusader")
// after the first refresh through the new pipeline.
const SHOP_NICKNAME_OVERRIDES = {
  'New Deal Crusader': 'New Deal Orison',
};

/** Normalize a name for matching: smart quotes → straight, trim, lowercase. */
export function normalizeName(name) {
  if (!name) return '';
  return String(name)
    .replace(/\u201c|\u201d/g, '"')
    .replace(/\u2018|\u2019/g, "'")
    .trim()
    .toLowerCase();
}

/** Fetch JSON from a URL with a timeout and standard headers. Throws on
 *  network error, non-200 status, or non-ok status field in the body. */
async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { headers: HTTP_HEADERS, signal: ctrl.signal });
    if (!resp.ok) {
      throw new Error(`UEX fetch ${url} returned HTTP ${resp.status}`);
    }
    const body = await resp.json();
    if (body?.status !== 'ok') {
      throw new Error(`UEX fetch ${url} returned status=${body?.status ?? 'missing'}`);
    }
    return body.data ?? [];
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch all UEX terminals into a Map<id_terminal, terminal>. */
export async function fetchUexTerminals() {
  const data = await fetchJson(UEX_TERMINALS_URL);
  const map = new Map();
  for (const t of data) {
    if (t?.id != null) map.set(t.id, t);
  }
  return map;
}

/** Fetch all UEX vehicle purchase prices. Raw records, unmatched. */
export async function fetchUexVehiclePrices() {
  return fetchJson(UEX_VEHICLE_URL);
}

/** Fetch all UEX item prices. Raw records, unmatched. */
export async function fetchUexItemPrices() {
  return fetchJson(UEX_ITEM_URL);
}

/** Build a shop_prices row from a UEX price record + the terminals map.
 *  Returns the row object suitable for INSERT, or null if the record is
 *  missing required fields. */
function buildShopPriceRow({ entityType, entityClass, uexRecord, terminalsMap }) {
  const rawNickname = String(uexRecord.terminal_name || '').trim();
  if (!rawNickname || typeof uexRecord.price_buy !== 'number' || uexRecord.price_buy <= 0) {
    return null;
  }
  const shopNickname = SHOP_NICKNAME_OVERRIDES[rawNickname] ?? rawNickname;
  const terminal = terminalsMap.get(uexRecord.id_terminal) || null;

  return {
    entity_type: entityType,
    entity_class: entityClass,
    shop_nickname: shopNickname,
    shop_company: terminal?.company_name || null,
    star_system: terminal?.star_system_name || null,
    planet: terminal?.planet_name || null,
    moon: terminal?.moon_name || null,
    orbit: terminal?.orbit_name || null,
    space_station: terminal?.space_station_name || null,
    city: terminal?.city_name || null,
    outpost: terminal?.outpost_name || null,
    price_buy: uexRecord.price_buy,
    price_sell: typeof uexRecord.price_sell === 'number' && uexRecord.price_sell > 0
      ? uexRecord.price_sell
      : null,
    source: 'uex',
    uex_terminal_id: uexRecord.id_terminal ?? null,
    notes: null,
  };
}

/** Match UEX vehicle price records against our ships list and return
 *  rows ready for INSERT into shop_prices.
 *
 *  Matching strategy mirrors the Python extractor:
 *    1. Try the full normalized ship name (e.g. 'Aegis Avenger Titan')
 *    2. Fall back to the "short name" — everything after the first space
 *       (e.g. 'Avenger Titan'), since UEX often drops the manufacturer
 *
 *  @param {Array} uexVehiclePrices - raw records from /vehicles_purchases_prices_all
 *  @param {Map<number, object>} terminalsMap - id_terminal -> terminal record
 *  @param {Array<{className: string, name: string}>} ships - our ship list
 *  @returns {{rows: object[], matchedShipCount: number, unmatchedUexNames: string[]}}
 */
export function matchUexVehiclesToShips(uexVehiclePrices, terminalsMap, ships) {
  // Index UEX records by normalized name → list of records
  const uexByName = new Map();
  for (const rec of uexVehiclePrices) {
    const key = normalizeName(rec?.vehicle_name);
    if (!key) continue;
    if (!uexByName.has(key)) uexByName.set(key, []);
    uexByName.get(key).push(rec);
  }

  const rows = [];
  const matchedShipClasses = new Set();
  const matchedUexKeys = new Set();

  for (const ship of ships) {
    const shipName = String(ship.name || '').trim();
    if (!shipName) continue;
    let matches = uexByName.get(normalizeName(shipName));
    if (!matches || matches.length === 0) {
      // Try short name fallback
      const short = shipName.includes(' ') ? shipName.split(' ').slice(1).join(' ') : shipName;
      matches = uexByName.get(normalizeName(short));
    }
    if (!matches || matches.length === 0) continue;

    matchedShipClasses.add(ship.className);
    matchedUexKeys.add(normalizeName(matches[0].vehicle_name));
    for (const rec of matches) {
      const row = buildShopPriceRow({
        entityType: 'ship',
        entityClass: ship.className,
        uexRecord: rec,
        terminalsMap,
      });
      if (row) rows.push(row);
    }
  }

  // UEX names we never matched to anything in our DB
  const unmatchedUexNames = [];
  const seen = new Set();
  for (const rec of uexVehiclePrices) {
    const key = normalizeName(rec?.vehicle_name);
    if (!key || matchedUexKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    unmatchedUexNames.push(rec.vehicle_name);
  }

  return {
    rows,
    matchedShipCount: matchedShipClasses.size,
    unmatchedUexNames,
  };
}

/** Match UEX item price records against our items list and return rows
 *  ready for INSERT into shop_prices.
 *
 *  Matching strategy mirrors the Python extractor:
 *    1. Try the full normalized item name
 *    2. Fall back to "${name} ${subType}" — UEX sometimes appends the
 *       size or grade to the display name
 *
 *  @param {string} entityType - 'item' (ship components) or 'fps_item'
 *         (FPS weapons / gear / armor). Stored as shop_prices.entity_type
 *         so the export step knows which bucket to attach prices to.
 */
export function matchUexItemsToItems(uexItemPrices, terminalsMap, items, entityType = 'item') {
  const uexByName = new Map();
  for (const rec of uexItemPrices) {
    const key = normalizeName(rec?.item_name);
    if (!key) continue;
    if (!uexByName.has(key)) uexByName.set(key, []);
    uexByName.get(key).push(rec);
  }

  const rows = [];
  const matchedItemClasses = new Set();
  const matchedUexKeys = new Set();

  for (const item of items) {
    const itemName = String(item.name || '').trim();
    if (!itemName) continue;
    let matches = uexByName.get(normalizeName(itemName));
    if (!matches || matches.length === 0) {
      const sub = String(item.subType || '').trim();
      if (sub) {
        matches = uexByName.get(normalizeName(`${itemName} ${sub}`));
      }
    }
    if (!matches || matches.length === 0) continue;

    matchedItemClasses.add(item.className);
    matchedUexKeys.add(normalizeName(matches[0].item_name));
    for (const rec of matches) {
      const row = buildShopPriceRow({
        entityType,
        entityClass: item.className,
        uexRecord: rec,
        terminalsMap,
      });
      if (row) rows.push(row);
    }
  }

  const unmatchedUexNames = [];
  const seen = new Set();
  for (const rec of uexItemPrices) {
    const key = normalizeName(rec?.item_name);
    if (!key || matchedUexKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    unmatchedUexNames.push(rec.item_name);
  }

  return {
    rows,
    matchedItemCount: matchedItemClasses.size,
    unmatchedUexNames,
  };
}
