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
  activity?: string;
  blueprintRewards?: string[];
  repReward?: number;
  repPenalty?: number;
  boss?: boolean;
  contractor?: string;
  danger?: string;
  enemyPool?: string[];
  requiresCompletion?: string[];
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

interface MissionData {
  meta: { totalContracts: number; categories: Record<string, number>; missionGivers: number };
  missionGivers: Record<string, MissionGiver>;
  reputationLadders?: Record<string, RepLadder>;
  scopeToLadder?: Record<string, string>;
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
  sortBy = signal<'reward' | 'title' | 'category'>('reward');
  blueprintFilter = signal(false);
  chainFilter = signal(false);
  blueprintNameFilter = signal('');
  page = signal(1);
  readonly pageSize = 50;

  categories = computed(() => {
    const cats = new Set(this.allMissions().map(m => m.category));
    return ['', ...Array.from(cats).sort()];
  });

  systems = computed(() => {
    const sys = new Set(this.allMissions().map(m => m.system).filter(Boolean));
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
           this.blueprintFilter() || this.chainFilter() || this.blueprintNameFilter() !== '';
  });

  private allFiltered = computed(() => {
    const search = this.searchQuery().toLowerCase();
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

    if (cat) missions = missions.filter(m => m.category === cat);
    if (law === 'lawful') missions = missions.filter(m => m.lawful);
    if (law === 'unlawful') missions = missions.filter(m => !m.lawful);
    if (sys) missions = missions.filter(m => m.system === sys);
    if (act) missions = missions.filter(m => m.activity === act);
    if (bpName) missions = missions.filter(m => m.blueprintRewards?.includes(bpName));
    else if (bp) missions = missions.filter(m => m.blueprintRewards?.length);
    if (chain) missions = missions.filter(m => m.isChain);
    if (ct) missions = missions.filter(m => m.contractor === ct);
    if (search) {
      missions = missions.filter(m =>
        m.title.toLowerCase().includes(search) ||
        (m.description?.toLowerCase().includes(search)) ||
        (m.giver?.toLowerCase().includes(search)) ||
        m.category.toLowerCase().includes(search)
      );
    }

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
    this.blueprintFilter.set(false);
    this.chainFilter.set(false);
    this.blueprintNameFilter.set('');
    this.page.set(1);
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
    if (target) {
      this.popoutTab.set('info');
      this.selectedMission.set(target);
    }
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
