import { Component, signal, computed } from '@angular/core';
import { HttpClient } from '@angular/common/http';

interface FpsWeapon {
  className: string;
  name: string;
  manufacturer: string;
  type: string;
  subType: string;
  fireRate: number;
  isCharged?: boolean | null;
  alphaDamage: number;
  dps: number;
}

interface BodyZone {
  id: string;
  label: string;
  hp: number;
  armoredMult: number;
  nakedMult: number;
  stunMult: number;
  isHeadshot: boolean;
}

const BODY_ZONES: BodyZone[] = [
  { id: 'head',     label: 'Head',      hp: 30, armoredMult: 1.5, nakedMult: 4.0, stunMult: 2.0, isHeadshot: true },
  { id: 'torso',    label: 'Torso',     hp: 60, armoredMult: 1.0, nakedMult: 2.0, stunMult: 1.0, isHeadshot: false },
  { id: 'leftArm',  label: 'Left Arm',  hp: 36, armoredMult: 0.8, nakedMult: 1.5, stunMult: 0.1, isHeadshot: false },
  { id: 'rightArm', label: 'Right Arm', hp: 36, armoredMult: 0.8, nakedMult: 1.5, stunMult: 0.1, isHeadshot: false },
  { id: 'leftLeg',  label: 'Left Leg',  hp: 48, armoredMult: 0.8, nakedMult: 1.5, stunMult: 1.0, isHeadshot: false },
  { id: 'rightLeg', label: 'Right Leg', hp: 48, armoredMult: 0.8, nakedMult: 1.5, stunMult: 1.0, isHeadshot: false },
];

const HEALTH_POOL = 100;

const ARMOR_TIERS = [
  { label: 'Naked', dr: 0, mult: 'naked' },
  { label: 'Undersuit (10%)', dr: 0.10, mult: 'armored' },
  { label: 'Light (20%)', dr: 0.20, mult: 'armored' },
  { label: 'Medium (30%)', dr: 0.30, mult: 'armored' },
  { label: 'Heavy (40%)', dr: 0.40, mult: 'armored' },
];

@Component({
  selector: 'app-fps-ttk',
  standalone: true,
  templateUrl: './fps-ttk.html',
  styleUrl: './fps-ttk.scss',
})
export class FpsTtkComponent {
  weapons = signal<FpsWeapon[]>([]);
  loaded = signal(false);
  selectedWeapon = signal<FpsWeapon | null>(null);
  selectedArmor = signal(2); // index into ARMOR_TIERS, default Light
  hoveredZone = signal<string | null>(null);

  readonly zones = BODY_ZONES;
  readonly healthPool = HEALTH_POOL;
  readonly armorTiers = ARMOR_TIERS;

  weaponSearch = signal('');
  filteredWeapons = computed(() => {
    const q = this.weaponSearch().toLowerCase();
    let list = this.weapons().filter(w => w.alphaDamage > 0 && w.fireRate > 0);
    if (q) list = list.filter(w => w.name.toLowerCase().includes(q));
    return list.sort((a, b) => b.dps - a.dps);
  });

  currentArmor = computed(() => this.armorTiers[this.selectedArmor()]);

  zoneStats = computed(() => {
    const weapon = this.selectedWeapon();
    const armor = this.currentArmor();
    if (!weapon) return null;

    return BODY_ZONES.map(zone => {
      const isNaked = armor.dr === 0;
      const zoneMult = isNaked ? zone.nakedMult : zone.armoredMult;
      const drMult = 1 - armor.dr;
      const effectiveDmg = weapon.alphaDamage * zoneMult * drMult;
      const shotsToDown = effectiveDmg > 0 ? Math.ceil(HEALTH_POOL / effectiveDmg) : Infinity;
      const ttk = weapon.fireRate > 0 ? ((shotsToDown - 1) / (weapon.fireRate / 60)) : Infinity;
      return {
        ...zone,
        effectiveDmg: Math.round(effectiveDmg * 100) / 100,
        shotsToDown,
        ttk: Math.round(ttk * 1000) / 1000,
      };
    });
  });

  constructor(private http: HttpClient) {
    this.http.get<{ weapons: FpsWeapon[] }>('live/versedb_fps.json').subscribe(data => {
      this.weapons.set(data.weapons);
      this.loaded.set(true);
      // Default to first weapon with DPS
      const first = data.weapons.find(w => w.dps > 0);
      if (first) this.selectedWeapon.set(first);
    });
  }

  selectWeapon(className: string): void {
    const w = this.weapons().find(w => w.className === className) ?? null;
    this.selectedWeapon.set(w);
  }

  getZoneStat(zoneId: string) {
    return this.zoneStats()?.find(z => z.id === zoneId) ?? null;
  }

  fmtTtk(ttk: number): string {
    if (!isFinite(ttk)) return '\u2014';
    if (ttk < 1) return (ttk * 1000).toFixed(0) + 'ms';
    return ttk.toFixed(2) + 's';
  }
}
