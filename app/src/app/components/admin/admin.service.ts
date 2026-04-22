// Admin auth + write operations against the API.

import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Router } from '@angular/router';

interface LoginResponse {
  token: string;
  username: string;
  role: string;
}

const TOKEN_KEY = 'versetools.admin.token';
const USERNAME_KEY = 'versetools.admin.username';
const MODE_KEY = 'versetools.admin.mode';

export type AdminMode = 'live' | 'ptu';

@Injectable({ providedIn: 'root' })
export class AdminService {
  private http = inject(HttpClient);
  private router = inject(Router);

  /** Current admin token, or null if not logged in. Persisted to localStorage. */
  readonly token = signal<string | null>(localStorage.getItem(TOKEN_KEY));
  readonly username = signal<string | null>(localStorage.getItem(USERNAME_KEY));
  readonly isAuthenticated = computed(() => !!this.token());

  /** Which dataset the admin is currently editing — live or ptu.
   *  Persisted to localStorage so it survives page reloads. */
  readonly mode = signal<AdminMode>(
    (localStorage.getItem(MODE_KEY) as AdminMode) || 'live'
  );

  setMode(mode: AdminMode): void {
    localStorage.setItem(MODE_KEY, mode);
    this.mode.set(mode);
  }

  private withMode(url: string): string {
    const m = this.mode();
    return `${url}${url.includes('?') ? '&' : '?'}mode=${m}`;
  }

  private authHeaders(): HttpHeaders {
    const t = this.token();
    return new HttpHeaders(t ? { Authorization: `Bearer ${t}` } : {});
  }

  async login(username: string, password: string, totp?: string): Promise<void> {
    const resp = await this.http
      .post<LoginResponse>('/api/admin/login', { username, password, totp: totp || undefined })
      .toPromise();
    if (!resp?.token) throw new Error('Login response missing token');
    localStorage.setItem(TOKEN_KEY, resp.token);
    localStorage.setItem(USERNAME_KEY, resp.username);
    this.token.set(resp.token);
    this.username.set(resp.username);
  }

  logout(): void {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USERNAME_KEY);
    this.token.set(null);
    this.username.set(null);
    this.router.navigate(['/admin/login']);
  }

  /** Verifies the current token is still valid against the server. */
  async verify(): Promise<boolean> {
    if (!this.token()) return false;
    try {
      await this.http
        .get('/api/admin/me', { headers: this.authHeaders() })
        .toPromise();
      return true;
    } catch {
      this.logout();
      return false;
    }
  }

  /** PATCH a ship's data — merges the provided fields into the JSONB blob.
   *  Targets the currently-selected admin mode (live or ptu). */
  async patchShip(className: string, patch: Record<string, unknown>): Promise<void> {
    await this.http
      .patch(this.withMode(`/api/admin/ships/${encodeURIComponent(className)}`), patch, {
        headers: this.authHeaders(),
      })
      .toPromise();
  }

  /** PATCH an item's data — same shape as patchShip. */
  async patchItem(className: string, patch: Record<string, unknown>): Promise<void> {
    await this.http
      .patch(this.withMode(`/api/admin/items/${encodeURIComponent(className)}`), patch, {
        headers: this.authHeaders(),
      })
      .toPromise();
  }

  /** Fetches the most recent audit log entries. */
  async getAudit(limit = 100): Promise<AuditEntry[]> {
    const resp = await this.http
      .get<{ entries: AuditEntry[] }>(`/api/admin/audit?limit=${limit}`, {
        headers: this.authHeaders(),
      })
      .toPromise();
    return resp?.entries ?? [];
  }

  /** Create a new ship. Body must include className. */
  async createShip(data: Record<string, unknown>): Promise<void> {
    await this.http
      .post(this.withMode('/api/admin/ships'), data, { headers: this.authHeaders() })
      .toPromise();
  }

  /** Create a new item. Body must include className. */
  async createItem(data: Record<string, unknown>): Promise<void> {
    await this.http
      .post(this.withMode('/api/admin/items'), data, { headers: this.authHeaders() })
      .toPromise();
  }

  /** Delete a ship. The full pre-delete blob is recorded in the audit log. */
  async deleteShip(className: string): Promise<void> {
    await this.http
      .delete(this.withMode(`/api/admin/ships/${encodeURIComponent(className)}`), {
        headers: this.authHeaders(),
      })
      .toPromise();
  }

  /** Delete an item. */
  async deleteItem(className: string): Promise<void> {
    await this.http
      .delete(this.withMode(`/api/admin/items/${encodeURIComponent(className)}`), {
        headers: this.authHeaders(),
      })
      .toPromise();
  }

  /** Mark a ship as curated without changing its data. Protects it
   *  from silent overwrites in future diff/import operations. */
  async curateShip(className: string): Promise<void> {
    await this.http
      .post(this.withMode(`/api/admin/ships/${encodeURIComponent(className)}/curate`), {}, {
        headers: this.authHeaders(),
      })
      .toPromise();
  }

  /** Mark an item as curated without changing its data. */
  async curateItem(className: string): Promise<void> {
    await this.http
      .post(this.withMode(`/api/admin/items/${encodeURIComponent(className)}/curate`), {}, {
        headers: this.authHeaders(),
      })
      .toPromise();
  }

  /** Compute a diff between an uploaded build payload and the current
   *  database. Accepts ships/items (versedb_data.json shape), the
   *  optional FPS triplet, and the optional missions pair — any mix
   *  is valid. Streams not present in the upload aren't proposed for
   *  deletes, so partial payloads never touch untouched streams. */
  async previewDiff(uploaded: any): Promise<DiffResult> {
    const resp = await this.http
      .post<DiffResult>(this.withMode('/api/admin/diff/preview'), uploaded, {
        headers: this.authHeaders(),
      })
      .toPromise();
    return resp ?? {
      ships: [], items: [], fpsItems: [], fpsGear: [], fpsArmor: [], missions: [],
      stats: { shipChanges: 0, itemChanges: 0 },
    };
  }

  /** Apply selected changes from a diff preview. Every registered
   *  stream (ships, items, fpsItems, fpsGear, fpsArmor, missions)
   *  commits inside one Postgres transaction. `missionRefs` is a
   *  singleton blob (factions, ladders, givers, etc.) applied like
   *  `meta` — wholesale overwrite when supplied, untouched otherwise. */
  async applyDiff(payload: {
    ships?: DiffApply[]; items?: DiffApply[];
    fpsItems?: DiffApply[]; fpsGear?: DiffApply[]; fpsArmor?: DiffApply[];
    missions?: DiffApply[];
    meta?: any; missionRefs?: any;
    fullShips?: any[]; fullItems?: any[];
    fullFpsItems?: any[]; fullFpsGear?: any[]; fullFpsArmor?: any[];
    fullMissions?: any[];
  }): Promise<{ applied: { ships: number; items: number; fpsItems?: number; fpsGear?: number; fpsArmor?: number; missions?: number; meta?: boolean; missionRefs?: boolean; changelog?: any } }> {
    const resp = await this.http
      .post<{ applied: { ships: number; items: number; fpsItems?: number; fpsGear?: number; fpsArmor?: number; missions?: number; meta?: boolean; missionRefs?: boolean; changelog?: any } }>(this.withMode('/api/admin/diff/apply'), payload, {
        headers: this.authHeaders(),
      })
      .toPromise();
    return resp ?? { applied: { ships: 0, items: 0 } };
  }

  /** Replace all PTU rows with the current LIVE rows. Used after a CIG
   *  patch goes LIVE so PTU restarts from a clean baseline. */
  async syncPtuFromLive(): Promise<{ shipsCopied: number; itemsCopied: number }> {
    const resp = await this.http
      .post<{ shipsCopied: number; itemsCopied: number }>('/api/admin/sync-ptu', {}, {
        headers: this.authHeaders(),
      })
      .toPromise();
    return resp ?? { shipsCopied: 0, itemsCopied: 0 };
  }

  /** Read the public site config (PTU toggle, label). */
  async getConfig(): Promise<{ ptuEnabled: boolean; ptuLabel: string }> {
    const resp = await this.http
      .get<{ ptuEnabled: boolean; ptuLabel: string }>('/api/config')
      .toPromise();
    return resp ?? { ptuEnabled: false, ptuLabel: '' };
  }

  /** Update the public site config. */
  async setConfig(cfg: { ptuEnabled?: boolean; ptuLabel?: string }): Promise<{ ptuEnabled: boolean; ptuLabel: string }> {
    const resp = await this.http
      .post<{ ptuEnabled: boolean; ptuLabel: string }>('/api/admin/config', cfg, {
        headers: this.authHeaders(),
      })
      .toPromise();
    return resp ?? { ptuEnabled: false, ptuLabel: '' };
  }

  // ─── Shop prices: UEX refresh ─────────────────────────────────────

  async refreshShopPrices(): Promise<ShopPriceRefreshSummary> {
    const resp = await this.http
      .post<{ ok: boolean; summary: ShopPriceRefreshSummary }>('/api/admin/shop-prices/refresh', {}, {
        headers: this.authHeaders(),
      })
      .toPromise();
    if (!resp?.summary) throw new Error('Refresh response missing summary');
    return resp.summary;
  }

  // ─── Ship wiki metadata: community-wiki refresh ──────────────────

  async refreshShipWiki(): Promise<ShipWikiRefreshSummary> {
    const resp = await this.http
      .post<{ ok: boolean; summary: ShipWikiRefreshSummary }>('/api/admin/ship-wiki/refresh', {}, {
        headers: this.authHeaders(),
      })
      .toPromise();
    if (!resp?.summary) throw new Error('Refresh response missing summary');
    return resp.summary;
  }

  // ─── Community submissions ────────────────────────────────────────

  async listAccelSubmissions(status: 'pending' | 'approved' | 'rejected' | 'all' = 'pending'): Promise<AccelSubmission[]> {
    const resp = await this.http
      .get<{ entries: AccelSubmission[] }>(`/api/admin/submissions/accel?status=${status}`, {
        headers: this.authHeaders(),
      })
      .toPromise();
    return resp?.entries ?? [];
  }

  async getPendingSubmissionCount(): Promise<number> {
    try {
      const resp = await this.http
        .get<{ pending: number }>('/api/admin/submissions/count', {
          headers: this.authHeaders(),
        })
        .toPromise();
      return resp?.pending ?? 0;
    } catch {
      return 0;
    }
  }

  async approveAccelSubmission(id: number, mode: 'live' | 'ptu' = 'live'): Promise<void> {
    await this.http
      .post(`/api/admin/submissions/accel/${id}/approve`, { mode }, {
        headers: this.authHeaders(),
      })
      .toPromise();
  }

  async rejectAccelSubmission(id: number, note?: string): Promise<void> {
    await this.http
      .post(`/api/admin/submissions/accel/${id}/reject`, { note: note ?? '' }, {
        headers: this.authHeaders(),
      })
      .toPromise();
  }

  // ─── Cooling observations ────────────────────────────────────────

  async listCoolingObservations(status = 'all'): Promise<CoolingObservation[]> {
    const resp = await this.http
      .get<{ observations: CoolingObservation[] }>(`/api/admin/cooling-observations?status=${status}`, {
        headers: this.authHeaders(),
      })
      .toPromise();
    return resp?.observations ?? [];
  }

  async createCoolingObservation(obs: Partial<CoolingObservation>): Promise<{ id: number }> {
    const resp = await this.http
      .post<{ id: number; ok: boolean }>('/api/admin/cooling-observations', obs, {
        headers: this.authHeaders(),
      })
      .toPromise();
    return { id: resp?.id ?? 0 };
  }

  async deleteCoolingObservation(id: number): Promise<void> {
    await this.http
      .delete(`/api/admin/cooling-observations/${id}`, {
        headers: this.authHeaders(),
      })
      .toPromise();
  }
}

export interface DiffChange {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

export interface DiffEntity {
  className: string;
  action: 'create' | 'modify' | 'delete';
  currentSource: 'extracted' | 'curated' | null;
  changes: DiffChange[];
}

export interface DiffResult {
  ships: DiffEntity[];
  items: DiffEntity[];
  // FPS + missions streams are optional — the API returns empty arrays
  // when the upload didn't include them, but every DiffResult carries
  // the keys so consumers can iterate a stable shape.
  fpsItems: DiffEntity[];
  fpsGear: DiffEntity[];
  fpsArmor: DiffEntity[];
  missions: DiffEntity[];
  stats: {
    shipChanges: number;
    itemChanges: number;
    fpsItemsChanges?: number;
    fpsGearChanges?: number;
    fpsArmorChanges?: number;
    missionsChanges?: number;
  };
}

/** Registry for the six diff streams — kept in one place so adding a
 *  new stream is a single-entry append. `kind` is the selection-map
 *  prefix ("ship:className", "fpsItem:className", …) and `payloadKey`
 *  is the API array name on both the preview request and apply payload. */
export const DIFF_STREAMS = [
  { kind: 'ship',     payloadKey: 'ships',    fullKey: 'fullShips',    label: 'Ships' },
  { kind: 'item',     payloadKey: 'items',    fullKey: 'fullItems',    label: 'Items' },
  { kind: 'fpsItem',  payloadKey: 'fpsItems', fullKey: 'fullFpsItems', label: 'FPS Items' },
  { kind: 'fpsGear',  payloadKey: 'fpsGear',  fullKey: 'fullFpsGear',  label: 'FPS Gear' },
  { kind: 'fpsArmor', payloadKey: 'fpsArmor', fullKey: 'fullFpsArmor', label: 'FPS Armor' },
  { kind: 'mission',  payloadKey: 'missions', fullKey: 'fullMissions', label: 'Missions' },
] as const;
export type DiffStreamKind = typeof DIFF_STREAMS[number]['kind'];

export interface DiffApply {
  className: string;
  action: 'create' | 'modify' | 'delete';
  /** For 'modify': either '*' (replace whole entity) or a list of field names. */
  fields?: string[] | '*';
  /** For 'create' and 'modify': the full uploaded blob. */
  data?: Record<string, unknown>;
}

export interface AuditEntry {
  id: number;
  user_name: string;
  action: string;
  entity_type: string;
  entity_key: string;
  entity_mode: string | null;
  field_name: string | null;
  old_value: string | null;
  new_value: string | null;
  created_at: string;
}

export interface ShopPriceRefreshSummary {
  shipsMatched: number;
  itemsMatched: number;
  shipPricesInserted: number;
  itemPricesInserted: number;
  priceChanges: number;
  priceAdded: number;
  priceRemoved: number;
  unmatchedShipNames: string[];
  unmatchedItemNames: string[];
  changelogEntryId: number;
}

export interface ShipWikiRefreshSummary {
  total: number;      // Vehicles the wiki API reports in total
  inserted: number;   // Rows written to ship_wiki_metadata
  matched: number;    // Rows whose normalized class_name matches a ship we carry
  unmatched: number;  // inserted - matched (stored but won't join)
  fetchedAt: string;
}

export interface AccelSubmission {
  id: number;
  ship_class_name: string;
  ship_name: string | null;
  submitter_name: string;
  accel_fwd: number | null;
  accel_ab_fwd: number | null;
  accel_retro: number | null;
  accel_ab_retro: number | null;
  accel_strafe: number | null;
  accel_ab_strafe: number | null;
  accel_up: number | null;
  accel_ab_up: number | null;
  accel_down: number | null;
  accel_ab_down: number | null;
  notes: string | null;
  status: 'pending' | 'approved' | 'rejected';
  reviewer_note: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  submitted_at: string;
}

export interface CoolingObservation {
  id: number;
  ship_class_name: string;
  shipClassName?: string;  // camelCase alias for POST body
  ship_name: string | null;
  shipName?: string;
  build_version: string;
  buildVersion?: string;
  pip_allocation: Record<string, number | string> | null;
  pipAllocation?: Record<string, number | string>;
  reported_cooling_pct: number;
  reportedCoolingPct?: number;
  reported_ir_value: number | null;
  reportedIrValue?: number;
  predicted_cooling_pct: number | null;
  predictedCoolingPct?: number;
  loadout_note: string | null;
  loadoutNote?: string;
  notes: string | null;
  submitter: string;
  status: string;
  submitted_at: string;
}
