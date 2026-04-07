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

  async login(username: string, password: string): Promise<void> {
    const resp = await this.http
      .post<LoginResponse>('/api/admin/login', { username, password })
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

  /** Compute a diff between an uploaded versedb_data.json blob and the
   *  current database (in the active admin mode). */
  async previewDiff(uploaded: any): Promise<DiffResult> {
    const resp = await this.http
      .post<DiffResult>(this.withMode('/api/admin/diff/preview'), uploaded, {
        headers: this.authHeaders(),
      })
      .toPromise();
    return resp ?? { ships: [], items: [], stats: { shipChanges: 0, itemChanges: 0 } };
  }

  /** Apply a set of selected changes from a diff preview. */
  async applyDiff(payload: { ships: DiffApply[]; items: DiffApply[] }): Promise<{ applied: { ships: number; items: number } }> {
    const resp = await this.http
      .post<{ applied: { ships: number; items: number } }>(this.withMode('/api/admin/diff/apply'), payload, {
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

  /** Convenience: returns whether the LIVE database currently differs
   *  from the PTU database in any way. Used by the dashboard to suggest
   *  enabling the PTU slider when there are real differences to show. */
  async hasPtuDifferences(): Promise<boolean> {
    const resp = await this.http
      .get<{ stats: { shipChanges: number; itemChanges: number } }>('/api/changelog')
      .toPromise();
    if (!resp) return false;
    return (resp.stats?.shipChanges ?? 0) + (resp.stats?.itemChanges ?? 0) > 0;
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
  stats: { shipChanges: number; itemChanges: number };
}

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
