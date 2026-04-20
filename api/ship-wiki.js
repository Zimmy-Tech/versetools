// Ship wiki API client + className normalization.
//
// Pure functions, no DB access. Fetches paginated vehicles from the
// community wiki (api.star-citizen.wiki) and produces upsert-ready rows
// for `ship_wiki_metadata`. The DB write side lives in db.js.
//
// Normalization happens HERE (at ingest) so the read-side JOIN in
// exportFullDb() can be a clean PK equality on lowercased class_name.
// The Angular Ship Explorer previously did all this work at render time;
// moving it here means every future consumer gets aligned data for free.

const WIKI_BASE = 'https://api.star-citizen.wiki/api/v3/vehicles';
const PAGE_SIZE = 75;  // API default 15; 75 is the known-good page cap
const POLITE_DELAY_MS = 150;
const FETCH_TIMEOUT_MS = 30_000;

const HTTP_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'VerseTools-API/1.0 (+github.com/Zimmy-tech/versetools)',
};

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { headers: HTTP_HEADERS, signal: ctrl.signal });
    if (!resp.ok) throw new Error(`Wiki API returned HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Walk every page of the wiki vehicles endpoint and return the raw
 *  `data` arrays concatenated. Throws on any network / non-200 error.
 *  Caller handles the error by leaving existing rows in place — never
 *  half-update the table. */
export async function fetchShipWikiVehicles() {
  const out = [];
  let page = 1;
  let lastPage = 1;
  let total = 0;

  while (page <= lastPage) {
    const url = `${WIKI_BASE}?page%5Bsize%5D=${PAGE_SIZE}&page%5Bnumber%5D=${page}`;
    const payload = await fetchJson(url);
    const meta = payload?.meta ?? {};
    lastPage = Number(meta.last_page) || 1;
    total = Number(meta.total) || total;
    for (const v of payload?.data ?? []) out.push(v);
    page += 1;
    if (page <= lastPage) await sleep(POLITE_DELAY_MS);
  }
  return { vehicles: out, totalInApi: total };
}

/** Build the lookup structures needed for ingest-time className
 *  normalization. Takes our current ship list (className + name) from
 *  the DB and returns a normalizer function that maps a raw wiki
 *  class_name to our canonical form.
 *
 *  Matching precedence (first hit wins):
 *    1. Exact lowercased class_name match
 *    2. `_mkii` ↔ `_mk2` swap (both directions)
 *    3. Aurora-style `_gs_` insertion (rsi_aurora_* variants only)
 *    4. shipMatrixName → our ship.name fallback
 *    5. Unchanged (stored as-is; will simply never join)
 */
export function buildNormalizer(ships) {
  const byClass = new Set();
  const byName = new Map();   // lowercase ship.name → className
  for (const s of ships) {
    const cn = String(s.className || '').toLowerCase();
    if (cn) byClass.add(cn);
    const nm = String(s.name || '').toLowerCase();
    if (nm && !byName.has(nm)) byName.set(nm, cn);
  }

  return function normalize(rawCn, shipMatrixName) {
    const cn = String(rawCn || '').toLowerCase();
    if (!cn) return '';

    if (byClass.has(cn)) return cn;

    // _mkii ↔ _mk2 swap. Try both directions; missions-style class names
    // use either spelling depending on what CIG was writing that week.
    const mkToDigit = cn.replace(/_mkii\b/, '_mk2');
    if (mkToDigit !== cn && byClass.has(mkToDigit)) return mkToDigit;
    const digitToMk = cn.replace(/_mk2\b/, '_mkii');
    if (digitToMk !== cn && byClass.has(digitToMk)) return digitToMk;

    // Aurora: wiki tracks `rsi_aurora_mr`, our extractor emits
    // `rsi_aurora_gs_mr`. Insert `_gs_` after the Aurora prefix.
    const auroraGs = cn.replace(/^rsi_aurora_/, 'rsi_aurora_gs_');
    if (auroraGs !== cn && byClass.has(auroraGs)) return auroraGs;

    // Ship-matrix-name fallback — wiki's display name equals our
    // ship.name on roughly 95% of remaining mismatches.
    const nameKey = String(shipMatrixName || '').toLowerCase();
    if (nameKey && byName.has(nameKey)) return byName.get(nameKey);

    // No match. Store under the wiki's raw class_name; the row is still
    // useful for audit and will light up automatically if the DCB
    // extractor later introduces a matching className.
    return cn;
  };
}

/** Reduce raw wiki vehicle records into upsert-ready rows.
 *  Drops entries with no class_name or no useful fields (role / career /
 *  shipmatrix_name all blank). */
export function buildWikiRows(vehicles, normalize) {
  const rows = [];
  const seen = new Set();  // dedupe after normalization
  for (const v of vehicles) {
    const role = String(v.role || '').trim() || null;
    const career = String(v.career || '').trim() || null;
    const matrixName = String(v.shipmatrix_name || '').trim() || null;
    if (!role && !career && !matrixName) continue;
    const cn = normalize(v.class_name, matrixName);
    if (!cn || seen.has(cn)) continue;
    seen.add(cn);
    rows.push({
      class_name: cn,
      role,
      career,
      ship_matrix_name: matrixName,
    });
  }
  return rows;
}
