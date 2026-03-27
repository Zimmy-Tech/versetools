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
  system?: string;
  activity?: string;
  giver?: string;
  lifetimeMin?: number;
  respawnMin?: number;
  cooldownMin?: number;
  timeLimitMin?: number;
  onceOnly?: boolean;
  blueprintRewards?: string[];
  repScopes?: string[];
}

interface MissionData {
  missions: Mission[];
}

interface BlueprintEntry {
  name: string;
  type: string;
  missions: Mission[];
}

@Component({
  selector: 'app-blueprint-finder',
  standalone: true,
  templateUrl: './blueprint-finder.html',
  styleUrl: './blueprint-finder.scss',
})
export class BlueprintFinderComponent {
  private allMissions = signal<Mission[]>([]);
  loaded = signal(false);

  searchQuery = signal('');
  typeFilter = signal('');
  setFilter = signal('');

  readonly armorSets = [
    'Antium', 'Testudo', 'Geist', 'Palatino', 'Corbel', 'Monde', 'Artimex',
    'Morozov-SH', 'Inquisitor', 'Aril', 'Strata', 'DustUp', 'Calico',
    'Defiance', 'Aves', 'Arden-SL', 'ORC-mkV', 'Citadel', 'Lynx',
    'TrueDef-Pro', 'Venture', 'Piecemeal',
  ];

  readonly weaponSets = [
    'A03', 'Arclight', 'Arrowhead', 'Atzkav', 'BR-2', 'C54', 'Coda',
    'Custodian', 'Deadrig', 'Devastator', 'F55', 'FS-9', 'Fresnel',
    'Gallant', 'Karna', 'Killshot', 'Lumin', 'P8-SC', 'Prism',
    'Pulse', 'Pulverizer', 'Quartz', 'R97', 'Ravager', 'S71',
    'Scalpel', 'Tripledown', 'Yubarev', 'Zenith',
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
  selectedMission = signal<Mission | null>(null);

  toggleExpand(name: string): void {
    this.expandedBp.set(this.expandedBp() === name ? null : name);
  }

  openMission(m: Mission, e: Event): void {
    e.stopPropagation();
    this.selectedMission.set(m);
  }

  closePopout(): void {
    this.selectedMission.set(null);
  }

  fmtReward(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'm';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
    return n.toString();
  }

  constructor(private http: HttpClient, private data: DataService) {
    effect(() => {
      const prefix = this.data.dataPrefix();
      this.data.modeVersion();
      this.loaded.set(false);
      this.http.get<MissionData>(`${prefix}versedb_missions.json`).subscribe(d => {
        this.allMissions.set(d.missions);
        this.loaded.set(true);
      });
    });
  }
}
