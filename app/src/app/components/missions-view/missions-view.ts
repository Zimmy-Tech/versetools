import { Component, signal, computed, effect, HostListener, ElementRef, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { DecimalPipe } from '@angular/common';
import { DataService } from '../../services/data.service';

interface Mission {
  className: string;
  title: string;
  category: string;
  reward: number;
  currency: string;
  lawful: boolean;
  difficulty: number;
  maxPlayers: number;
  canShare: boolean;
  description?: string;
  giver?: string;
  lifetimeMin?: number;
  respawnMin?: number;
  cooldownMin?: number;
  abandonCooldownMin?: number;
  timeLimitMin?: number;
  missionFlow?: string[];
  onceOnly?: boolean;
  prison?: boolean;
  repScopes?: string[];
  multiSystem?: boolean;
  generator?: string;
  repRequirements?: { scope: string; minRank: string; maxRank: string }[];
  system?: string;
  /** Set when the same mission appears in multiple systems. Includes the primary
   *  `system` value. Used for filter predicates and display. */
  systems?: string[];
  givers?: string[];
  /** Sub-region letter (e.g. Pyro "A"/"B"/"C"/"D") — CIG-internal, kept for
   *  data fidelity but not surfaced to players. Multiple entries with the same
   *  title/reward can exist when blueprint reward pools differ by region. */
  region?: string;
  regions?: string[];
  /** Human-readable planet list for the region(s) this mission draws from
   *  (e.g. ['Pyro I', 'Pyro II']). Derived from the MissionLocality → starmap
   *  mapping in the extractor. Use this for display, not the raw region letter. */
  regionPlanets?: string[];
  /** Live event this contract is gated behind (empty if always-available).
   *  `eventActive=false` means the scenario is currently disabled — contract
   *  exists in data but won't spawn in-game until CIG turns the event on. */
  event?: string;
  eventActive?: boolean;
  activity?: string;
  blueprintRewards?: string[];
  repReward?: number;
  repPenalty?: number;
  boss?: boolean;
  contractor?: string;
  /** Location names this contract can trigger/spawn at, resolved from
   *  `localityAvailable` GUIDs to starmap/missionlocality names at extract
   *  time. Useful signal that system-variant splits carry genuinely
   *  different spawn sets — Stanton Super triggers at the 4 Stanton planets
   *  while Pyro Super triggers at the 4 Pyro regions, for example. */
  triggerLocations?: string[];
  /** Drill-down expansion of `triggerLocations`: each group is one parent
   *  MissionLocality and `locations` are the specific starmap callsigns
   *  it covers (asteroid belt markers like "RAB-WHISKEY", Lagrange points,
   *  planets). Collapsed behind a toggle in the UI because big contracts
   *  carry 90+ entries. */
  triggerLocationDetails?: { group: string; locations: string[] }[];
  danger?: string;
  enemyPool?: string[];
  requiresCompletion?: string[];
  /** OR groups: complete *any* mission in each inner array to satisfy that
   *  gate. Rendered as "complete any one of" groups, distinct from the
   *  strict AND list in `requiresCompletion`. Each alt carries the union of
   *  systems its title is available in — the tag-granter system is global
   *  so cross-system completions technically satisfy the gate, but surfacing
   *  the system lets players pick a reachable variant. */
  requiresAnyOf?: { title: string; systems: string[] }[][];
  unlocks?: string[];
  isChain?: boolean;
  rewardEstimated?: boolean;
}

interface MissionGiver {
  name: string;
  description: string;
  headquarters: string;
}

interface RepRank {
  name: string;
  minRep: number;
  gated?: boolean;
  perk?: string;
  driftPerHour?: number;
}

interface CalcRow {
  name: string;
  minRep: number;
  xpToFill: number;
  missions: number | null;
  active: boolean;
  gated: boolean;
  perk?: string;
}

interface RepLadder {
  name: string;
  displayName: string;
  ceiling: number;
  ranks: RepRank[];
}

interface ContractorProfile {
  name: string;
  description?: string;
  area?: string;
  focus?: string;
  founded?: string;
  hq?: string;
  leadership?: string;
  association?: string;
}

interface MissionData {
  meta: { totalContracts: number; categories: Record<string, number>; missionGivers: number };
  missionGivers: Record<string, MissionGiver>;
  reputationLadders?: Record<string, RepLadder>;
  scopeToLadder?: Record<string, string>;
  contractorProfiles?: Record<string, ContractorProfile>;
  contracts: Mission[];
  missions?: Mission[];  // legacy fallback
}

@Component({
  selector: 'app-missions-view',
  standalone: true,
  imports: [DecimalPipe],
  templateUrl: './missions-view.html',
  styleUrl: './missions-view.scss',
})
export class MissionsViewComponent {
  allMissions = signal<Mission[]>([]);
  private missionGivers = signal<Record<string, MissionGiver>>({});
  private repLadders = signal<Record<string, RepLadder>>({});
  private scopeToLadder = signal<Record<string, string>>({});
  loaded = signal(false);

  searchQuery = signal('');
  categoryFilter = signal('');
  lawfulFilter = signal<'' | 'lawful' | 'unlawful'>('');
  systemFilter = signal('');
  activityFilter = signal('');
  contractorFilter = signal('');
  /** Rep-gate filter. Scope key from `repRequirements[].scope`, or '' for any,
   *  or '__none__' for "no rep gate" (contracts with no repRequirements). */
  factionFilter = signal<string>('');
  /** Rank name within the current faction's ladder. '' = any rank in that
   *  faction. Automatically cleared when `factionFilter` changes to a scope
   *  with a different ladder (picked in `pickFaction`). */
  rankFilter = signal<string>('');
  factionOpen = signal(false);
  rankOpen = signal(false);
  categoryOpen = signal(false);
  systemOpen = signal(false);
  activityOpen = signal(false);
  riskFilter = signal<'' | 'low' | 'med' | 'high'>('');
  /** Event filter. '__all__' = default, show events + main; '' = main only;
   *  any specific event name = show only that event. */
  eventFilter = signal<string>('__all__');
  /** Per-event opt-out exclusion. When the dropdown is at default
   *  ("All events + main"), events present in this set are *removed* from
   *  the merged view — letting users hide a noisy live-ops event without
   *  losing the rest of the data. Independent of the dropdown's
   *  "show only" semantics. */
  excludedEvents = signal<ReadonlySet<string>>(new Set());
  /** Whether the exclude-events panel is expanded. */
  excludeEventsOpen = signal(false);
  sortBy = signal<'reward' | 'title' | 'category' | 'system' | 'rep' | 'chain' | 'faction' | 'type'>('reward');
  /** Sort direction toggles when the user clicks the same column header
   *  twice. Defaults chosen per field in `setSort()` so the first click
   *  feels natural (numeric fields start desc, text fields asc). */
  sortDir = signal<'asc' | 'desc'>('desc');
  blueprintFilter = signal(false);
  chainFilter = signal(false);
  blueprintNameFilter = signal('');
  /** Filter by blueprint-reward pool signature. Pools are identified by the
   *  sorted tuple of blueprint names (CIG doesn't model pools as a data
   *  entity — identity is derived from the rewards set). Empty = no filter. */
  blueprintPoolFilter = signal('');
  page = signal(1);
  readonly pageSize = 50;
  /** Drawer open/closed on narrow viewports. Ignored at wide viewports where
   *  the sidebar is always visible. Default closed so first paint on mobile
   *  shows the list, not the filters. */
  filtersOpen = signal(false);

  /** Three-tier risk from the raw `danger` string.
   *  low: Very Low / Low  ·  med: Medium  ·  high: High / Very High / Extreme
   *  Anything else (incl. undefined) is 'none'. */
  riskTier(m: Mission): 'low' | 'med' | 'high' | 'none' {
    const d = (m.danger ?? '').toLowerCase();
    if (d === 'very low' || d === 'low') return 'low';
    if (d === 'medium') return 'med';
    if (d === 'high' || d === 'very high' || d === 'extreme') return 'high';
    return 'none';
  }

  categories = computed(() => {
    const cats = new Set(this.allMissions().map(m => m.category));
    return ['', ...Array.from(cats).sort()];
  });

  systems = computed(() => {
    const sys = new Set<string>();
    for (const m of this.allMissions()) {
      if (m.systems?.length) for (const s of m.systems) sys.add(s);
      else if (m.system) sys.add(m.system);
    }
    return ['', ...Array.from(sys).sort()];
  });

  activities = computed(() => {
    const act = new Set(this.allMissions().map(m => m.activity).filter(Boolean));
    return ['', ...Array.from(act).sort()];
  });

  contractors = computed(() => {
    const ct = new Set(this.allMissions().map(m => m.contractor).filter(Boolean));
    return ['', ...Array.from(ct).sort()];
  });

  /** Events present in the dataset. Each entry carries its active state so the
   *  dropdown can dim dormant events. Sorted: active first, then alphabetical. */
  readonly events = computed(() => {
    const byName = new Map<string, boolean>();  // event → active
    for (const m of this.allMissions()) {
      if (!m.event) continue;
      const prev = byName.get(m.event);
      // If any row says active, treat the event as active.
      if (prev === undefined || (!prev && m.eventActive)) {
        byName.set(m.event, !!m.eventActive);
      }
    }
    const list = Array.from(byName.entries());
    list.sort((a, b) => (Number(b[1]) - Number(a[1])) || a[0].localeCompare(b[0]));
    return list;
  });

  blueprintNames = computed(() => {
    const names = new Set<string>();
    for (const m of this.allMissions()) {
      for (const bp of m.blueprintRewards ?? []) names.add(bp);
    }
    return ['', ...Array.from(names).sort()];
  });

  /** Pool signature = sorted, pipe-joined blueprint names. Stable across
   *  missions so any two missions with the same reward set produce the
   *  same key. Empty rewards → empty string (excluded from filters). */
  bpPoolKey(m: Mission): string {
    const bps = m.blueprintRewards ?? [];
    if (!bps.length) return '';
    return [...bps].sort().join('|');
  }

  /** Distinct pools that are shared by 2+ missions. Single-mission pools
   *  exist but have no filtering value in a list that shows them already.
   *  Sorted by mission count desc, then first-blueprint asc.
   *  `blueprints` carries the full sorted list — consumed by the grid
   *  picker so users can scan all pool contents at a glance. */
  readonly blueprintPools = computed<{ key: string; label: string; missionCount: number; bpCount: number; blueprints: string[] }[]>(() => {
    const groups = new Map<string, { missions: number; blueprints: string[] }>();
    for (const m of this.allMissions()) {
      const key = this.bpPoolKey(m);
      if (!key) continue;
      const g = groups.get(key);
      if (g) g.missions++;
      else groups.set(key, { missions: 1, blueprints: [...(m.blueprintRewards ?? [])].sort() });
    }
    const result: { key: string; label: string; missionCount: number; bpCount: number; blueprints: string[] }[] = [];
    for (const [key, g] of groups) {
      // Include every pool (even 1-mission ones). Previously gated on
      // >=2 missions, but that hid ~13 single-mission pools — users had
      // no way to discover them without stumbling onto the one mission
      // that awards them. The grid picker is browsable, so extra rows
      // are fine; the BP Checklist page also shows this full set for
      // consistency.
      const first = g.blueprints[0] ?? '';
      const extra = g.blueprints.length - 1;
      const label = extra > 0
        ? `${first} +${extra} (${g.missions})`
        : `${first} (${g.missions})`;
      result.push({ key, label, missionCount: g.missions, bpCount: g.blueprints.length, blueprints: g.blueprints });
    }
    result.sort((a, b) => b.missionCount - a.missionCount || a.label.localeCompare(b.label));
    return result;
  });

  /** Grid-picker state for the Blueprint Pool filter. Modal-style UI
   *  that renders every pool as a card with all its blueprints visible,
   *  so users can find pools by any member name (the old dropdown only
   *  showed the alphabetically-first blueprint). */
  bpPickerOpen = signal(false);
  bpPickerSearch = signal('');

  openBpPicker(): void { this.bpPickerOpen.set(true); this.bpPickerSearch.set(''); }
  closeBpPicker(): void { this.bpPickerOpen.set(false); }
  pickBpPool(key: string): void {
    this.blueprintPoolFilter.set(key);
    this.closeBpPicker();
    this.resetPage();
  }

  /** Pools filtered by the search query — matches pool label OR any
   *  blueprint name in the pool. Empty query returns all pools. */
  readonly filteredBpPools = computed(() => {
    const q = this.bpPickerSearch().trim().toLowerCase();
    const all = this.blueprintPools();
    if (!q) return all;
    return all.filter(p =>
      p.label.toLowerCase().includes(q) ||
      p.blueprints.some(bp => bp.toLowerCase().includes(q))
    );
  });

  /** Label shown on the closed trigger button for the current selection. */
  readonly currentBpPoolLabel = computed(() => {
    const k = this.blueprintPoolFilter();
    if (!k) return 'All pools';
    const match = this.blueprintPools().find(p => p.key === k);
    return match ? match.label : 'All pools';
  });

  /** Case-insensitive substring check used by the card chips to highlight
   *  blueprints that match the current picker search. */
  bpChipMatches(bp: string): boolean {
    const q = this.bpPickerSearch().trim().toLowerCase();
    return q.length > 0 && bp.toLowerCase().includes(q);
  }

  /** Mission count for the active pool filter — used to gate the "filter
   *  by this pool" button in the expanded detail so it only appears when
   *  the current mission actually shares a pool with others. */
  bpPoolMissionCount(m: Mission): number {
    const key = this.bpPoolKey(m);
    if (!key) return 0;
    return this.allMissions().filter(x => this.bpPoolKey(x) === key).length;
  }

  hasActiveFilter = computed(() => {
    return this.searchQuery().length >= 2 || this.categoryFilter() !== '' ||
           this.lawfulFilter() !== '' || this.systemFilter() !== '' ||
           this.activityFilter() !== '' || this.contractorFilter() !== '' ||
           this.factionFilter() !== '' || this.rankFilter() !== '' ||
           this.riskFilter() !== '' || this.eventFilter() !== '__all__' ||
           this.excludedEvents().size > 0 ||
           this.blueprintFilter() || this.chainFilter() ||
           this.blueprintNameFilter() !== '' || this.blueprintPoolFilter() !== '';
  });

  /** Scopes that actually appear in some contract's `repRequirements`, with
   *  hidden ladders removed. Built once per data load via the
   *  `allMissions` signal and rendered as the Faction dropdown options. */
  factionOptions = computed<{ scope: string; label: string }[]>(() => {
    const stl = this.scopeToLadder();
    const hidden = this.LADDER_HIDDEN;
    const seen = new Set<string>();
    for (const m of this.allMissions()) {
      for (const r of m.repRequirements ?? []) {
        const scope = r.scope;
        if (!scope || scope === '?') continue;
        const ladderKey = stl[scope] ?? stl[scope.toLowerCase()] ?? scope.toLowerCase();
        if (hidden.has(ladderKey)) continue;
        seen.add(scope);
      }
    }
    return Array.from(seen)
      .map(scope => ({ scope, label: this.fmtScope(scope) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  });

  /** Ladder behind the currently-selected faction scope. Null for "any" and
   *  the synthetic "no rep gate" bucket, which have no rank axis. */
  factionLadder = computed<RepLadder | null>(() => {
    const scope = this.factionFilter();
    if (!scope || scope === '__none__') return null;
    const stl = this.scopeToLadder();
    const ladderKey = stl[scope] ?? stl[scope.toLowerCase()] ?? scope.toLowerCase();
    return this.repLadders()[ladderKey] ?? null;
  });

  /** Rank names (low → high) for the selected faction's ladder. Excludes
   *  negative-minRep "hostile" sentinels that `calcLadder` also filters
   *  so the dropdown list matches what the rep table shows. */
  rankOptions = computed<string[]>(() => {
    const ladder = this.factionLadder();
    if (!ladder) return [];
    return ladder.ranks.filter(r => r.minRep >= 0).map(r => r.name);
  });

  /** Pill list for the "Applied" strip. Each entry has a label for display
   *  and a key that `removeFilter()` uses to clear just that one. */
  appliedFilters = computed<{ key: string; label: string }[]>(() => {
    const out: { key: string; label: string }[] = [];
    if (this.searchQuery().length >= 2) out.push({ key: 'search', label: `"${this.searchQuery()}"` });
    if (this.categoryFilter()) out.push({ key: 'category', label: this.categoryFilter() });
    if (this.riskFilter()) out.push({ key: 'risk', label: 'Risk ' + this.riskFilter().toUpperCase() });
    if (this.lawfulFilter()) out.push({ key: 'lawful', label: this.lawfulFilter() === 'lawful' ? 'Legal' : 'Illegal' });
    if (this.systemFilter()) out.push({ key: 'system', label: this.systemFilter() });
    if (this.activityFilter()) out.push({ key: 'activity', label: this.activityFilter() });
    if (this.contractorFilter()) out.push({ key: 'contractor', label: this.contractorFilter() });
    if (this.factionFilter() === '__none__') {
      out.push({ key: 'faction', label: 'No rep gate' });
    } else if (this.factionFilter()) {
      const base = this.fmtScope(this.factionFilter());
      const label = this.rankFilter() ? `${base} @ ${this.rankFilter()}` : base;
      out.push({ key: 'faction', label });
    }
    if (this.eventFilter() === '') out.push({ key: 'event', label: 'Main only' });
    else if (this.eventFilter() !== '__all__') out.push({ key: 'event', label: 'Event: ' + this.eventFilter() });
    if (this.excludedEvents().size > 0 && this.eventFilter() === '__all__') {
      out.push({ key: 'excludedEvents', label: `−${this.excludedEvents().size} event` + (this.excludedEvents().size === 1 ? '' : 's') });
    }
    if (this.blueprintFilter()) out.push({ key: 'blueprint', label: 'Blueprints' });
    if (this.chainFilter()) out.push({ key: 'chain', label: 'Chains' });
    if (this.blueprintNameFilter()) out.push({ key: 'bpname', label: this.blueprintNameFilter() });
    if (this.blueprintPoolFilter()) {
      const pool = this.blueprintPools().find(p => p.key === this.blueprintPoolFilter());
      out.push({ key: 'bppool', label: 'Pool: ' + (pool?.label ?? 'Custom') });
    }
    return out;
  });

  /** Toggle one event into/out of the exclusion set. Used by the per-event
   *  checkbox list in the sidebar (when the dropdown is at the All default). */
  toggleExcludedEvent(name: string): void {
    const next = new Set(this.excludedEvents());
    if (next.has(name)) next.delete(name);
    else next.add(name);
    this.excludedEvents.set(next);
    this.resetPage();
  }

  /** Bulk toggle: exclude every event / clear all exclusions. */
  setAllExcludedEvents(checked: boolean): void {
    this.excludedEvents.set(checked ? new Set(this.events().map(e => e[0])) : new Set());
    this.resetPage();
  }

  removeFilter(key: string): void {
    switch (key) {
      case 'search': this.searchQuery.set(''); break;
      case 'category': this.categoryFilter.set(''); break;
      case 'risk': this.riskFilter.set(''); break;
      case 'lawful': this.lawfulFilter.set(''); break;
      case 'system': this.systemFilter.set(''); break;
      case 'activity': this.activityFilter.set(''); break;
      case 'contractor': this.contractorFilter.set(''); break;
      case 'faction': this.factionFilter.set(''); this.rankFilter.set(''); break;
      case 'event': this.eventFilter.set('__all__'); break;
      case 'excludedEvents': this.excludedEvents.set(new Set()); break;
      case 'blueprint': this.blueprintFilter.set(false); break;
      case 'chain': this.chainFilter.set(false); break;
      case 'bpname': this.blueprintNameFilter.set(''); break;
      case 'bppool': this.blueprintPoolFilter.set(''); break;
    }
    this.resetPage();
  }

  /** Set (or toggle off) the blueprint pool filter to a specific mission's
   *  pool. Clears every other filter (search, event default, system, etc.)
   *  so the pool is the only thing narrowing the list — otherwise the
   *  search box or event gate silently drops pool members and the button's
   *  promised count won't match what appears. */
  filterByMissionPool(m: Mission): void {
    const key = this.bpPoolKey(m);
    if (!key) return;
    const already = this.blueprintPoolFilter() === key;
    if (already) {
      this.blueprintPoolFilter.set('');
    } else {
      this.blueprintPoolFilter.set(key);
      // Open the scope wide so every pool member is visible.
      this.searchQuery.set('');
      this.eventFilter.set('__all__');
      this.categoryFilter.set('');
      this.systemFilter.set('');
      this.activityFilter.set('');
      this.contractorFilter.set('');
      this.riskFilter.set('');
      this.lawfulFilter.set('');
      this.blueprintFilter.set(false);
      this.chainFilter.set(false);
      this.blueprintNameFilter.set('');
    }
    this.resetPage();
  }

  private allFiltered = computed(() => {
    // Title-only search with word-boundary prefix matching. The previous
    // substring search across title + description + giver + category
    // produced massive false-positive counts for short queries (e.g. "king"
    // returned 627 hits because it's a substring of looking/taking/seeking/
    // making/etc.). Narrative text is no longer indexed — category / system /
    // activity / contractor all have dedicated dropdown filters.
    const q = this.searchQuery().toLowerCase().trim();
    const titleRx = q
      ? new RegExp('\\b' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      : null;
    const cat = this.categoryFilter();
    const law = this.lawfulFilter();
    const sys = this.systemFilter();
    const act = this.activityFilter();
    const ct = this.contractorFilter();
    const bp = this.blueprintFilter();
    const chain = this.chainFilter();
    const bpName = this.blueprintNameFilter();
    const sort = this.sortBy();

    let missions = this.allMissions();

    const risk = this.riskFilter();

    if (cat) missions = missions.filter(m => m.category === cat);
    if (law === 'lawful') missions = missions.filter(m => m.lawful);
    if (law === 'unlawful') missions = missions.filter(m => !m.lawful);
    // Event filter: dropdown takes priority. When dropdown is at the
    // "All events + main" default, the per-event exclusion set lets users
    // hide specific noisy events without losing the rest.
    const ev = this.eventFilter();
    if (ev === '') {
      missions = missions.filter(m => !m.event);
    } else if (ev === '__all__') {
      const exc = this.excludedEvents();
      if (exc.size) missions = missions.filter(m => !m.event || !exc.has(m.event));
    } else {
      missions = missions.filter(m => m.event === ev);
    }
    if (sys) missions = missions.filter(m =>
      (m.systems?.length ? m.systems.includes(sys) : m.system === sys)
    );
    if (act) missions = missions.filter(m => m.activity === act);
    if (risk) missions = missions.filter(m => this.riskTier(m) === risk);
    if (bpName) missions = missions.filter(m => m.blueprintRewards?.includes(bpName));
    else if (bp) missions = missions.filter(m => m.blueprintRewards?.length);
    const pool = this.blueprintPoolFilter();
    if (pool) missions = missions.filter(m => this.bpPoolKey(m) === pool);
    if (chain) missions = missions.filter(m => m.isChain);
    if (ct) missions = missions.filter(m => m.contractor === ct);
    const faction = this.factionFilter();
    if (faction === '__none__') {
      missions = missions.filter(m => !m.repRequirements?.length);
    } else if (faction) {
      const ladder = this.factionLadder();
      const rank = this.rankFilter();
      const rankIdx = ladder && rank ? ladder.ranks.findIndex(r => r.name === rank) : -1;
      missions = missions.filter(m => {
        const reqs = m.repRequirements ?? [];
        for (const req of reqs) {
          if (req.scope !== faction) continue;
          if (!rank || !ladder) return true;
          // Rank-gated: "what's available at my current rep" — my rank must
          // fall within the contract's [minRank, maxRank] window. maxRank is
          // usually the same as minRank (single-rank gate) but can widen for
          // contracts that stay available across several ranks.
          const minIdx = ladder.ranks.findIndex(r => r.name === req.minRank);
          const maxIdx = ladder.ranks.findIndex(r => r.name === req.maxRank);
          if (rankIdx >= 0 && minIdx >= 0 && maxIdx >= 0 &&
              rankIdx >= minIdx && rankIdx <= maxIdx) return true;
        }
        return false;
      });
    }
    if (titleRx) missions = missions.filter(m => titleRx.test(m.title ?? ''));

    const dir = this.sortDir();
    const sign = dir === 'asc' ? 1 : -1;
    const systemKey = (m: Mission) => (m.systems?.length ? m.systems[0] : m.system) ?? '';
    const byNumber = (a: number, b: number) => (a - b) * sign;
    const byString = (a: string, b: string) => a.localeCompare(b) * sign;
    missions = [...missions].sort((a, b) => {
      if (sort === 'reward') return byNumber(a.reward ?? 0, b.reward ?? 0);
      if (sort === 'rep')    return byNumber(a.repReward ?? 0, b.repReward ?? 0);
      if (sort === 'title')  return byString(a.title ?? '', b.title ?? '');
      if (sort === 'system') return byString(systemKey(a), systemKey(b)) || (b.reward - a.reward);
      if (sort === 'chain')  return byNumber(a.isChain ? 1 : 0, b.isChain ? 1 : 0) || (b.reward - a.reward);
      if (sort === 'faction') return byString(a.contractor ?? '', b.contractor ?? '') || (b.reward - a.reward);
      if (sort === 'type')    return byString(a.activity ?? '', b.activity ?? '') || (b.reward - a.reward);
      // category + reward fallback
      return a.category.localeCompare(b.category) * sign || (b.reward - a.reward);
    });

    return missions;
  });

  /** Click handler for a column header. Toggles direction if the same
   *  column is clicked twice; otherwise sets the new field with a sensible
   *  default direction (numeric → desc, text → asc). */
  setSort(field: 'reward' | 'title' | 'system' | 'rep' | 'chain' | 'faction' | 'type'): void {
    if (this.sortBy() === field) {
      this.sortDir.set(this.sortDir() === 'desc' ? 'asc' : 'desc');
    } else {
      this.sortBy.set(field);
      // Text columns default ascending; numeric / boolean ones default desc.
      const asc = field === 'title' || field === 'system' || field === 'faction' || field === 'type';
      this.sortDir.set(asc ? 'asc' : 'desc');
    }
    this.resetPage();
  }

  sortIndicator(field: 'reward' | 'title' | 'system' | 'rep' | 'chain' | 'faction' | 'type'): string {
    if (this.sortBy() !== field) return '';
    return this.sortDir() === 'desc' ? ' ▾' : ' ▴';
  }

  totalFiltered = computed(() => this.allFiltered().length);
  totalPages = computed(() => Math.ceil(this.totalFiltered() / this.pageSize) || 1);

  filteredMissions = computed(() => {
    const start = (this.page() - 1) * this.pageSize;
    return this.allFiltered().slice(start, start + this.pageSize);
  });

  expandedId = signal<string | null>(null);
  /** Trigger-locations drill-down toggle. Keyed by contract className so
   *  the open/closed state is per-row, not global. */
  expandedTriggersId = signal<string | null>(null);
  toggleTriggers(id: string, ev: MouseEvent): void {
    ev.stopPropagation();
    this.expandedTriggersId.set(this.expandedTriggersId() === id ? null : id);
  }
  /** Sum of child-location counts across all groups on a contract. Used in
   *  the "show NN specific locations" button label. */
  totalTriggerChildren(m: Mission): number {
    return (m.triggerLocationDetails ?? []).reduce((a, g) => a + g.locations.length, 0);
  }
  selectedMission = signal<Mission | null>(null);
  popoutTab = signal<'info' | 'reputation'>('info');
  private contractorProfiles = signal<Record<string, ContractorProfile>>({});

  /** Look up the faction/contractor profile card (description, HQ, focus…)
   *  for the currently-selected mission's contractor. Returns null if the
   *  contract has no named contractor or no profile is available. */
  selectedProfile = computed<ContractorProfile | null>(() => {
    const m = this.selectedMission();
    if (!m?.contractor) return null;
    return this.contractorProfiles()[m.contractor] ?? null;
  });

  /** Same lookup as `selectedProfile` but for an arbitrary mission — used
   *  by the inline expanded-row detail, which can render for any row. */
  selectedProfileFor(m: Mission): ContractorProfile | null {
    if (!m.contractor) return null;
    return this.contractorProfiles()[m.contractor] ?? null;
  }

  private host = inject(ElementRef<HTMLElement>);

  /** Close dropdowns on outside click so the overlays don't linger when the
   *  user clicks elsewhere in the page. */
  @HostListener('document:click', ['$event'])
  onDocClick(ev: MouseEvent): void {
    if (this.host.nativeElement.contains(ev.target as Node)) return;
    this.factionOpen.set(false);
    this.rankOpen.set(false);
    this.categoryOpen.set(false);
    this.systemOpen.set(false);
    this.activityOpen.set(false);
  }

  /** Close every dropdown except the one the user is opening. Centralised so
   *  opening one picker consistently collapses the others rather than
   *  stacking two menus on top of each other. */
  private closeAllPickersExcept(keep: 'faction' | 'rank' | 'category' | 'system' | 'activity' | null): void {
    if (keep !== 'faction')  this.factionOpen.set(false);
    if (keep !== 'rank')     this.rankOpen.set(false);
    if (keep !== 'category') this.categoryOpen.set(false);
    if (keep !== 'system')   this.systemOpen.set(false);
    if (keep !== 'activity') this.activityOpen.set(false);
  }

  constructor(private http: HttpClient, private data: DataService, private route: ActivatedRoute) {
    // DB-first: when DataService carries missions + missionRefs (prod
    // path), use them. Otherwise fall through to the static JSON fetch
    // (preview / GitHub Pages). Non-empty guard keeps a fresh DB with
    // empty mission tables from stranding us on a blank page.
    effect(() => {
      const db = this.data.db();
      const contracts = db?.missions as Mission[] | undefined;
      const refs = db?.missionRefs as any | undefined;
      if (contracts?.length && refs) {
        this.allMissions.set(contracts);
        this.missionGivers.set(refs.missionGivers ?? {});
        this.repLadders.set(refs.reputationLadders ?? {});
        this.scopeToLadder.set(refs.scopeToLadder ?? {});
        this.contractorProfiles.set(refs.contractorProfiles ?? {});
        this.loaded.set(true);
      }
    });
    effect(() => {
      const prefix = this.data.dataPrefix();
      this.data.modeVersion(); // track mode changes
      // Skip the JSON fetch when the DB hydration already populated us.
      if (this.loaded()) return;
      this.http.get<MissionData>(`${prefix}versedb_missions.json`).subscribe({
        next: data => {
          if (this.loaded()) return; // DB path won the race
          this.allMissions.set(data.contracts ?? data.missions ?? []);
          this.missionGivers.set(data.missionGivers);
          this.repLadders.set(data.reputationLadders ?? {});
          this.scopeToLadder.set(data.scopeToLadder ?? {});
          this.contractorProfiles.set(data.contractorProfiles ?? {});
          this.loaded.set(true);
        },
      });
    });

    // Accept deep-links from the Rep Builder: `?faction=<scope>&rank=<name>`
    // pre-selects the filter pair. Any other filters (search, category, …)
    // stay clear so the narrowed list really reflects the deep-link.
    // Also accepts `?pool=<sortedBpKey>` from the Blueprint Finder popout.
    this.route.queryParamMap.subscribe(params => {
      const f = params.get('faction');
      const r = params.get('rank');
      if (f) {
        this.factionFilter.set(f);
        this.rankFilter.set(r ?? '');
        this.resetPage();
      }
      const pool = params.get('pool');
      if (pool) {
        this.blueprintPoolFilter.set(pool);
        // Event-gated contracts are hidden by default — if the pool
        // belongs to an event (e.g. NMP2 Aves), the filter would
        // silently return zero missions. Flip the dropdown to
        // "All events + main" so the pool's missions actually surface.
        this.eventFilter.set('__all__');
        this.resetPage();
      }
    });
  }

  prevPage(): void {
    if (this.page() > 1) this.page.update(p => p - 1);
  }

  nextPage(): void {
    if (this.page() < this.totalPages()) this.page.update(p => p + 1);
  }

  resetPage(): void {
    this.page.set(1);
  }

  clearFilters(): void {
    this.searchQuery.set('');
    this.categoryFilter.set('');
    this.lawfulFilter.set('');
    this.systemFilter.set('');
    this.activityFilter.set('');
    this.contractorFilter.set('');
    this.factionFilter.set('');
    this.rankFilter.set('');
    this.riskFilter.set('');
    this.eventFilter.set('');
    this.blueprintFilter.set(false);
    this.chainFilter.set(false);
    this.blueprintNameFilter.set('');
    this.blueprintPoolFilter.set('');
    this.page.set(1);
  }

  /** Initials for an org/operator mark — "Interknet Defense Solutions" → "IDS",
   *  "Deacon Tobin" → "DT", single-word "Shubin" → "SH". Max 3 chars. */
  initials(name: string | undefined | null): string {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/).filter(p => p.length > 0);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return parts.slice(0, 3).map(p => p[0]).join('').toUpperCase();
  }

  /** "4h 12m" / "35m" — short-form duration for the Time column.
   *  Returns em-dash when undefined so list rows still align. */
  fmtDuration(min: number | undefined): string {
    if (!min || min <= 0) return '—';
    if (min < 60) return `${Math.round(min)}m`;
    const h = Math.floor(min / 60);
    const m = Math.round(min - h * 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }

  private readonly SCOPE_DISPLAY: Record<string, string> = {
    'affinity': 'NPC Affinity',
    'assassination': 'Assassination',
    'bounty': 'Bounty Hunting',
    'bounty_bountyhuntersguild': 'Bounty Hunters Guild',
    'courier': 'Courier',
    'emergency': 'Emergency Support',
    'factionreputationscope': 'Faction Standing',
    'handyman_citizensforpyro': 'Hired Muscle (CFP)',
    'hauling': 'Hauling',
    'hiredmuscle': 'Hired Muscle',
    'racing_shiptimetrial': 'Racing (Ship)',
    'security': 'Security',
    'shipcombat_headhunters': 'Ship Combat (Headhunters)',
    'technician': 'Technician',
    'wikelo': 'Barter & Trade',
  };

  private readonly SCOPE_HIDDEN = new Set(['npc_reliability', 'affinity', 'npc_fired']);

  fmtScope(scope: string): string {
    return this.SCOPE_DISPLAY[scope] ?? scope;
  }

  visibleScopes(m: Mission): string[] {
    return (m.repScopes ?? []).filter(s => !this.SCOPE_HIDDEN.has(s));
  }

  uniqueReqs(m: Mission): { scope: string; minRank: string; maxRank: string }[] {
    if (!m.repRequirements?.length) return [];
    const seen = new Set<string>();
    return m.repRequirements.filter(r => {
      const key = `${r.scope}:${r.minRank}:${r.maxRank}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private readonly LADDER_HIDDEN = new Set(['affinity', 'npc_reliability', 'npc_fired']);

  getLadders(m: Mission): RepLadder[] {
    return this.getLaddersWithScope(m).map(x => x.ladder);
  }

  /** Ladders for a mission paired with the canonical scope that produced
   *  each. The scope is needed by the inline expanded-detail template to
   *  wire rank-row clicks into the faction filter. Dedup is per-ladder (not
   *  per-scope) so multiple scopes hitting the same ladder — e.g. several
   *  "factionreputation" factions — don't produce duplicate tables; the
   *  first scope encountered wins, which matches the request-order
   *  displayed in the req-strip above. */
  getLaddersWithScope(m: Mission): { ladder: RepLadder; scope: string }[] {
    const ladders = this.repLadders();
    const stl = this.scopeToLadder();
    const reqScopes = (m.repRequirements ?? []).map(r => r.scope).filter(s => s && s !== '?');
    const scopes = m.repScopes ?? [];
    // requirement scopes first — we want clickable ranks in ladders to filter
    // by the exact scope the mission gates on, not a descriptive scope that
    // produces the same ladder but isn't what contracts carry.
    const allScopes = [...new Set([...reqScopes, ...scopes])];
    const seen = new Set<string>();
    const results: { ladder: RepLadder; scope: string }[] = [];
    for (const scope of allScopes) {
      const ladderKey = stl[scope] ?? stl[scope.toLowerCase()] ?? scope.toLowerCase();
      if (seen.has(ladderKey) || this.LADDER_HIDDEN.has(ladderKey)) continue;
      seen.add(ladderKey);
      const ladder = ladders[ladderKey];
      if (ladder) results.push({ ladder, scope });
    }
    return results;
  }

  calcLadder(m: Mission, ladder: RepLadder): CalcRow[] {
    const repPerMission = m.repReward ?? 0;
    const ranks = ladder.ranks.filter(r => r.minRep >= 0);
    return ranks.map((rank, i) => {
      const isLast = i + 1 >= ranks.length;
      const nextMin = isLast ? ladder.ceiling : ranks[i + 1].minRep;
      const rawGap = nextMin - rank.minRep;
      // Final rank or trivial gap to ceiling — show as complete
      const xpToFill = isLast || rawGap <= 1 ? 0 : Math.max(0, rawGap);
      const missions = repPerMission > 0 && xpToFill > 0
        ? Math.ceil(xpToFill / repPerMission) : null;
      return {
        name: rank.name,
        minRep: rank.minRep,
        xpToFill,
        missions,
        active: this.isActiveRank(m, ladder, rank),
        gated: !!rank.gated,
        perk: rank.perk,
      };
    });
  }

  isActiveRank(m: Mission, ladder: RepLadder, rank: RepRank): boolean {
    const reqs = m.repRequirements ?? [];
    for (const req of reqs) {
      const minIdx = ladder.ranks.findIndex(r => r.name === req.minRank);
      const maxIdx = ladder.ranks.findIndex(r => r.name === req.maxRank);
      const rankIdx = ladder.ranks.indexOf(rank);
      if (minIdx >= 0 && maxIdx >= 0 && rankIdx >= minIdx && rankIdx <= maxIdx) return true;
    }
    return false;
  }

  fmtRep(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(0) + 'k';
    return n.toString();
  }

  fmtReward(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'm';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
    return n.toString();
  }

  toggleExpand(id: string): void {
    this.expandedId.set(this.expandedId() === id ? null : id);
  }

  toggleFactionDd(ev: Event): void {
    ev.stopPropagation();
    this.closeAllPickersExcept('faction');
    this.factionOpen.update(v => !v);
  }
  toggleRankDd(ev: Event): void {
    ev.stopPropagation();
    // Rank dropdown is inert until a faction is chosen — avoid opening an
    // empty list.
    if (!this.factionLadder()) return;
    this.closeAllPickersExcept('rank');
    this.rankOpen.update(v => !v);
  }
  toggleCategoryDd(ev: Event): void {
    ev.stopPropagation();
    this.closeAllPickersExcept('category');
    this.categoryOpen.update(v => !v);
  }
  toggleSystemDd(ev: Event): void {
    ev.stopPropagation();
    this.closeAllPickersExcept('system');
    this.systemOpen.update(v => !v);
  }
  toggleActivityDd(ev: Event): void {
    ev.stopPropagation();
    this.closeAllPickersExcept('activity');
    this.activityOpen.update(v => !v);
  }
  pickCategory(val: string): void {
    this.categoryFilter.set(val);
    this.categoryOpen.set(false);
    this.resetPage();
  }
  pickSystem(val: string): void {
    this.systemFilter.set(val);
    this.systemOpen.set(false);
    this.resetPage();
  }
  pickActivity(val: string): void {
    this.activityFilter.set(val);
    this.activityOpen.set(false);
    this.resetPage();
  }
  pickFaction(scope: string): void {
    const prevLadder = this.factionLadder();
    this.factionFilter.set(scope);
    // Clear rank when the ladder changes — a rank name valid in one ladder
    // rarely exists in another, so keeping stale rank produces empty lists.
    if (prevLadder !== this.factionLadder()) this.rankFilter.set('');
    this.factionOpen.set(false);
    this.resetPage();
  }
  pickRank(rank: string): void {
    this.rankFilter.set(rank);
    this.rankOpen.set(false);
    this.resetPage();
  }

  /** Click-handler from a rank row in the expanded contract's ladder. Applies
   *  faction + rank as a filter and collapses the row so the user lands back
   *  on the filtered list. */
  applyLadderFilter(scope: string, rank: string, ev: MouseEvent): void {
    ev.stopPropagation();
    this.factionFilter.set(scope);
    this.rankFilter.set(rank);
    this.expandedId.set(null);
    this.resetPage();
    setTimeout(() => window.scrollTo({ top: 0, behavior: 'smooth' }), 30);
  }

  selectMission(m: Mission, e: MouseEvent): void {
    e.stopPropagation();
    this.popoutTab.set('info');
    this.selectedMission.set(this.selectedMission()?.className === m.className ? null : m);
  }

  closePopout(): void {
    this.selectedMission.set(null);
  }

  /** Systems a mission is actually available in — normalises the `systems`
   *  array form and the legacy single-`system` form into one set. */
  private missionSystems(m: Mission): Set<string> {
    if (m.systems?.length) return new Set(m.systems);
    return m.system ? new Set([m.system]) : new Set();
  }

  /** Alt is "reachable" if it shares at least one system with the parent
   *  mission. Used to sort/dim cross-system-only alts that players usually
   *  can't satisfy without flying elsewhere. An alt with no systems listed
   *  is treated as reachable — the extractor may not have resolved one
   *  and we'd rather over-show than silently drop. */
  altReachable(m: Mission, alt: { systems: string[] }): boolean {
    if (!alt.systems?.length) return true;
    const mine = this.missionSystems(m);
    if (!mine.size) return true;
    return alt.systems.some(s => mine.has(s));
  }

  /** Alts in a group with reachable ones first (same within-bucket order).
   *  Keeps the template declarative — no sort logic in HTML. */
  sortedAlts(m: Mission, group: { title: string; systems: string[] }[]):
      { title: string; systems: string[]; reachable: boolean }[] {
    return group
      .map(a => ({ ...a, reachable: this.altReachable(m, a) }))
      .sort((a, b) => Number(b.reachable) - Number(a.reachable));
  }

  /** Tooltip for an unreachable OR alt — kept as a method so the template
   *  doesn't have to deal with an escaped apostrophe in a string literal. */
  altTooltip(alt: { systems: string[]; reachable: boolean }): string {
    if (alt.reachable) return '';
    return `Only available in ${alt.systems.join(', ')} — not in this mission’s systems`;
  }

  navigateToMission(title: string, e: MouseEvent): void {
    e.stopPropagation();
    const target = this.allMissions().find(m => m.title === title);
    if (!target) return;
    // Match the normal row-click UX: expand the target inline and scroll it
    // into view. Keeps chain navigation consistent with the rest of the board
    // rather than popping open the legacy reputation modal.
    this.expandedId.set(target.className);
    // Jump to page 1 if the target isn't in the current page so the row
    // actually becomes visible. Title-based search is the simplest way.
    this.searchQuery.set(title);
    this.resetPage();
    setTimeout(() => {
      const el = document.querySelector(`[data-mv-row="${CSS.escape(target.className)}"]`);
      if (el && 'scrollIntoView' in el) (el as HTMLElement).scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 50);
  }

  private readonly MISSION_VAR_LABELS: Record<string, string> = {
    'Location': '[Location]', 'Location|Address': '[Location]', 'Location|address': '[Location]',
    'Location|CaveSize': '[Cave Size]',
    'Location1|Address': '[Location 1]', 'Location2|Address': '[Location 2]',
    'Destination': '[Destination]', 'Destination|Address': '[Destination]',
    'destination|ListAll': '[Destinations]',
    'DefendLocationWrapperLocation|Address': '[Location]',
    'Hint_Location': '[Location Hint]', 'Hint_Tool': '[Tool]',
    'Item': '[Cargo]', 'CargoGradeToken': '[Cargo Grade]',
    'MissionMaxSCUSize': '[SCU Size]',
    'MultiToSingleToken': '[Route]', 'SingleToMultiToken': '[Route]',
    'TargetName': '[Target]', 'TargetName|First': '[Target]',
    'TargetName|Last': '[Target]', 'TargetName|NickOrFirst': '[Target]',
    'AmbushTarget': '[Target]',
    'Ship': '[Ship]', 'Creature': '[Creature]',
    'MissingPersonList': '[Missing Persons]',
    'Contractor|SignOff': '[Contractor]',
    'System': '[System]', 'Danger': '[Danger Level]',
    'ScripAmount': '[Scrip]', 'ApprovalCode': '[Code]',
    'RaceDetails': '[Race Details]',
    'total': '[Total]', 'description': '[Details]',
  };

  cleanDesc(desc: string): string {
    return desc
      .replace(/<[^>]+>/g, '')
      .replace(/\\n/g, '\n')
      .replace(/~mission\(([^)]+)\)/g, (_, token) => this.MISSION_VAR_LABELS[token] ?? `[${token}]`)
      .trim();
  }
}
