import { Component, computed, signal, effect, OnInit, OnDestroy } from '@angular/core';
import { DataService } from '../../services/data.service';
import { PowerBarsComponent } from '../power-bars/power-bars';
import { Ship, Item } from '../../models/db.models';

@Component({
  selector: 'app-compact-view',
  standalone: true,
  imports: [PowerBarsComponent],
  templateUrl: './compact-view.html',
  styleUrl: './compact-view.scss',
})
export class CompactViewComponent implements OnInit, OnDestroy {
  Math = Math;

  ngOnInit(): void { this.data.compactMode.set(true); }
  ngOnDestroy(): void { this.data.compactMode.set(false); }

  searchQuery = signal('');
  showDropdown = signal(false);
  activeSection = signal<'overview' | 'weapons' | 'systems' | 'power'>('overview');
  boostedMode = signal(false);
  selectedShip = signal<Ship | null>(null);

  constructor(public data: DataService) {
    effect(() => {
      const list = this.data.ships();
      if (list.length && !this.selectedShip()) {
        const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name));
        this.selectedShip.set(sorted[0]);
      }
    });
  }

  filteredShips = computed(() => {
    const q = this.searchQuery().toLowerCase();
    const ships = this.data.ships();
    const filtered = q
      ? ships.filter(s => s.name.toLowerCase().includes(q) || s.manufacturer.toLowerCase().includes(q))
      : ships;
    return [...filtered].sort((a, b) => a.name.localeCompare(b.name));
  });

  selectShip(ship: Ship): void {
    this.selectedShip.set(ship);
    this.searchQuery.set('');
    this.showDropdown.set(false);
    this.compactLoadout.set({});
    this.openPicker.set(null);
    this.pickerSearch.set('');
    this.boostedMode.set(false);
    this.activeSection.set('overview');
  }

  // ── Data helpers ──────────────────────────────────

  private findItems(ship: Ship, type: string): Item[] {
    const dl = ship.defaultLoadout ?? {};
    const overrides = this.compactLoadout();
    const items = this.data.items();
    const result: Item[] = [];
    // Build merged loadout: overrides take precedence
    const merged: Record<string, string> = { ...dl };
    for (const [k, v] of Object.entries(overrides)) {
      merged[k] = v;
    }
    for (const cls of Object.values(merged)) {
      const item = items.find(i => i.className.toLowerCase() === cls.toLowerCase());
      if (item && item.type === type) result.push(item);
    }
    return result;
  }

  getWeapons(ship: Ship): { name: string; size: number; type: string; count: number }[] {
    const guns = this.findItems(ship, 'WeaponGun').concat(this.findItems(ship, 'WeaponTachyon'));
    const grouped = new Map<string, { name: string; size: number; type: string; count: number }>();
    for (const g of guns) {
      if (grouped.has(g.name)) grouped.get(g.name)!.count++;
      else grouped.set(g.name, { name: g.name, size: g.size ?? 0, type: g.isBallistic ? 'BAL' : 'NRG', count: 1 });
    }
    return [...grouped.values()].sort((a, b) => b.size - a.size);
  }

  getMissiles(ship: Ship): { name: string; size: number; count: number }[] {
    const msls = this.findItems(ship, 'Missile');
    const grouped = new Map<string, { name: string; size: number; count: number }>();
    for (const m of msls) {
      if (grouped.has(m.name)) grouped.get(m.name)!.count++;
      else grouped.set(m.name, { name: m.name, size: m.size ?? 0, count: 1 });
    }
    return [...grouped.values()].sort((a, b) => b.size - a.size);
  }

  getShields(ship: Ship): { name: string; size: number; hp: number }[] {
    return this.findItems(ship, 'Shield').map(i => ({ name: i.name, size: i.size ?? 0, hp: i.hp ?? 0 }));
  }

  getTotalShieldHP(ship: Ship): number { return this.getShields(ship).reduce((s, sh) => s + sh.hp, 0); }

  getPowerPlants(ship: Ship): { name: string; size: number; output: number }[] {
    return this.findItems(ship, 'PowerPlant').map(i => ({ name: i.name, size: i.size ?? 0, output: (i as any).powerOutput ?? 0 }));
  }

  getCoolers(ship: Ship): { name: string; size: number; rate: number }[] {
    return this.findItems(ship, 'Cooler').map(i => ({ name: i.name, size: i.size ?? 0, rate: (i as any).coolingRate ?? 0 }));
  }

  getQD(ship: Ship): Item | null { return this.findItems(ship, 'QuantumDrive')[0] ?? null; }
  getRadar(ship: Ship): Item | null { return this.findItems(ship, 'Radar')[0] ?? null; }
  getFlightBlade(ship: Ship): Item | null { return this.findItems(ship, 'FlightController')[0] ?? null; }

  getTotalDPS(ship: Ship): number {
    const guns = this.findItems(ship, 'WeaponGun').concat(this.findItems(ship, 'WeaponTachyon'));
    return Math.round(guns.reduce((s, g) => s + (g.dps ?? 0), 0));
  }

  getTotalAlpha(ship: Ship): number {
    const guns = this.findItems(ship, 'WeaponGun').concat(this.findItems(ship, 'WeaponTachyon'));
    return Math.round(guns.reduce((s, g) => s + (g.alphaDamage ?? 0), 0));
  }

  getVelocityRange(ship: Ship): { min: number; max: number } | null {
    const guns = this.findItems(ship, 'WeaponGun').concat(this.findItems(ship, 'WeaponTachyon'));
    const speeds = guns.map(g => g.projectileSpeed ?? 0).filter(v => v > 0);
    if (!speeds.length) return null;
    return { min: Math.min(...speeds), max: Math.max(...speeds) };
  }

  getWeaponSpeed(name: string, ship: Ship): number {
    const guns = this.findItems(ship, 'WeaponGun').concat(this.findItems(ship, 'WeaponTachyon'));
    return guns.find(g => g.name === name)?.projectileSpeed ?? 0;
  }

  getEffectiveRange(ship: Ship): number | null {
    const guns = this.findItems(ship, 'WeaponGun').concat(this.findItems(ship, 'WeaponTachyon'));
    const ranges = guns.map(g => g.range ?? 0).filter(v => v > 0);
    return ranges.length ? Math.min(...ranges) : null;
  }

  getMissileTotalAlpha(ship: Ship): number {
    return Math.round(this.findItems(ship, 'Missile').reduce((s, m) => s + (m.alphaDamage ?? 0), 0));
  }

  getMissileLockRange(ship: Ship): { min: number; max: number } | null {
    const maxRanges = this.findItems(ship, 'Missile').map(m => m.lockRangeMax ?? 0).filter(v => v > 0);
    if (!maxRanges.length) return null;
    return { min: Math.min(...maxRanges), max: Math.max(...maxRanges) };
  }

  getShieldRegen(ship: Ship): number {
    return this.findItems(ship, 'Shield').reduce((s, sh) => s + ((sh as any).regenRate ?? 0), 0);
  }

  getTotalEHP(ship: Ship): number {
    return this.getTotalShieldHP(ship) + (ship.bodyHp ?? 0) + (ship.armorHp ?? 0);
  }

  sumCount = (acc: number, m: { count: number }) => acc + m.count;

  // Size-class maximums for gauge scaling
  getClassMax(ship: Ship): { dps: number; shield: number; hull: number; armor: number } {
    const sizeClass = ship.size ?? 'medium';
    const ships = this.data.ships().filter(s => s.size === sizeClass);
    let maxDps = 0, maxShield = 0, maxHull = 0, maxArmor = 0;
    for (const s of ships) {
      const dps = this.getTotalDPS(s);
      const shield = this.getTotalShieldHP(s);
      if (dps > maxDps) maxDps = dps;
      if (shield > maxShield) maxShield = shield;
      if ((s.bodyHp ?? 0) > maxHull) maxHull = s.bodyHp ?? 0;
      if ((s.armorHp ?? 0) > maxArmor) maxArmor = s.armorHp ?? 0;
    }
    return { dps: maxDps || 1, shield: maxShield || 1, hull: maxHull || 1, armor: maxArmor || 1 };
  }

  getShieldItem(ship: Ship, index: number): Item | null {
    const shields = this.findItems(ship, 'Shield');
    return shields[index] ?? null;
  }

  getHalfGaugeArc(pct: number): string {
    const arcLength = Math.PI * 35; // semi-circle with r=35
    const filled = arcLength * Math.min(pct / 100, 1);
    return `${filled} ${arcLength}`;
  }

  getGaugeArc(value: number, max: number): string {
    const circumference = 2 * Math.PI * 34; // r=34
    const pct = Math.min(value / max, 1);
    const filled = circumference * pct;
    const gap = circumference - filled;
    return `${filled} ${gap}`;
  }

  getSpeedSegments(ship: Ship): { zone: string }[] {
    const nav = ship.navSpeed ?? 1;
    const scm = ship.scmSpeed ?? 0;
    const boost = ship.boostSpeedFwd ?? 0;
    const total = 30; // number of segments
    const segments: { zone: string }[] = [];
    for (let i = 0; i < total; i++) {
      const pct = (i + 1) / total;
      const speed = pct * nav;
      if (speed <= scm) segments.push({ zone: 'scm' });
      else if (speed <= boost) segments.push({ zone: 'boost' });
      else segments.push({ zone: 'nav' });
    }
    return segments;
  }

  /** Build structured weapon slots: parent mount + child weapons */
  getWeaponSlots(ship: Ship): { hpId: string; hpSize: number; hpLabel: string; parent: Item | null; guns: { key: string; item: Item }[] }[] {
    const dl = ship.defaultLoadout ?? {};
    const items = this.data.items();
    const overrides = this.compactLoadout();
    const slots: { hpId: string; hpSize: number; hpLabel: string; parent: Item | null; guns: { key: string; item: Item }[] }[] = [];

    for (const hp of ship.hardpoints ?? []) {
      if (hp.type !== 'Turret' && hp.type !== 'TurretBase' && hp.type !== 'WeaponGun' && hp.type !== 'WeaponTachyon') continue;
      if (hp.id.toLowerCase().includes('pdc') || hp.id.toLowerCase().includes('missile') || hp.id.toLowerCase().includes('torpedo')) continue;
      if (hp.id.toLowerCase().includes('camera')) continue;

      const parentCls = overrides[hp.id] ?? dl[hp.id];
      const parentItem = parentCls ? items.find(i => i.className.toLowerCase() === parentCls.toLowerCase()) ?? null : null;

      // Direct weapon on the hardpoint (e.g., Inferno S7)
      if (parentItem && (parentItem.type === 'WeaponGun' || parentItem.type === 'WeaponTachyon')) {
        slots.push({ hpId: hp.id, hpSize: hp.maxSize, hpLabel: hp.label ?? hp.id, parent: null, guns: [{ key: hp.id, item: parentItem }] });
        continue;
      }

      // Turret/mount with child weapons
      const prefix = hp.id.toLowerCase() + '.';
      const allChildren = Object.keys(dl).filter(k => k.toLowerCase().startsWith(prefix));
      const leaves = allChildren.filter(k => !allChildren.some(k2 => k2.toLowerCase().startsWith(k.toLowerCase() + '.')));

      const guns: { key: string; item: Item }[] = [];
      for (const lk of leaves) {
        const cls = overrides[lk] ?? dl[lk];
        if (!cls) continue;
        const item = items.find(i => i.className.toLowerCase() === cls.toLowerCase());
        if (item && (item.type === 'WeaponGun' || item.type === 'WeaponTachyon')) {
          guns.push({ key: lk, item });
        }
      }

      if (parentItem || guns.length) {
        slots.push({ hpId: hp.id, hpSize: hp.maxSize, hpLabel: hp.label ?? hp.id, parent: parentItem, guns });
      }
    }
    return slots;
  }

  /** Get weapon options for a given size */
  getWeaponOptions(size: number): Item[] {
    const q = this.pickerSearch().toLowerCase();
    return this.data.items()
      .filter(i => (i.type === 'WeaponGun' || i.type === 'WeaponTachyon') && (i.size ?? 0) === size && (i.dps ?? 0) > 0)
      .filter(i => !i.className.endsWith('_turret') && !i.className.endsWith('_lowpoly'))
      .filter(i => !q || i.name.toLowerCase().includes(q))
      .sort((a, b) => (b.dps ?? 0) - (a.dps ?? 0));
  }

  /** Get mount options for a given size */
  getMountOptions(size: number): Item[] {
    const q = this.pickerSearch().toLowerCase();
    return this.data.items()
      .filter(i => i.type === 'WeaponMount' && (i.size ?? 0) === size)
      .filter(i => !q || i.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  shieldFullRegen(opt: Item): string {
    const hp = opt.hp ?? 0;
    const rate = opt.regenRate ?? 1;
    return rate > 0 ? (hp / rate).toFixed(1) : '—';
  }

  fmtRadarMinPwr(opt: Item): string {
    const pd = opt.powerDraw ?? 0;
    const mcf = opt.minConsumptionFraction ?? 0.25;
    return pd > 0 ? Math.max(1, Math.round(pd * mcf)).toString() : '—';
  }

  // ── Compact pickers ───────────────────────────────
  openPicker = signal<string | null>(null);  // e.g. 'qd', 'pp_0', 'cooler_1', 'radar', 'blade'
  pickerSearch = signal('');

  togglePicker(id: string): void {
    if (this.openPicker() === id) {
      this.openPicker.set(null);
      this.pickerSearch.set('');
    } else {
      this.openPicker.set(id);
      this.pickerSearch.set('');
    }
  }

  getPickerOptions(type: string, size: number): Item[] {
    const q = this.pickerSearch().toLowerCase();
    return this.data.items()
      .filter(i => i.type === type && (i.size ?? 0) === size)
      .filter(i => !q || i.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // Loadout overrides for the compact card (independent of main loadout)
  compactLoadout = signal<Record<string, string>>({});

  setCompactItem(hpKey: string, item: Item): void {
    this.compactLoadout.update(lo => ({ ...lo, [hpKey]: item.className }));
    this.openPicker.set(null);
    this.pickerSearch.set('');
  }

  /** Get the item for a given HP key, checking compact overrides first, then default loadout */
  getEquipped(ship: Ship, hpKey: string, type: string): Item | null {
    const overrideCls = this.compactLoadout()[hpKey];
    if (overrideCls) {
      return this.data.items().find(i => i.className.toLowerCase() === overrideCls.toLowerCase()) ?? null;
    }
    // Fall back to default loadout
    const dl = ship.defaultLoadout ?? {};
    for (const [k, cls] of Object.entries(dl)) {
      const item = this.data.items().find(i => i.className.toLowerCase() === cls.toLowerCase());
      if (item && item.type === type) {
        if (k === hpKey || (!this.compactLoadout()[hpKey])) return item;
      }
    }
    return null;
  }

  /** Get hardpoint keys for a given item type from the ship */
  getHardpointKeys(ship: Ship, type: string): string[] {
    const dl = ship.defaultLoadout ?? {};
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const [k, cls] of Object.entries(dl)) {
      const item = this.data.items().find(i => i.className.toLowerCase() === cls.toLowerCase());
      if (item && item.type === type && !seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
    return keys;
  }

  fmt(val: number | null | undefined, decimals = 0): string {
    if (val == null) return '—';
    return decimals > 0 ? val.toFixed(decimals) : val.toLocaleString();
  }

  fmtCompact(val: number | null | undefined): string {
    if (val == null) return '—';
    if (val >= 1_000_000) return (val / 1_000_000).toFixed(2) + 'm';
    if (val >= 10_000) return (val / 1_000).toFixed(1) + 'k';
    return val.toLocaleString();
  }
}
