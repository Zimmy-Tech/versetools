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

@Injectable({ providedIn: 'root' })
export class AdminService {
  private http = inject(HttpClient);
  private router = inject(Router);

  /** Current admin token, or null if not logged in. Persisted to localStorage. */
  readonly token = signal<string | null>(localStorage.getItem(TOKEN_KEY));
  readonly username = signal<string | null>(localStorage.getItem(USERNAME_KEY));
  readonly isAuthenticated = computed(() => !!this.token());

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

  /** PATCH a ship's data — merges the provided fields into the JSONB blob. */
  async patchShip(className: string, patch: Record<string, unknown>): Promise<void> {
    await this.http
      .patch(`/api/admin/ships/${encodeURIComponent(className)}`, patch, {
        headers: this.authHeaders(),
      })
      .toPromise();
  }

  /** PATCH an item's data — same shape as patchShip. */
  async patchItem(className: string, patch: Record<string, unknown>): Promise<void> {
    await this.http
      .patch(`/api/admin/items/${encodeURIComponent(className)}`, patch, {
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
}

export interface AuditEntry {
  id: number;
  user_name: string;
  action: string;
  entity_type: string;
  entity_key: string;
  field_name: string | null;
  old_value: string | null;
  new_value: string | null;
  created_at: string;
}
