import { Component, signal, computed, effect } from '@angular/core';
import { HttpClient } from '@angular/common/http';
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
  contracts: Mission[];
  missions?: Mission[];  // legacy fallback
}

@Component({
  selector: 'app-missions-view',
  standalone: true,
  templateUrl: './missions-view.html',
  styleUrl: './missions-view.scss',
})
export class MissionsViewComponent {
  allMissions = signal<Mission[]>([]);
  private missionGivers = signal<Record<string, MissionGiver>>({});
  private repLadders = signal<Record<string, RepLadder>>({});
  loaded = signal(false);

  searchQuery = signal('');
  categoryFilter = signal('');
  lawfulFilter = signal<'' | 'lawful' | 'unlawful'>('');
  systemFilter = signal('');
  activityFilter = signal('');
  repScopeFilter = signal('');
  sortBy = signal<'reward' | 'title' | 'category'>('reward');
  blueprintFilter = signal(false);
  blueprintNameFilter = signal('');
  page = signal(1);
  readonly pageSize = 20;

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

  repScopes = computed(() => {
    const scopes = new Set<string>();
    for (const m of this.allMissions()) {
      for (const s of m.repScopes ?? []) scopes.add(s);
      for (const r of m.repRequirements ?? []) scopes.add(r.scope);
    }
    return ['', ...Array.from(scopes).sort()];
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
           this.activityFilter() !== '' || this.repScopeFilter() !== '' ||
           this.blueprintFilter() || this.blueprintNameFilter() !== '';
  });

  private allFiltered = computed(() => {
    if (!this.hasActiveFilter()) return [];

    const search = this.searchQuery().toLowerCase();
    const cat = this.categoryFilter();
    const law = this.lawfulFilter();
    const sys = this.systemFilter();
    const act = this.activityFilter();
    const rep = this.repScopeFilter();
    const bp = this.blueprintFilter();
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
    if (rep) missions = missions.filter(m =>
      m.repScopes?.includes(rep) ||
      m.repRequirements?.some(r => r.scope === rep) ||
      (rep === 'wikelo' && m.generator === 'thecollector')
    );
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

  private readonly SCOPE_DISPLAY: Record<string, string> = {
    'shipcombat_headhunters': 'Ship Combat (Headhunters)',
    'factionreputationscope': 'Faction Standing',
    'affinity': 'NPC Affinity',
    'wikelo': 'Barter & Trade',
  };

  fmtScope(scope: string): string {
    return this.SCOPE_DISPLAY[scope] ?? scope;
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

  getLadders(m: Mission): RepLadder[] {
    const ladders = this.repLadders();
    const scopes = m.repScopes ?? [];
    // Also check repRequirements scope
    const reqScopes = (m.repRequirements ?? []).map(r => r.scope).filter(s => s && s !== '?');
    const allScopes = [...new Set([...scopes, ...reqScopes])];
    const results: RepLadder[] = [];
    for (const scope of allScopes) {
      const ladder = ladders[scope.toLowerCase()];
      if (ladder) results.push(ladder);
    }
    return results;
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

  cleanDesc(desc: string): string {
    // Strip markup tags and template vars for display
    return desc
      .replace(/<[^>]+>/g, '')
      .replace(/\\n/g, '\n')
      .replace(/~mission\([^)]+\)/g, '???')
      .trim();
  }
}
