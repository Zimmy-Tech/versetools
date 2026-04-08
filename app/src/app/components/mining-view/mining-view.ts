import { Component, computed, signal } from '@angular/core';
import { DataService } from '../../services/data.service';

interface MiningMineral {
  mineral: string;
  tier: string;
  percent: number;
  probability: number;
  instability?: number;
  resistance?: number;
}

interface MiningLocation {
  id: string;
  location: string;
  system: string;
  mining: {
    ship?: MiningMineral[];
    roc?: MiningMineral[];
    hand?: MiningMineral[];
  };
}

interface MiningElement {
  name: string;
  instability: number;
  resistance: number;
  optimalWindow: number;
  optimalWindowRand: number;
  optimalThinness: number;
  explosionMultiplier: number;
  clusterFactor: number;
}

interface OreLocationEntry {
  location: string;
  system: string;
  method: string;
  tier: string;
  percent: number;
}

/** Maps raw mining-location names from the data feed to friendlier
 *  display strings. CIG hasn't shipped formal localization for the
 *  Pyro bodies yet, so the data file has procedural keys ("Pyro Va")
 *  while in-game they're known by names like "Vuur" and "Ignis".
 *  Add entries here as new locations get named. */
const LOCATION_DISPLAY_NAMES: Record<string, string> = {
  // Pyro system bodies
  'Pyro II': 'Pyro II - Monox',
  'Pyro III': 'Pyro III - Bloom',
  'Pyro Va': 'Pyro V-a - Ignis',
  'Pyro Vb': 'Pyro V-b - Vatra',
  'Pyro Vc': 'Pyro V-c - Adir',
  'Pyro Vd': 'Pyro V-d - Fairo',
  'Pyro Ve': 'Pyro V-e - Fuego',
  'Pyro Vf': 'Pyro V-f - Vuur',
  'Pyro VI': 'Pyro VI - Terminus',
};

@Component({
  selector: 'app-mining-view',
  standalone: true,
  templateUrl: './mining-view.html',
  styleUrl: './mining-view.scss',
})
export class MiningViewComponent {
  /** Returns the display name for a raw mining location, falling back
   *  to the raw value when no mapping exists. */
  displayLocation(name: string | undefined | null): string {
    if (!name) return '';
    return LOCATION_DISPLAY_NAMES[name] ?? name;
  }

  // Navigation mode: 'system' (default) or 'ore'
  mode = signal<'system' | 'ore'>('system');

  // System path state
  selectedSystem = signal<string | null>(null);
  selectedLocation = signal<MiningLocation | null>(null);
  selectedMineral = signal<MiningElement | null>(null);

  // Ore path state
  selectedOre = signal<string | null>(null);

  private locations = computed<MiningLocation[]>(() => (this.data.db() as any)?.miningLocations ?? []);
  private elements = computed<MiningElement[]>(() => (this.data.db() as any)?.miningElements ?? []);

  systems = computed(() => {
    const locs = this.locations();
    return [...new Set(locs.map(l => l.system))].sort();
  });

  bodies = computed(() => {
    const sys = this.selectedSystem();
    if (!sys) return [];
    return this.locations()
      .filter(l => l.system === sys && !l.id.includes('resourcerush'))
      .sort((a, b) => a.location.localeCompare(b.location));
  });

  /** All unique ore names across all locations, sorted alphabetically. */
  allOres = computed(() => {
    const ores = new Set<string>();
    for (const loc of this.locations()) {
      if (loc.id.includes('resourcerush')) continue;
      for (const method of ['ship', 'roc', 'hand'] as const) {
        for (const m of loc.mining[method] ?? []) {
          ores.add(m.mineral);
        }
      }
    }
    return [...ores].sort();
  });

  /** All locations where the selected ore can be found, with method/tier/percent. */
  oreLocations = computed<OreLocationEntry[]>(() => {
    const ore = this.selectedOre();
    if (!ore) return [];
    const results: OreLocationEntry[] = [];
    for (const loc of this.locations()) {
      if (loc.id.includes('resourcerush')) continue;
      for (const method of ['ship', 'roc', 'hand'] as const) {
        for (const m of loc.mining[method] ?? []) {
          if (m.mineral === ore) {
            results.push({
              location: loc.location,
              system: loc.system,
              method: method === 'ship' ? 'Ship' : method === 'roc' ? 'ROC' : 'Hand',
              tier: m.tier,
              percent: m.percent,
            });
          }
        }
      }
    }
    return results.sort((a, b) => b.percent - a.percent);
  });

  tierClass(tier: string): string {
    switch (tier) {
      case 'Legendary': return 'tier-legendary';
      case 'Epic': return 'tier-epic';
      case 'Rare': return 'tier-rare';
      case 'Uncommon': return 'tier-uncommon';
      default: return 'tier-common';
    }
  }

  resetToHome(): void {
    this.mode.set('system');
    this.selectedSystem.set(null);
    this.selectedLocation.set(null);
    this.selectedMineral.set(null);
    this.selectedOre.set(null);
  }

  enterOreMode(): void {
    this.mode.set('ore');
    this.selectedSystem.set(null);
    this.selectedLocation.set(null);
    this.selectedMineral.set(null);
    this.selectedOre.set(null);
  }

  selectSystem(sys: string): void {
    this.mode.set('system');
    this.selectedSystem.set(sys);
    this.selectedLocation.set(null);
    this.selectedMineral.set(null);
    this.selectedOre.set(null);
  }

  selectBody(loc: MiningLocation): void {
    this.selectedLocation.set(loc);
    this.selectedMineral.set(null);
  }

  selectMineral(name: string): void {
    const el = this.elements().find(e => e.name.toLowerCase() === name.toLowerCase());
    this.selectedMineral.set(el ?? null);
  }

  selectOre(name: string): void {
    this.selectedOre.set(name);
  }

  back(): void {
    if (this.selectedOre()) {
      this.selectedOre.set(null);
    } else if (this.selectedMineral()) {
      this.selectedMineral.set(null);
    } else if (this.selectedLocation()) {
      this.selectedLocation.set(null);
    } else if (this.selectedSystem()) {
      this.selectedSystem.set(null);
    }
  }

  constructor(public data: DataService) {}
}
