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

@Component({
  selector: 'app-mining-view',
  standalone: true,
  templateUrl: './mining-view.html',
  styleUrl: './mining-view.scss',
})
export class MiningViewComponent {
  selectedSystem = signal<string | null>(null);
  selectedLocation = signal<MiningLocation | null>(null);
  selectedMineral = signal<MiningElement | null>(null);

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

  tierClass(tier: string): string {
    switch (tier) {
      case 'Legendary': return 'tier-legendary';
      case 'Epic': return 'tier-epic';
      case 'Rare': return 'tier-rare';
      case 'Uncommon': return 'tier-uncommon';
      default: return 'tier-common';
    }
  }

  selectSystem(sys: string): void {
    this.selectedSystem.set(sys);
    this.selectedLocation.set(null);
    this.selectedMineral.set(null);
  }

  selectBody(loc: MiningLocation): void {
    this.selectedLocation.set(loc);
    this.selectedMineral.set(null);
  }

  selectMineral(name: string): void {
    const el = this.elements().find(e => e.name.toLowerCase() === name.toLowerCase());
    this.selectedMineral.set(el ?? null);
  }

  back(): void {
    if (this.selectedMineral()) {
      this.selectedMineral.set(null);
    } else if (this.selectedLocation()) {
      this.selectedLocation.set(null);
    } else {
      this.selectedSystem.set(null);
    }
  }

  constructor(public data: DataService) {}
}
