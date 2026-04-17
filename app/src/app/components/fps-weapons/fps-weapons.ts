import { Component, signal, computed } from '@angular/core';
import { HttpClient } from '@angular/common/http';

interface FpsWeapon {
  className: string;
  name: string;
  manufacturer: string;
  type: string;
  subType: string;
  size: number;
  fireRate: number;
  isCharged?: boolean | null;
  fireModes: string[];
  magazineSize: number;
  projectileSpeed: number;
  range: number;
  damage: { physical: number; energy: number; distortion: number; thermal: number; biochemical: number; stun: number };
  alphaDamage: number;
  dps: number;
  sequenceEntries?: number | null;
  category?: string;
  recoilPitch?: number | null;
  recoilYaw?: number | null;
  recoilSmooth?: number | null;
}

@Component({
  selector: 'app-fps-weapons',
  standalone: true,
  templateUrl: './fps-weapons.html',
  styleUrl: './fps-weapons.scss',
})
export class FpsWeaponsComponent {
  weapons = signal<FpsWeapon[]>([]);
  loaded = signal(false);

  typeFilter = signal('');
  subTypeFilter = signal('');
  searchQuery = signal('');
  sortBy = signal<'dps' | 'alphaDamage' | 'fireRate' | 'magazineSize' | 'name'>('name');
  sortDir = signal<'asc' | 'desc'>('asc');

  types = computed(() => {
    const t = new Set(this.weapons().map(w => w.type));
    return ['', ...Array.from(t).sort()];
  });

  subTypes = computed(() => {
    const t = new Set(this.weapons().map(w => w.subType));
    return ['', ...Array.from(t).sort()];
  });

  filtered = computed(() => {
    let list = this.weapons();
    const type = this.typeFilter();
    const sub = this.subTypeFilter();
    const q = this.searchQuery().toLowerCase();
    const sort = this.sortBy();
    const dir = this.sortDir();

    if (type) list = list.filter(w => w.type === type);
    if (sub) list = list.filter(w => w.subType === sub);
    if (q) list = list.filter(w => w.name.toLowerCase().includes(q) || w.manufacturer.toLowerCase().includes(q));

    list = [...list].sort((a, b) => {
      let av: number | string, bv: number | string;
      switch (sort) {
        case 'name': av = a.name; bv = b.name; return dir === 'asc' ? (av as string).localeCompare(bv as string) : (bv as string).localeCompare(av as string);
        case 'dps': av = a.dps; bv = b.dps; break;
        case 'alphaDamage': av = a.alphaDamage; bv = b.alphaDamage; break;
        case 'fireRate': av = a.fireRate; bv = b.fireRate; break;
        case 'magazineSize': av = a.magazineSize; bv = b.magazineSize; break;
        default: av = a.dps; bv = b.dps;
      }
      return dir === 'asc' ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });

    return list;
  });

  antiPersonnel = computed(() => this.filtered().filter(w => w.category !== 'Anti-Ship'));
  antiShip = computed(() => this.filtered().filter(w => w.category === 'Anti-Ship'));

  constructor(private http: HttpClient) {
    this.http.get<{ weapons: FpsWeapon[] }>('live/versedb_fps.json').subscribe(data => {
      this.weapons.set(data.weapons);
      this.loaded.set(true);
    });
  }

  toggleSort(col: 'dps' | 'alphaDamage' | 'fireRate' | 'magazineSize' | 'name'): void {
    if (this.sortBy() === col) {
      this.sortDir.set(this.sortDir() === 'desc' ? 'asc' : 'desc');
    } else {
      this.sortBy.set(col);
      this.sortDir.set('desc');
    }
  }

  sortIndicator(col: string): string {
    if (this.sortBy() !== col) return '';
    return this.sortDir() === 'desc' ? ' \u25BE' : ' \u25B4';
  }

  fmt(val: number, decimals = 1): string {
    if (!val) return '\u2014';
    return val.toFixed(decimals);
  }

  fmtRpm(w: FpsWeapon): string {
    if (w.isCharged) return 'Charged';
    return this.fmt(w.fireRate, 0);
  }

  realDps(w: FpsWeapon): number | null {
    if (!w.sequenceEntries || w.sequenceEntries < 2 || !w.fireRate) return null;
    const ticks = Math.ceil(1800 / w.fireRate);
    const effRPM = 1800 / ticks;
    if (effRPM === w.fireRate) return null;  // no loss, don't show
    return w.alphaDamage * effRPM / 60;
  }

  showRealDpsModal = signal(false);
  showRecoilModal = signal(false);

  dmgType(w: FpsWeapon): string {
    const d = w.damage;
    if (d.physical > 0 && d.energy === 0) return 'Phys';
    if (d.energy > 0 && d.physical === 0) return 'Enrg';
    if (d.distortion > 0) return 'Dist';
    if (d.physical > 0 && d.energy > 0) return 'Mixed';
    return '\u2014';
  }
}
