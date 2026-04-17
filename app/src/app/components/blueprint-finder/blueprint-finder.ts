import { Component, signal, computed, effect } from '@angular/core';
import { Router } from '@angular/router';
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
  system?: string;
  activity?: string;
  giver?: string;
  contractor?: string;
  lifetimeMin?: number;
  respawnMin?: number;
  cooldownMin?: number;
  timeLimitMin?: number;
  onceOnly?: boolean;
  blueprintRewards?: string[];
  repScopes?: string[];
  missionFlow?: string[];
  repReward?: number;
  repPenalty?: number;
  repRequirements?: { scope: string; minRank: string; maxRank: string }[];
  danger?: string;
  requiresCompletion?: string[];
  unlocks?: string[];
}

interface RepRank {
  name: string;
  minRep: number;
  gated?: boolean;
  perk?: string;
  driftPerHour?: number;
}

interface RepLadder {
  name: string;
  displayName: string;
  ceiling: number;
  ranks: RepRank[];
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
  contracts: Mission[];
  missions?: Mission[];  // legacy fallback
  reputationLadders?: Record<string, RepLadder>;
  scopeToLadder?: Record<string, string>;
  contractorProfiles?: Record<string, ContractorProfile>;
}

interface BlueprintEntry {
  name: string;
  type: string;
  missions: Mission[];
}

@Component({
  selector: 'app-blueprint-finder',
  standalone: true,
  imports: [DecimalPipe],
  templateUrl: './blueprint-finder.html',
  styleUrl: './blueprint-finder.scss',
})
export class BlueprintFinderComponent {
  private allMissions = signal<Mission[]>([]);
  private repLadders = signal<Record<string, RepLadder>>({});
  private scopeToLadder = signal<Record<string, string>>({});
  private contractorProfiles = signal<Record<string, ContractorProfile>>({});
  loaded = signal(false);

  searchQuery = signal('');
  typeFilter = signal('');
  setFilter = signal('');

  readonly armorSets = [
    'Antium', 'Arden-SL', 'Aril', 'Artimex', 'Aves', 'Calico', 'Carnifex',
    'Citadel', 'Corbel', 'Defiance', 'Dust', 'DustUp', 'Geist', 'Inquisitor',
    'Lynx', 'Monde', 'Morozov-SH', 'ORC-mkV', 'Overlord', 'PAB-1', 'Palatino',
    'Pembroke', 'Piecemeal', 'Strata', 'Testudo', 'TrueDef-Pro', 'Venture',
  ];

  readonly weaponSets = [
    'A03', 'Arclight', 'Arrowhead', 'Atzkav', 'BR-2', 'C54', 'Coda',
    'Custodian', 'Deadrig', 'Devastator', 'F55', 'FS-9', 'Fresnel',
    'Gallant', 'Karna', 'Killshot', 'Lumin', 'P6-LR', 'P8-SC',
    'Parallax', 'Prism', 'Pulse', 'Pulverizer', 'Quartz', 'R97',
    'Ravager-212', 'S71', 'Scalpel', 'Tripledown', 'Yubarev', 'Zenith',
  ];

  toggleSet(set: string): void {
    this.setFilter.set(this.setFilter() === set ? '' : set);
    this.searchQuery.set('');
  }

  private readonly TYPE_PATTERNS: [string, RegExp][] = [
    ['Helmet', /helmet/i],
    ['Core', /core/i],
    ['Arms', /arms/i],
    ['Legs', /legs/i],
    ['Undersuit', /undersuit/i],
    ['Backpack', /backpack/i],
    ['Rifle', /rifle/i],
    ['Sniper', /sniper/i],
    ['Pistol', /pistol/i],
    ['Shotgun', /shotgun/i],
    ['SMG', /\bsmg\b/i],
    ['LMG', /\blmg\b/i],
    ['Magazine', /magazine/i],
    ['Attachment', /optic|barrel|stock|grip|laser.*pointer/i],
  ];

  private classifyBlueprint(name: string): string {
    for (const [type, pattern] of this.TYPE_PATTERNS) {
      if (pattern.test(name)) return type;
    }
    return 'Other';
  }

  blueprints = computed<BlueprintEntry[]>(() => {
    const missions = this.allMissions();
    const map = new Map<string, BlueprintEntry>();

    for (const m of missions) {
      for (const bp of m.blueprintRewards ?? []) {
        if (!map.has(bp)) {
          map.set(bp, { name: bp, type: this.classifyBlueprint(bp), missions: [] });
        }
        map.get(bp)!.missions.push(m);
      }
    }

    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  });

  types = computed(() => {
    const t = new Set(this.blueprints().map(b => b.type));
    return ['', ...Array.from(t).sort()];
  });

  filtered = computed(() => {
    const q = this.searchQuery().toLowerCase();
    const type = this.typeFilter();
    const set = this.setFilter();
    let list = this.blueprints();
    if (type) list = list.filter(b => b.type === type);
    if (set) list = list.filter(b => b.name.toLowerCase().startsWith(set.toLowerCase()));
    if (q) list = list.filter(b => b.name.toLowerCase().includes(q));
    return list;
  });

  expandedBp = signal<string | null>(null);
  expandedBpData = computed(() => {
    const name = this.expandedBp();
    if (!name) return null;
    return this.filtered().find(bp => bp.name === name) ?? null;
  });
  selectedMission = signal<Mission | null>(null);
  popoutTab = signal<'info' | 'reputation'>('info');

  /** Faction/contractor profile lookup for the currently-selected mission. */
  selectedProfile = computed<ContractorProfile | null>(() => {
    const m = this.selectedMission();
    if (!m?.contractor) return null;
    return this.contractorProfiles()[m.contractor] ?? null;
  });

  toggleExpand(name: string): void {
    this.expandedBp.set(this.expandedBp() === name ? null : name);
  }

  openMission(m: Mission, e: Event): void {
    e.stopPropagation();
    this.popoutTab.set('info');
    this.selectedMission.set(m);
  }

  closePopout(): void {
    this.selectedMission.set(null);
  }

  /* ── Reputation logic (mirrored from missions-view) ──────────────────────
     Kept in sync manually; if rep rendering gets more complex, factor into
     a shared service. */

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
  private readonly LADDER_HIDDEN = new Set(['affinity', 'npc_reliability', 'npc_fired']);

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

  fmtReward(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'm';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
    return n.toString();
  }

  openInCrafting(blueprintName: string, e: Event): void {
    e.stopPropagation();
    // Store the blueprint name so crafting page can pick it up
    localStorage.setItem('versetools_craft_search', blueprintName);
    this.router.navigate(['/crafting']);
  }

  constructor(private http: HttpClient, private data: DataService, private router: Router) {
    effect(() => {
      const prefix = this.data.dataPrefix();
      this.data.modeVersion();
      this.loaded.set(false);
      this.http.get<MissionData>(`${prefix}versedb_missions.json`).subscribe(d => {
        this.allMissions.set(d.contracts ?? d.missions ?? []);
        this.repLadders.set(d.reputationLadders ?? {});
        this.scopeToLadder.set(d.scopeToLadder ?? {});
        this.contractorProfiles.set(d.contractorProfiles ?? {});
        this.loaded.set(true);
      });
    });
  }
}
