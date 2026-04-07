import { Component, signal, computed, effect } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { DataService } from '../../services/data.service';

interface FieldDiff {
  field: string;
  old: number | string | null;
  new: number | string | null;
}

interface ChangeEntry {
  category: string;
  className: string;
  name: string;
  fields: FieldDiff[];
}

interface AddRemoveEntry {
  category: string;
  className: string;
  name: string;
}

interface ChangelogEntry {
  fromVersion: string;
  toVersion: string;
  date: string;
  changes: ChangeEntry[];
  added: AddRemoveEntry[];
  removed: AddRemoveEntry[];
}

interface ChangelogData {
  meta: { generatedAt: string; entries: number };
  changelog: ChangelogEntry[];
}

const CATEGORY_ORDER = ['ship', 'weapon', 'shield', 'powerplant', 'cooler', 'quantumdrive', 'radar', 'missile', 'missilelauncher', 'tractor'];
const CATEGORY_LABELS: Record<string, string> = {
  ship: 'Ships', weapon: 'Weapons', shield: 'Shields', powerplant: 'Power Plants',
  cooler: 'Coolers', quantumdrive: 'Quantum Drives', radar: 'Radar',
  missile: 'Missiles', missilelauncher: 'Missile Racks', tractor: 'Tractor Beams',
};

@Component({
  selector: 'app-changelog-view',
  standalone: true,
  templateUrl: './changelog-view.html',
  styleUrl: './changelog-view.scss',
})
export class ChangelogViewComponent {
  entries = signal<ChangelogEntry[]>([]);
  loaded = signal(false);
  selectedIdx = signal(0);

  selectedEntry = computed(() => this.entries()[this.selectedIdx()] ?? null);

  groupedChanges = computed(() => {
    const entry = this.selectedEntry();
    if (!entry) return [];
    const groups: Record<string, ChangeEntry[]> = {};
    for (const c of entry.changes) {
      (groups[c.category] ??= []).push(c);
    }
    return CATEGORY_ORDER
      .filter(cat => groups[cat]?.length)
      .map(cat => ({ category: cat, label: CATEGORY_LABELS[cat] ?? cat, items: groups[cat] }));
  });

  groupedAdded = computed(() => {
    const entry = this.selectedEntry();
    if (!entry?.added?.length) return [];
    const groups: Record<string, AddRemoveEntry[]> = {};
    for (const a of entry.added) (groups[a.category] ??= []).push(a);
    return CATEGORY_ORDER
      .filter(cat => groups[cat]?.length)
      .map(cat => ({ label: CATEGORY_LABELS[cat] ?? cat, items: groups[cat] }));
  });

  groupedRemoved = computed(() => {
    const entry = this.selectedEntry();
    if (!entry?.removed?.length) return [];
    const groups: Record<string, AddRemoveEntry[]> = {};
    for (const r of entry.removed) (groups[r.category] ??= []).push(r);
    return CATEGORY_ORDER
      .filter(cat => groups[cat]?.length)
      .map(cat => ({ label: CATEGORY_LABELS[cat] ?? cat, items: groups[cat] }));
  });

  totalChanges = computed(() => {
    const e = this.selectedEntry();
    return e ? e.changes.length + (e.added?.length ?? 0) + (e.removed?.length ?? 0) : 0;
  });

  constructor(private http: HttpClient, private data: DataService) {
    // Prefer the API (database-backed, populated by admin imports) and
    // fall back to the bundled JSON for hosts without an API (GitHub
    // Pages mirror) or if the API call fails for any reason.
    const isStaticHost =
      typeof window !== 'undefined' &&
      /github\.io$/i.test(window.location.hostname);
    effect(() => {
      const prefix = this.data.dataPrefix();
      this.data.modeVersion(); // track mode changes
      this.loaded.set(false);
      const fallbackUrl = `${prefix}versedb_changelog.json`;
      const apply = (data: ChangelogData) => {
        this.entries.set(data.changelog);
        this.loaded.set(true);
      };
      if (isStaticHost) {
        this.http.get<ChangelogData>(fallbackUrl).subscribe({
          next: apply,
          error: () => this.loaded.set(true),
        });
      } else {
        this.http.get<ChangelogData>('/api/changelog/history').subscribe({
          next: apply,
          error: () => {
            this.http.get<ChangelogData>(fallbackUrl).subscribe({
              next: apply,
              error: () => this.loaded.set(true),
            });
          },
        });
      }
    });
  }

  fmtVal(v: number | string | null | undefined): string {
    if (v == null) return '—';
    if (typeof v === 'number') return v % 1 === 0 ? v.toString() : v.toFixed(2);
    return v;
  }

  isNerfed(d: FieldDiff): boolean {
    if (d.old == null || d.new == null) return false;
    if (typeof d.old === 'number' && typeof d.new === 'number') return d.new < d.old;
    return false;
  }

  isBuffed(d: FieldDiff): boolean {
    if (d.old == null || d.new == null) return false;
    if (typeof d.old === 'number' && typeof d.new === 'number') return d.new > d.old;
    return false;
  }

  fmtField(field: string): string {
    return field
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, s => s.toUpperCase())
      .replace('Dps', 'DPS')
      .replace('Hp', 'HP')
      .replace('Em ', 'EM ')
      .trim();
  }
}
