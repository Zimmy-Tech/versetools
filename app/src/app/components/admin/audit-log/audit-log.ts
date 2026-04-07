import { Component, inject, signal } from '@angular/core';
import { AdminService, type AuditEntry } from '../admin.service';

@Component({
  selector: 'app-audit-log',
  standalone: true,
  imports: [],
  templateUrl: './audit-log.html',
  styleUrl: './audit-log.scss',
})
export class AuditLogComponent {
  private admin = inject(AdminService);

  entries = signal<AuditEntry[]>([]);
  loading = signal(false);
  error = signal<string | null>(null);

  constructor() {
    this.refresh();
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const entries = await this.admin.getAudit(200);
      this.entries.set(entries);
    } catch (err: any) {
      this.error.set(err?.error?.error || err?.message || 'Failed to load audit log');
    } finally {
      this.loading.set(false);
    }
  }

  formatDate(iso: string): string {
    return new Date(iso).toLocaleString();
  }

  formatValue(v: string | null): string {
    if (v == null || v === 'null') return '—';
    // Strip quotes from JSON-encoded primitives for readability
    if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
    return v;
  }
}
