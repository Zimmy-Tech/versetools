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
  selectedShip = signal<Ship | null>(null);
  boostedMode = signal(false);
  openPicker = signal<string | null>(null);
  pickerSearch = signal('');
  compactLoadout = signal<Record<string, string>>({});

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

  // ── Cached merged loadout ─────────────────────────
  private mergedLoadout = computed(() => {
    const ship = this.selectedShip();
    if (!ship) return {};
    const dl = ship.defaultLoadout ?? {};
    const overrides = this.compactLoadout();
    return { ...dl, ...overrides };
  });

  // ── Fast item lookup ──────────────────────────────
  private lookupItem(cls: string): Item | null {
    return this.data.itemMap().get(cls.toLowerCase()) ?? null;
  }

  private mergedItems = computed(() => {
    const merged = this.mergedLoadout();
    const result: Item[] = [];
    for (const cls of Object.values(merged)) {
      const item = this.lookupItem(cls);
      if (item) result.push(item);
    }
    return result;
  });

  private itemsByType = computed(() => {
    const map = new Map<string, Item[]>();
    for (const item of this.mergedItems()) {
      const list = map.get(item.type) ?? [];
      list.push(item);
      map.set(item.type, list);
    }
    return map;
  });

  // ── Cached derived data ───────────────────────────

  private cachedWeapons = computed(() => {
    const guns = [
      ...(this.itemsByType().get('WeaponGun') ?? []),
      ...(this.itemsByType().get('WeaponTachyon') ?? []),
    ];
    const grouped = new Map<string, { name: string; size: number; type: string; count: number }>();
    for (const g of guns) {
      if (grouped.has(g.name)) grouped.get(g.name)!.count++;
      else grouped.set(g.name, { name: g.name, size: g.size ?? 0, type: g.isBallistic ? 'BAL' : 'NRG', count: 1 });
    }
    return [...grouped.values()].sort((a, b) => b.size - a.size);
  });

  private cachedMissiles = computed(() => {
    const msls = this.itemsByType().get('Missile') ?? [];
    const grouped = new Map<string, { name: string; size: number; count: number }>();
    for (const m of msls) {
      if (grouped.has(m.name)) grouped.get(m.name)!.count++;
      else grouped.set(m.name, { name: m.name, size: m.size ?? 0, count: 1 });
    }
    return [...grouped.values()].sort((a, b) => b.size - a.size);
  });

  private cachedShields = computed(() => {
    return (this.itemsByType().get('Shield') ?? []).map(i => ({ name: i.name, size: i.size ?? 0, hp: i.hp ?? 0 }));
  });

  private cachedClassMax = computed(() => {
    const ship = this.selectedShip();
    if (!ship) return { dps: 1, shield: 1, hull: 1, armor: 1 };
    const sizeClass = ship.size ?? 'medium';
    const ships = this.data.ships().filter(s => s.size === sizeClass);
    const itemMap = this.data.itemMap();
    let maxDps = 0, maxShield = 0, maxHull = 0, maxArmor = 0;
    for (const s of ships) {
      let dps = 0, shield = 0;
      for (const cls of Object.values(s.defaultLoadout ?? {})) {
        const item = itemMap.get(cls.toLowerCase());
        if (!item) continue;
        if ((item.type === 'WeaponGun' || item.type === 'WeaponTachyon') && item.dps) dps += item.dps;
        if (item.type === 'Shield' && item.hp) shield += item.hp;
      }
      if (dps > maxDps) maxDps = dps;
      if (shield > maxShield) maxShield = shield;
      if ((s.bodyHp ?? 0) > maxHull) maxHull = s.bodyHp ?? 0;
      if ((s.armorHp ?? 0) > maxArmor) maxArmor = s.armorHp ?? 0;
    }
    return { dps: maxDps || 1, shield: maxShield || 1, hull: maxHull || 1, armor: maxArmor || 1 };
  });

  // ── Public accessors (used by template) ───────────

  getWeapons(s: Ship) { return this.cachedWeapons(); }
  getMissiles(s: Ship) { return this.cachedMissiles(); }
  getShields(s: Ship) { return this.cachedShields(); }
  getTotalShieldHP(s: Ship) { return this.cachedShields().reduce((sum, sh) => sum + sh.hp, 0); }
  getClassMax(s: Ship) { return this.cachedClassMax(); }

  getPowerPlants(s: Ship): { name: string; size: number; output: number }[] {
    return (this.itemsByType().get('PowerPlant') ?? []).map(i => ({ name: i.name, size: i.size ?? 0, output: (i as any).powerOutput ?? 0 }));
  }

  getCoolers(s: Ship): { name: string; size: number; rate: number }[] {
    return (this.itemsByType().get('Cooler') ?? []).map(i => ({ name: i.name, size: i.size ?? 0, rate: (i as any).coolingRate ?? 0 }));
  }

  getQD(s: Ship): Item | null { return (this.itemsByType().get('QuantumDrive') ?? [])[0] ?? null; }
  getRadar(s: Ship): Item | null { return (this.itemsByType().get('Radar') ?? [])[0] ?? null; }
  getFlightBlade(s: Ship): Item | null { return (this.itemsByType().get('FlightController') ?? [])[0] ?? null; }

  getTotalDPS(s: Ship): number {
    const guns = [...(this.itemsByType().get('WeaponGun') ?? []), ...(this.itemsByType().get('WeaponTachyon') ?? [])];
    return Math.round(guns.reduce((sum, g) => sum + (g.dps ?? 0), 0));
  }

  getTotalAlpha(s: Ship): number {
    const guns = [...(this.itemsByType().get('WeaponGun') ?? []), ...(this.itemsByType().get('WeaponTachyon') ?? [])];
    return Math.round(guns.reduce((sum, g) => sum + (g.alphaDamage ?? 0), 0));
  }

  getVelocityRange(s: Ship): { min: number; max: number } | null {
    const guns = [...(this.itemsByType().get('WeaponGun') ?? []), ...(this.itemsByType().get('WeaponTachyon') ?? [])];
    const speeds = guns.map(g => g.projectileSpeed ?? 0).filter(v => v > 0);
    if (!speeds.length) return null;
    return { min: Math.min(...speeds), max: Math.max(...speeds) };
  }

  getWeaponSpeed(name: string, s: Ship): number {
    const guns = [...(this.itemsByType().get('WeaponGun') ?? []), ...(this.itemsByType().get('WeaponTachyon') ?? [])];
    return guns.find(g => g.name === name)?.projectileSpeed ?? 0;
  }

  getEffectiveRange(s: Ship): number | null {
    const guns = [...(this.itemsByType().get('WeaponGun') ?? []), ...(this.itemsByType().get('WeaponTachyon') ?? [])];
    const ranges = guns.map(g => g.range ?? 0).filter(v => v > 0);
    return ranges.length ? Math.min(...ranges) : null;
  }

  getMissileTotalAlpha(s: Ship): number {
    return Math.round((this.itemsByType().get('Missile') ?? []).reduce((sum, m) => sum + (m.alphaDamage ?? 0), 0));
  }

  getMissileLockRange(s: Ship): { min: number; max: number } | null {
    const maxRanges = (this.itemsByType().get('Missile') ?? []).map(m => m.lockRangeMax ?? 0).filter(v => v > 0);
    if (!maxRanges.length) return null;
    return { min: Math.min(...maxRanges), max: Math.max(...maxRanges) };
  }

  getShieldRegen(s: Ship): number {
    return (this.itemsByType().get('Shield') ?? []).reduce((sum, sh) => sum + ((sh as any).regenRate ?? 0), 0);
  }

  getTotalEHP(s: Ship): number {
    return this.getTotalShieldHP(s) + (s.bodyHp ?? 0) + (s.armorHp ?? 0);
  }

  getShieldItem(ship: Ship, index: number): Item | null {
    return (this.itemsByType().get('Shield') ?? [])[index] ?? null;
  }

  // ── Weapon slots (hardpoint hierarchy) ────────────

  getWeaponSlots(s: Ship): { hpId: string; hpSize: number; hpLabel: string; parent: Item | null; guns: { key: string; item: Item }[] }[] {
    const merged = this.mergedLoadout();
    const slots: { hpId: string; hpSize: number; hpLabel: string; parent: Item | null; guns: { key: string; item: Item }[] }[] = [];

    for (const hp of s.hardpoints ?? []) {
      if (hp.type !== 'Turret' && hp.type !== 'TurretBase' && hp.type !== 'WeaponGun' && hp.type !== 'WeaponTachyon') continue;
      if (hp.id.toLowerCase().includes('pdc') || hp.id.toLowerCase().includes('missile') || hp.id.toLowerCase().includes('torpedo') || hp.id.toLowerCase().includes('camera')) continue;

      const parentCls = merged[hp.id];
      const parentItem = parentCls ? this.lookupItem(parentCls) : null;

      if (parentItem && (parentItem.type === 'WeaponGun' || parentItem.type === 'WeaponTachyon')) {
        slots.push({ hpId: hp.id, hpSize: hp.maxSize, hpLabel: hp.label ?? hp.id, parent: null, guns: [{ key: hp.id, item: parentItem }] });
        continue;
      }

      const prefix = hp.id.toLowerCase() + '.';
      const dl = s.defaultLoadout ?? {};
      const allChildren = Object.keys(dl).filter(k => k.toLowerCase().startsWith(prefix));
      const leaves = allChildren.filter(k => !allChildren.some(k2 => k2.toLowerCase().startsWith(k.toLowerCase() + '.')));

      const guns: { key: string; item: Item }[] = [];
      for (const lk of leaves) {
        const cls = merged[lk] ?? dl[lk];
        if (!cls) continue;
        const item = this.lookupItem(cls);
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

  // ── Picker helpers ────────────────────────────────

  private pickerCache = new Map<string, Item[]>();

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

  getWeaponOptions(size: number): Item[] {
    const q = this.pickerSearch().toLowerCase();
    return this.data.items()
      .filter(i => (i.type === 'WeaponGun' || i.type === 'WeaponTachyon') && (i.size ?? 0) === size && (i.dps ?? 0) > 0)
      .filter(i => !i.className.endsWith('_turret') && !i.className.endsWith('_lowpoly'))
      .filter(i => !q || i.name.toLowerCase().includes(q))
      .sort((a, b) => (b.dps ?? 0) - (a.dps ?? 0));
  }

  getMountOptions(size: number): Item[] {
    const q = this.pickerSearch().toLowerCase();
    return this.data.items()
      .filter(i => i.type === 'WeaponMount' && (i.size ?? 0) === size)
      .filter(i => !q || i.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  setCompactItem(hpKey: string, item: Item): void {
    this.compactLoadout.update(lo => ({ ...lo, [hpKey]: item.className }));
    this.openPicker.set(null);
    this.pickerSearch.set('');
  }

  getEquipped(ship: Ship, hpKey: string, type: string): Item | null {
    const cls = this.mergedLoadout()[hpKey];
    if (cls) {
      const item = this.lookupItem(cls);
      if (item && item.type === type) return item;
    }
    // Fall back: find first matching type from this hp key in default loadout
    const dl = ship.defaultLoadout ?? {};
    const dlCls = dl[hpKey];
    if (dlCls) {
      const item = this.lookupItem(dlCls);
      if (item && item.type === type) return item;
    }
    return null;
  }

  getHardpointKeys(ship: Ship, type: string): string[] {
    const dl = ship.defaultLoadout ?? {};
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const [k, cls] of Object.entries(dl)) {
      const item = this.lookupItem(cls);
      if (item && item.type === type && !seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
    return keys;
  }

  // ── Gauge / visualization helpers ─────────────────

  getGaugeArc(value: number, max: number): string {
    const circumference = 2 * Math.PI * 34;
    const pct = Math.min(value / max, 1);
    const filled = circumference * pct;
    return `${filled} ${circumference - filled}`;
  }

  getHalfGaugeArc(pct: number): string {
    const arcLength = Math.PI * 35;
    const filled = arcLength * Math.min(pct / 100, 1);
    return `${filled} ${arcLength}`;
  }

  getSpeedSegments(ship: Ship): { zone: string }[] {
    const nav = ship.navSpeed ?? 1;
    const scm = ship.scmSpeed ?? 0;
    const boost = ship.boostSpeedFwd ?? 0;
    const total = 30;
    const segments: { zone: string }[] = [];
    for (let i = 0; i < total; i++) {
      const speed = ((i + 1) / total) * nav;
      if (speed <= scm) segments.push({ zone: 'scm' });
      else if (speed <= boost) segments.push({ zone: 'boost' });
      else segments.push({ zone: 'nav' });
    }
    return segments;
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

  sumCount = (acc: number, m: { count: number }) => acc + m.count;

  /** Detailed missile data for ordnance visualizations */
  getMissileDetails(s: Ship): { name: string; size: number; count: number; alpha: number; acq: string; speed: number; lockTime: number; lockMax: number; totalAlpha: number }[] {
    const msls = [...(this.itemsByType().get('Missile') ?? [])];
    const grouped = new Map<string, { name: string; size: number; count: number; alpha: number; acq: string; speed: number; lockTime: number; lockMax: number }>();
    for (const m of msls) {
      if (grouped.has(m.name)) grouped.get(m.name)!.count++;
      else grouped.set(m.name, {
        name: m.name, size: m.size ?? 0, count: 1,
        alpha: m.alphaDamage ?? 0,
        acq: (m.acquisition ?? m.subType ?? '').toUpperCase(),
        speed: m.projectileSpeed ?? 0,
        lockTime: m.lockTime ?? 0,
        lockMax: m.lockRangeMax ?? 0,
      });
    }
    return [...grouped.values()].map(g => ({ ...g, totalAlpha: g.alpha * g.count })).sort((a, b) => b.totalAlpha - a.totalAlpha);
  }

  getTotalMissileAlpha(s: Ship): number {
    return this.getMissileDetails(s).reduce((sum, m) => sum + m.totalAlpha, 0);
  }

  getTotalMissileCount(s: Ship): number {
    return this.getMissileDetails(s).reduce((sum, m) => sum + m.count, 0);
  }

  acqColor(acq: string): string {
    if (acq.includes('INFRARED') || acq.includes('IR')) return '#ff6666';
    if (acq.includes('ELECTRO') || acq.includes('EM')) return 'var(--accent)';
    if (acq.includes('CROSS') || acq.includes('CS')) return '#f0a500';
    return 'var(--text3)';
  }

  acqShort(acq: string): string {
    if (acq.includes('INFRARED')) return 'IR';
    if (acq.includes('ELECTRO')) return 'EM';
    if (acq.includes('CROSS')) return 'CS';
    return acq.substring(0, 2);
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
