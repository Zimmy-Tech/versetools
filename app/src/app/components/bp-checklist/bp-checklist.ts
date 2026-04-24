import { Component, computed, effect, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { DataService } from '../../services/data.service';

/** Minimal mission shape we need — only the fields used for pool
 *  derivation. Matches the Mission interface in missions-view.ts but
 *  kept local to avoid a cross-component import. */
interface MissionLite {
  className: string;
  blueprintRewards?: string[];
}

interface PoolGroup {
  key: string;          // stable sorted-join of blueprint names
  blueprints: string[]; // alphabetical order
  missionCount: number; // how many missions award this pool (UI flavor)
}

/** localStorage key for the acquired-blueprint set. Same convention as
 *  other versetools_* keys in the app (saved loadouts, craft search,
 *  etc.). */
const STORAGE_KEY = 'versetools_bp_checklist';

@Component({
  selector: 'app-bp-checklist',
  standalone: true,
  templateUrl: './bp-checklist.html',
  styleUrl: './bp-checklist.scss',
})
export class BpChecklistComponent {
  loaded = signal(false);
  allMissions = signal<MissionLite[]>([]);
  searchQuery = signal('');

  /** Acquired-blueprint set. Mutated via toggleOwned/setAllOwned and
   *  mirrored to localStorage inside writeStorage() so refreshes,
   *  new tabs, and browser restarts preserve the checklist. */
  owned = signal<ReadonlySet<string>>(this.readStorage());

  constructor(private http: HttpClient, private data: DataService) {
    // DB-first hydration (prod path) mirrors missions-view / blueprint-finder.
    effect(() => {
      const db = this.data.db();
      const contracts = db?.missions as MissionLite[] | undefined;
      if (contracts?.length) {
        this.allMissions.set(contracts);
        this.loaded.set(true);
      }
    });
    // JSON fallback for preview / static host.
    effect(() => {
      const prefix = this.data.dataPrefix();
      this.data.modeVersion(); // track mode changes
      if (this.loaded()) return;
      this.http.get<any>(`${prefix}versedb_missions.json`).subscribe({
        next: (d) => {
          if (this.loaded()) return;
          this.allMissions.set((d.contracts ?? d.missions ?? []) as MissionLite[]);
          this.loaded.set(true);
        },
        error: () => this.loaded.set(true),
      });
    });
  }

  // ── Pool derivation ───────────────────────────────────────────────
  // Group missions by their sorted blueprintRewards tuple. Pools with
  // new blueprints (or entirely new pools) surface automatically on the
  // next data refresh — nothing is hardcoded.
  readonly pools = computed<PoolGroup[]>(() => {
    const groups = new Map<string, { missions: number; blueprints: string[] }>();
    for (const m of this.allMissions()) {
      const bps = m.blueprintRewards ?? [];
      if (!bps.length) continue;
      const key = [...bps].sort().join('|');
      const g = groups.get(key);
      if (g) g.missions++;
      else groups.set(key, { missions: 1, blueprints: [...bps].sort() });
    }
    const out: PoolGroup[] = [];
    for (const [key, g] of groups) {
      out.push({ key, blueprints: g.blueprints, missionCount: g.missions });
    }
    // Bigger pools first (most content), ties broken by first blueprint
    // name. Keeps visual ordering stable across data updates.
    out.sort((a, b) => b.blueprints.length - a.blueprints.length
      || a.blueprints[0].localeCompare(b.blueprints[0]));
    return out;
  });

  /** Pools filtered by the search query — matches ANY blueprint name in
   *  the pool (case-insensitive substring). Empty query → all pools. */
  readonly filteredPools = computed(() => {
    const q = this.searchQuery().trim().toLowerCase();
    const all = this.pools();
    if (!q) return all;
    return all.filter(p => p.blueprints.some(bp => bp.toLowerCase().includes(q)));
  });

  /** Flat set of every unique blueprint across every pool. Used for the
   *  overall progress counter; also the authoritative membership check
   *  if we ever need to prune owned entries that CIG removed. */
  readonly allBlueprints = computed<string[]>(() => {
    const seen = new Set<string>();
    for (const p of this.pools()) for (const bp of p.blueprints) seen.add(bp);
    return [...seen].sort();
  });

  readonly totalOwned = computed(() => {
    // Only count blueprints that still exist in the current data set —
    // so a CIG-removed blueprint lingering in localStorage doesn't
    // inflate the total.
    const active = new Set(this.allBlueprints());
    return [...this.owned()].filter(bp => active.has(bp)).length;
  });

  readonly totalAll = computed(() => this.allBlueprints().length);

  readonly percentOwned = computed(() => {
    const total = this.totalAll();
    return total === 0 ? 0 : Math.round((this.totalOwned() / total) * 100);
  });

  // Per-pool owned count (used on the pool card header).
  ownedInPool(p: PoolGroup): number {
    const o = this.owned();
    let n = 0;
    for (const bp of p.blueprints) if (o.has(bp)) n++;
    return n;
  }

  // ── Mutations ─────────────────────────────────────────────────────
  toggleOwned(bp: string): void {
    const next = new Set(this.owned());
    if (next.has(bp)) next.delete(bp);
    else next.add(bp);
    this.owned.set(next);
    this.writeStorage(next);
  }

  setPoolOwned(p: PoolGroup, checked: boolean): void {
    const next = new Set(this.owned());
    for (const bp of p.blueprints) {
      if (checked) next.add(bp);
      else next.delete(bp);
    }
    this.owned.set(next);
    this.writeStorage(next);
  }

  clearAll(): void {
    if (!confirm('Clear every checked blueprint? This cannot be undone.')) return;
    this.owned.set(new Set());
    this.writeStorage(new Set());
  }

  bpMatches(bp: string): boolean {
    const q = this.searchQuery().trim().toLowerCase();
    return q.length > 0 && bp.toLowerCase().includes(q);
  }

  // ── localStorage plumbing ─────────────────────────────────────────
  private readStorage(): ReadonlySet<string> {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return new Set();
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return new Set();
      return new Set(arr.filter((x): x is string => typeof x === 'string'));
    } catch {
      return new Set();
    }
  }

  private writeStorage(s: ReadonlySet<string>): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...s]));
    } catch (e) {
      // Quota exceeded or storage disabled (incognito in some browsers).
      // Nothing actionable from here — the in-memory signal is still
      // authoritative for the current session.
      console.warn('[bp-checklist] localStorage write failed:', e);
    }
  }
}
