import { Component, signal, computed, effect } from '@angular/core';
import { HttpClient } from '@angular/common/http';
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
  danger?: string;
  enemyPool?: string[];
  requiresCompletion?: string[];
  /** OR groups: complete *any* mission in each inner array to satisfy that
   *  gate. Rendered as "complete any one of" groups, distinct from the
   *  strict AND list in `requiresCompletion`. */
  requiresAnyOf?: string[][];
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
  riskFilter = signal<'' | 'low' | 'med' | 'high'>('');
  /** Event filter. Empty string = main list (hide all event content); '__all__'
   *  = include everything; any specific event name = show only that event. */
  eventFilter = signal<string>('');
  sortBy = signal<'reward' | 'title' | 'category'>('reward');
  blueprintFilter = signal(false);
  chainFilter = signal(false);
  blueprintNameFilter = signal('');
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

  hasActiveFilter = computed(() => {
    return this.searchQuery().length >= 2 || this.categoryFilter() !== '' ||
           this.lawfulFilter() !== '' || this.systemFilter() !== '' ||
           this.activityFilter() !== '' || this.contractorFilter() !== '' ||
           this.riskFilter() !== '' || this.eventFilter() !== '' ||
           this.blueprintFilter() || this.chainFilter() || this.blueprintNameFilter() !== '';
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
    if (this.eventFilter() === '__all__') out.push({ key: 'event', label: 'Events: All' });
    else if (this.eventFilter()) out.push({ key: 'event', label: 'Event: ' + this.eventFilter() });
    if (this.blueprintFilter()) out.push({ key: 'blueprint', label: 'Blueprints' });
    if (this.chainFilter()) out.push({ key: 'chain', label: 'Chains' });
    if (this.blueprintNameFilter()) out.push({ key: 'bpname', label: this.blueprintNameFilter() });
    return out;
  });

  removeFilter(key: string): void {
    switch (key) {
      case 'search': this.searchQuery.set(''); break;
      case 'category': this.categoryFilter.set(''); break;
      case 'risk': this.riskFilter.set(''); break;
      case 'lawful': this.lawfulFilter.set(''); break;
      case 'system': this.systemFilter.set(''); break;
      case 'activity': this.activityFilter.set(''); break;
      case 'contractor': this.contractorFilter.set(''); break;
      case 'event': this.eventFilter.set(''); break;
      case 'blueprint': this.blueprintFilter.set(false); break;
      case 'chain': this.chainFilter.set(false); break;
      case 'bpname': this.blueprintNameFilter.set(''); break;
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
    // Event filter: default hides event-gated contracts from the main list
    // (matches how other SC tools separate event content). '__all__' disables
    // the filter; a specific event name narrows to just that event's contracts.
    const ev = this.eventFilter();
    if (!ev) missions = missions.filter(m => !m.event);
    else if (ev !== '__all__') missions = missions.filter(m => m.event === ev);
    if (sys) missions = missions.filter(m =>
      (m.systems?.length ? m.systems.includes(sys) : m.system === sys)
    );
    if (act) missions = missions.filter(m => m.activity === act);
    if (risk) missions = missions.filter(m => this.riskTier(m) === risk);
    if (bpName) missions = missions.filter(m => m.blueprintRewards?.includes(bpName));
    else if (bp) missions = missions.filter(m => m.blueprintRewards?.length);
    if (chain) missions = missions.filter(m => m.isChain);
    if (ct) missions = missions.filter(m => m.contractor === ct);
    if (titleRx) missions = missions.filter(m => titleRx.test(m.title ?? ''));

    if (sort === 'reward') missions = [...missions].sort((a, b) => b.reward - a.reward);
    else if (sort === 'title') missions = [...missions].sort((a, b) => a.title.localeCompare(b.title));
    else missions = [...missions].sort((a, b) => a.category.localeCompare(b.category) || b.reward - a.reward);

    return missions;
  });

  totalFiltered = computed(() => this.allFiltered().length);
  totalPages = computed(() => Math.ceil(this.totalFiltered() / this.pageSize) || 1);

  filteredMissions = computed(() => {
    const start = (this.page() - 1) * this.pageSize;
    return this.allFiltered().slice(start, start + this.pageSize);
  });

  expandedId = signal<string | null>(null);
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

  constructor(private http: HttpClient, private data: DataService) {
    effect(() => {
      const prefix = this.data.dataPrefix();
      this.data.modeVersion(); // track mode changes
      this.loaded.set(false);
      this.http.get<MissionData>(`${prefix}versedb_missions.json`).subscribe(data => {
        this.allMissions.set(data.contracts ?? data.missions ?? []);
        this.missionGivers.set(data.missionGivers);
        this.repLadders.set(data.reputationLadders ?? {});
        this.scopeToLadder.set(data.scopeToLadder ?? {});
        this.contractorProfiles.set(data.contractorProfiles ?? {});
        this.loaded.set(true);
      });
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
    this.riskFilter.set('');
    this.eventFilter.set('');
    this.blueprintFilter.set(false);
    this.chainFilter.set(false);
    this.blueprintNameFilter.set('');
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
    const ladders = this.repLadders();
    const stl = this.scopeToLadder();
    const scopes = m.repScopes ?? [];
    const reqScopes = (m.repRequirements ?? []).map(r => r.scope).filter(s => s && s !== '?');
    const allScopes = [...new Set([...scopes, ...reqScopes])];
    const seen = new Set<string>();
    const results: RepLadder[] = [];
    for (const scope of allScopes) {
      const ladderKey = stl[scope] ?? stl[scope.toLowerCase()] ?? scope.toLowerCase();
      if (seen.has(ladderKey) || this.LADDER_HIDDEN.has(ladderKey)) continue;
      seen.add(ladderKey);
      const ladder = ladders[ladderKey];
      if (ladder) results.push(ladder);
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

  selectMission(m: Mission, e: MouseEvent): void {
    e.stopPropagation();
    this.popoutTab.set('info');
    this.selectedMission.set(this.selectedMission()?.className === m.className ? null : m);
  }

  closePopout(): void {
    this.selectedMission.set(null);
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
