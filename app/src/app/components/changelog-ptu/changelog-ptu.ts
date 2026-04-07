// Public PTU changelog: shows what's different in PTU vs LIVE.
// Reads from /api/changelog (no auth required) and groups changes by
// entity, then by field. No edit affordance — this is a read-only view
// for users who want to see what's coming in the next patch.

import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { DataService } from '../../services/data.service';

interface ChangelogChange {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

interface ChangelogEntity {
  className: string;
  action: 'create' | 'modify' | 'delete';
  changes: ChangelogChange[];
}

interface ChangelogResult {
  ships: ChangelogEntity[];
  items: ChangelogEntity[];
  stats: { shipChanges: number; itemChanges: number };
}

@Component({
  selector: 'app-changelog-ptu',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './changelog-ptu.html',
  styleUrl: './changelog-ptu.scss',
})
export class ChangelogPtuComponent {
  private http = inject(HttpClient);
  private data = inject(DataService);

  loading = signal(false);
  error = signal<string | null>(null);
  result = signal<ChangelogResult | null>(null);

  search = signal('');
  filterAction = signal<'all' | 'create' | 'modify' | 'delete'>('all');
  filterEntityType = signal<'all' | 'ships' | 'items'>('all');

  visibleShips = computed(() => this.applyFilters(this.result()?.ships ?? []));
  visibleItems = computed(() => this.applyFilters(this.result()?.items ?? []));

  constructor() {
    this.refresh();
  }

  private applyFilters(entities: ChangelogEntity[]): ChangelogEntity[] {
    const fa = this.filterAction();
    const fe = this.filterEntityType();
    const q = this.search().toLowerCase().trim();
    return entities.filter((e) => {
      if (fa !== 'all' && e.action !== fa) return false;
      if (q && !e.className.toLowerCase().includes(q) && !this.entityName(e).toLowerCase().includes(q)) return false;
      return true;
    });
  }

  /** Look up the human-readable name for the className from the loaded LIVE data. */
  entityName(e: ChangelogEntity): string {
    const db = this.data.db();
    if (!db) return e.className;
    const ship = db.ships.find((s) => s.className === e.className);
    if (ship?.name) return ship.name;
    const item = db.items.find((i) => i.className === e.className);
    if (item?.name) return item.name;
    return e.className;
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const r = await this.http.get<ChangelogResult>('/api/changelog').toPromise();
      this.result.set(r ?? null);
    } catch (err: any) {
      this.error.set(err?.error?.error || err?.message || 'Failed to load changelog');
    } finally {
      this.loading.set(false);
    }
  }

  formatValue(v: unknown): string {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'object') {
      const s = JSON.stringify(v);
      return s.length > 80 ? s.slice(0, 77) + '…' : s;
    }
    return String(v);
  }

  // Toggle which entity is expanded for full field view
  expanded = signal<Set<string>>(new Set());

  toggleExpand(key: string): void {
    this.expanded.update((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  isExpanded(key: string): boolean {
    return this.expanded().has(key);
  }
}
