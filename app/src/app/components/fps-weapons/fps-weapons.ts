import { Component, signal, computed, effect } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { DataService } from '../../services/data.service';

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
  mass?: number;
  adsTime?: number;
  adsZoomScale?: number;
}

interface FpsMagazine {
  className: string;
  name: string;
  weaponTag: string;
  manufacturer: string;
  ammoCount: number;
  mass: number;
  size: number;
  subType: string;
  ammoType: string;
}

@Component({
  selector: 'app-fps-weapons',
  standalone: true,
  templateUrl: './fps-weapons.html',
  styleUrl: './fps-weapons.scss',
})
export class FpsWeaponsComponent {
  weapons = signal<FpsWeapon[]>([]);
  magazines = signal<FpsMagazine[]>([]);
  loaded = signal(false);

  tab = signal<'weapons' | 'mags'>('weapons');

  typeFilter = signal('');
  subTypeFilter = signal('');
  searchQuery = signal('');
  sortBy = signal<'dps' | 'alphaDamage' | 'fireRate' | 'magazineSize' | 'name' | 'mass' | 'adsTime' | 'adsZoomScale'>('name');
  sortDir = signal<'asc' | 'desc'>('asc');

  magSortBy = signal<'name' | 'ammoCount' | 'mass' | 'size'>('name');
  magSortDir = signal<'asc' | 'desc'>('asc');
  magAmmoFilter = signal('');
  magSearch = signal('');

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
        case 'mass': av = a.mass ?? 0; bv = b.mass ?? 0; break;
        default: av = a.dps; bv = b.dps;
      }
      return dir === 'asc' ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });

    return list;
  });

  antiPersonnel = computed(() => this.filtered().filter(w => w.category !== 'Anti-Ship'));
  antiShip = computed(() => this.filtered().filter(w => w.category === 'Anti-Ship'));

  magAmmoTypes = computed(() => {
    const t = new Set(this.magazines().map(m => m.ammoType));
    return ['', ...Array.from(t).sort()];
  });

  weaponByTag = computed(() => {
    const map = new Map<string, FpsWeapon>();
    for (const w of this.weapons()) map.set(w.className, w);
    return map;
  });

  magFiltered = computed(() => {
    let list = this.magazines();
    const ammo = this.magAmmoFilter();
    const q = this.magSearch().toLowerCase();
    const sort = this.magSortBy();
    const dir = this.magSortDir();

    if (ammo) list = list.filter(m => m.ammoType === ammo);
    if (q) list = list.filter(m =>
      m.name.toLowerCase().includes(q) ||
      m.manufacturer.toLowerCase().includes(q) ||
      m.weaponTag.toLowerCase().includes(q)
    );

    list = [...list].sort((a, b) => {
      if (sort === 'name') {
        return dir === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
      }
      const av = (a as any)[sort] ?? 0;
      const bv = (b as any)[sort] ?? 0;
      return dir === 'asc' ? av - bv : bv - av;
    });
    return list;
  });

  constructor(private http: HttpClient, private data: DataService) {
    // Re-fetch when the LIVE/PTU slider flips so the table tracks
    // whichever mode is active.
    effect(() => {
      const prefix = this.data.dataPrefix();
      this.loaded.set(false);
      this.http.get<{ weapons: FpsWeapon[]; magazines?: FpsMagazine[] }>(`${prefix}versedb_fps.json`).subscribe({
        next: (d) => {
          this.weapons.set(d.weapons);
          this.magazines.set(d.magazines ?? []);
          this.loaded.set(true);
        },
        error: () => this.loaded.set(true),
      });
    });
  }

  toggleSort(col: 'dps' | 'alphaDamage' | 'fireRate' | 'magazineSize' | 'name' | 'mass' | 'adsTime' | 'adsZoomScale'): void {
    if (this.sortBy() === col) {
      this.sortDir.set(this.sortDir() === 'desc' ? 'asc' : 'desc');
    } else {
      this.sortBy.set(col);
      this.sortDir.set('desc');
    }
  }

  toggleMagSort(col: 'name' | 'ammoCount' | 'mass' | 'size'): void {
    if (this.magSortBy() === col) {
      this.magSortDir.set(this.magSortDir() === 'desc' ? 'asc' : 'desc');
    } else {
      this.magSortBy.set(col);
      this.magSortDir.set(col === 'name' ? 'asc' : 'desc');
    }
  }

  sortIndicator(col: string): string {
    if (this.sortBy() !== col) return '';
    return this.sortDir() === 'desc' ? ' \u25BE' : ' \u25B4';
  }

  magSortIndicator(col: string): string {
    if (this.magSortBy() !== col) return '';
    return this.magSortDir() === 'desc' ? ' \u25BE' : ' \u25B4';
  }

  weaponNameForMag(m: FpsMagazine): string {
    const w = this.weaponByTag().get(m.weaponTag);
    return w?.name ?? m.weaponTag;
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
