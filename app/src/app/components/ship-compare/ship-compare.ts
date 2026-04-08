import { Component, signal, computed, effect } from '@angular/core';
import { DataService } from '../../services/data.service';
import { Ship, Item, Hardpoint } from '../../models/db.models';

type RowDef = [string, (s: Ship) => string, ((v: string) => number) | null, boolean | null];

const SLOT_COLORS = ['#00c8ff', '#4aff7a', '#ffaa4a', '#e87ae8'];

// localStorage key for persisting selected ships across visits
const STORAGE_KEY = 'shipCompare.slots.v1';

@Component({
  selector: 'app-ship-compare',
  standalone: true,
  templateUrl: './ship-compare.html',
  styleUrl: './ship-compare.scss',
})
export class ShipCompareComponent {
  slots = signal<(Ship | null)[]>([null, null, null, null]);
  readonly slotColors = SLOT_COLORS;

  searchQueries = signal<string[]>(['', '', '', '']);
  pickerOpen = signal<boolean[]>([false, false, false, false]);

  allShips = computed(() =>
    [...this.data.ships()].sort((a, b) => a.name.localeCompare(b.name))
  );

  filteredShips = computed(() => {
    const ships = this.allShips();
    return this.searchQueries().map(q => {
      if (!q) return ships;
      const lower = q.toLowerCase();
      return ships.filter(s => s.name.toLowerCase().includes(lower));
    });
  });

  openPicker(index: number): void {
    const open = [false, false, false, false];
    open[index] = true;
    this.pickerOpen.set(open);
    this.updateSearch(index, '');
    setTimeout(() => {
      const el = document.querySelector('.picker-search') as HTMLInputElement;
      el?.focus();
    });
  }

  closePicker(index: number): void {
    setTimeout(() => {
      const open = [...this.pickerOpen()];
      open[index] = false;
      this.pickerOpen.set(open);
    }, 150);
  }

  pickShip(index: number, className: string): void {
    this.setSlot(index, className);
    const open = [...this.pickerOpen()];
    open[index] = false;
    this.pickerOpen.set(open);
  }

  // ── Row definitions ──────────────────────────────────────

  private overviewRows: RowDef[] = [
    ['Manufacturer', s => s.manufacturer || '—',                   null, null],
    ['Role',         s => s.role || '—',                           null, null],
    ['Size',         s => (s.size || '—').toUpperCase(),           null, null],
    ['Mass',         s => s.mass ? s.mass.toLocaleString() + ' kg' : '—', null, null],
    ['Crew',         s => s.crew?.toString() ?? '—',               null, null],
  ];

  private dpsRows: RowDef[] = [
    ['Peak DPS (Default Equip)', s => this.calcPeakDPS(s).toFixed(0),            v => parseFloat(v) || 0, true],
    ['Pilot Alpha',       s => this.calcAlpha(s).toFixed(0),              v => parseFloat(v) || 0, true],
    ['Missile Damage',    s => this.calcMissileDmg(s).toFixed(0),         v => parseFloat(v) || 0, true],
  ];

  private hardpointRows: RowDef[] = [
    ['Pilot Weapons',     s => this.countHardpoints(s, 'pilot').toString(),   v => parseInt(v) || 0, true],
    ['Crew Weapons',      s => this.countHardpoints(s, 'crew').toString(),    v => parseInt(v) || 0, true],
    ['Missiles',          s => this.countHardpoints(s, 'missile').toString(), v => parseInt(v) || 0, true],
    ['Shields',           s => this.countHardpoints(s, 'shield').toString(),  v => parseInt(v) || 0, true],
    ['Total Hardpoints',  s => this.countHardpoints(s, 'all').toString(),     v => parseInt(v) || 0, true],
  ];

  private hullRows: RowDef[] = [
    ['Total HP',       s => s.totalHp ? s.totalHp.toLocaleString() : '—',      v => parseFloat(v.replace(/,/g, '')) || 0, true],
    ['Body HP',        s => s.bodyHp ? s.bodyHp.toLocaleString() : '—',        v => parseFloat(v.replace(/,/g, '')) || 0, true],
    ['Armor HP',       s => s.armorHp ? s.armorHp.toLocaleString() : '—',      v => parseFloat(v.replace(/,/g, '')) || 0, true],
    ['Phys Deflect',   s => s.armorDeflectPhys?.toString() ?? '—',              v => parseFloat(v) || 0, true],
    ['Enrg Deflect',   s => s.armorDeflectEnrg?.toString() ?? '—',              v => parseFloat(v) || 0, true],
  ];

  private flightRows: RowDef[] = [
    ['SCM Speed',      s => s.scmSpeed ? s.scmSpeed + ' m/s' : '—',            v => parseFloat(v) || 0, true],
    ['NAV Speed',      s => s.navSpeed ? s.navSpeed + ' m/s' : '—',            v => parseFloat(v) || 0, true],
    ['AB Forward',     s => s.boostSpeedFwd ? s.boostSpeedFwd + ' m/s' : '—',  v => parseFloat(v) || 0, true],
  ];

  boostedAccel = signal(false);
  boostedRotation = signal(false);

  accelRows = computed<RowDef[]>(() => {
    const b = this.boostedAccel();
    return [
      ['Accel Fwd',    s => (b ? s.accelAbFwd : s.accelFwd) ? (b ? s.accelAbFwd : s.accelFwd) + ' G' : '—',       v => parseFloat(v) || 0, true],
      ['Accel Retro',  s => (b ? s.accelAbRetro : s.accelRetro) ? (b ? s.accelAbRetro : s.accelRetro) + ' G' : '—', v => parseFloat(v) || 0, true],
      ['Accel Strafe', s => (b ? s.accelAbStrafe : s.accelStrafe) ? (b ? s.accelAbStrafe : s.accelStrafe) + ' G' : '—', v => parseFloat(v) || 0, true],
      ['Accel Up',     s => (b ? s.accelAbUp : s.accelUp) ? (b ? s.accelAbUp : s.accelUp) + ' G' : '—',           v => parseFloat(v) || 0, true],
      ['Accel Down',   s => (b ? s.accelAbDown : s.accelDown) ? (b ? s.accelAbDown : s.accelDown) + ' G' : '—',   v => parseFloat(v) || 0, true],
    ];
  });

  rotationRows = computed<RowDef[]>(() => {
    const b = this.boostedRotation();
    return [
      ['Pitch', s => (b ? (s as any).pitchBoosted : (s as any).pitch) ? (b ? (s as any).pitchBoosted : (s as any).pitch) + ' °/s' : '—', v => parseFloat(v) || 0, true],
      ['Yaw',   s => (b ? (s as any).yawBoosted : (s as any).yaw) ? (b ? (s as any).yawBoosted : (s as any).yaw) + ' °/s' : '—',       v => parseFloat(v) || 0, true],
      ['Roll',  s => (b ? (s as any).rollBoosted : (s as any).roll) ? (b ? (s as any).rollBoosted : (s as any).roll) + ' °/s' : '—',   v => parseFloat(v) || 0, true],
    ];
  });

  private miscRows: RowDef[] = [
    ['Cargo',          s => (s.cargoCapacity ?? 0) + ' SCU',                    v => parseInt(v) || 0, true],
    ['H2 Fuel',        s => s.hydrogenFuelCapacity ? s.hydrogenFuelCapacity + ' mSCU' : '—', v => parseFloat(v) || 0, true],
    ['QT Fuel',        s => s.quantumFuelCapacity ? s.quantumFuelCapacity + ' mSCU' : '—',  v => parseFloat(v) || 0, true],
  ];

  sections = computed(() => {
    return [
      { title: 'Overview',       rows: this.overviewRows },
      { title: 'DPS Output',     rows: this.dpsRows },
      { title: 'Hardpoints',     rows: this.hardpointRows },
      { title: 'Hull & Armor',   rows: this.hullRows },
      { title: 'Flight',         rows: this.flightRows },
      { title: 'Acceleration',   rows: this.accelRows() },
      { title: 'Rotation',       rows: this.rotationRows() },
      { title: 'Misc',           rows: this.miscRows },
    ];
  });

  constructor(public data: DataService) {
    // Restore slot selection from localStorage once ship data has loaded.
    // data.ships() is empty during the synchronous constructor pass.
    effect(() => {
      const ships = this.data.ships();
      if (!ships.length) return;
      if (!this.slots().every(s => s === null)) return;
      const restored = this.loadSlotsFromStorage(ships);
      if (restored) this.slots.set(restored);
    });

    // Persist slot selection whenever it changes. Skip the initial all-null
    // state so we don't clobber a saved selection during the brief window
    // before data loads.
    effect(() => {
      const slots = this.slots();
      if (slots.every(s => s === null)) return;
      try {
        const classNames = slots.map(s => s?.className ?? null);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(classNames));
      } catch { /* localStorage may be unavailable (private mode, etc.) */ }
    });
  }

  private loadSlotsFromStorage(ships: Ship[]): (Ship | null)[] | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const classNames = JSON.parse(raw);
      if (!Array.isArray(classNames) || classNames.length !== 4) return null;
      const restored = classNames.map((cn: unknown) =>
        typeof cn === 'string' ? (ships.find(s => s.className === cn) ?? null) : null
      );
      return restored.some(s => s !== null) ? restored : null;
    } catch {
      return null;
    }
  }

  setSlot(index: number, className: string): void {
    const ship = className ? (this.data.ships().find(s => s.className === className) ?? null) : null;
    const updated = [...this.slots()];
    updated[index] = ship;
    this.slots.set(updated);
  }

  updateSearch(index: number, value: string): void {
    const updated = [...this.searchQueries()];
    updated[index] = value;
    this.searchQueries.set(updated);
  }

  getCellValue(row: RowDef, ship: Ship | null): string {
    return ship ? row[1](ship) : '—';
  }

  isBest(row: RowDef, index: number): boolean {
    const numFn = row[2];
    const higherBetter = row[3];
    if (!numFn || higherBetter === null) return false;
    const ships = this.slots();
    const vals = ships.map(s => s ? numFn(row[1](s)) : (higherBetter ? -Infinity : Infinity));
    const best = higherBetter ? Math.max(...vals) : Math.min(...vals);
    if (!isFinite(best) || best === 0) return false;
    const ship = ships[index];
    return ship !== null && numFn(row[1](ship)) === best;
  }

  // ── DPS calculations from default loadout ────────────────

  private getDefaultWeapons(ship: Ship): Item[] {
    const dl = ship.defaultLoadout ?? {};
    const items = this.data.itemMap();
    const weapons: Item[] = [];
    for (const [, itemCls] of Object.entries(dl)) {
      const item = items.get(itemCls.toLowerCase());
      if (item && (item.type === 'WeaponGun' || item.type === 'WeaponTachyon') && (item.dps ?? 0) > 0) {
        weapons.push(item);
      }
    }
    return weapons;
  }

  private calcPeakDPS(ship: Ship): number {
    return this.getDefaultWeapons(ship).reduce((sum, w) => sum + (w.dps ?? 0), 0);
  }

  private calcAlpha(ship: Ship): number {
    return this.getDefaultWeapons(ship).reduce((sum, w) => sum + (w.alphaDamage ?? 0), 0);
  }

  private calcMissileDmg(ship: Ship): number {
    const dl = ship.defaultLoadout ?? {};
    const items = this.data.itemMap();
    let total = 0;
    for (const [, itemCls] of Object.entries(dl)) {
      const item = items.get(itemCls.toLowerCase());
      if (item && item.type === 'Missile' && (item.alphaDamage ?? 0) > 0) {
        total += item.alphaDamage!;
      }
    }
    return total;
  }

  private countHardpoints(ship: Ship, category: string): number {
    const hps = ship.hardpoints;
    const dl = ship.defaultLoadout ?? {};
    switch (category) {
      case 'pilot': return hps.filter(h => h.type === 'WeaponGun' || (h.type === 'Turret' && !h.id.includes('crew'))).length;
      case 'crew': return hps.filter(h => h.type === 'Turret' && h.id.includes('crew')).length;
      case 'missile': return hps.filter(h => h.type === 'MissileLauncher').length;
      case 'shield': return hps.filter(h => h.type === 'Shield').length;
      case 'all': return hps.filter(h => !['FlightController', 'LifeSupportGenerator'].includes(h.type)).length;
      default: return 0;
    }
  }
}
