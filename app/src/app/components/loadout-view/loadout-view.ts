import { Component, computed, signal, effect, inject } from '@angular/core';
import { Router } from '@angular/router';
import { UpperCasePipe } from '@angular/common';
import { DataService } from '../../services/data.service';
import { DpsPanelComponent } from '../dps-panel/dps-panel';
import { HardpointSlotComponent } from '../hardpoint-slot/hardpoint-slot';
import { PowerBarsComponent } from '../power-bars/power-bars';
import { Hardpoint, Item, Ship } from '../../models/db.models';

@Component({
  selector: 'app-loadout-view',
  standalone: true,
  imports: [DpsPanelComponent, HardpointSlotComponent, PowerBarsComponent, UpperCasePipe],
  templateUrl: './loadout-view.html',
  styleUrl: './loadout-view.scss',
})
export class LoadoutViewComponent {
  hullTreeOpen = signal(false);

  private readonly CATEGORY_ICONS: Record<string, string> = {
    vital: '✦', secondary: '◌', breakable: '⇄', sub: '⊢', thruster: '∷',
  };

  getVitalPartsList(ship: Ship): { name: string; hp: number; depth: number; category: string; icon: string }[] {
    const tree = (ship as any).hullPartsTree;
    if (tree?.length) {
      const result: { name: string; hp: number; depth: number; category: string; icon: string }[] = [];
      const flatten = (nodes: any[], depth: number) => {
        for (const n of nodes) {
          const name = (n.name ?? '').replace(/hardpoint_/gi, '').replace(/_/g, ' ');
          const cat = n.category ?? 'breakable';
          result.push({ name, hp: n.hp ?? 0, depth, category: cat, icon: this.CATEGORY_ICONS[cat] ?? '⊢' });
          if (n.children?.length) flatten(n.children, depth + 1);
        }
      };
      flatten(tree, 0);
      return result;
    }
    // Fallback to flat vitalParts
    return Object.entries(ship.vitalParts ?? {}).map(([k, v]) => ({
      name: k.replace(/_/g, ' '), hp: v as number, depth: 1, category: 'breakable', icon: '⇄',
    }));
  }

  goToSubmit(): void {
    this.router.navigate(['/submit']);
  }

  needsAccelData = computed(() => {
    const ship = this.data.selectedShip();
    if (!ship) return false;
    if (!ship.accelTestedDate) return true;
    const tested = new Date(ship.accelTestedDate).getTime();
    return (Date.now() - tested) > 90 * 24 * 60 * 60 * 1000;
  });

  readonly utilityTypes = ['Shield', 'PowerPlant', 'Cooler', 'QuantumDrive', 'Radar', 'LifeSupportGenerator', 'FlightController'];

  // ── Bulk Equip ────────────────────────────────────
  bulkEquipOpen = signal(false);
  bulkEquipTab = signal<'guns' | 'missiles'>('guns');
  bulkEquipSearch = signal('');
  bulkEquipSize = signal<number | null>(null);

  /** Active sort key + direction for the bulk equip list. */
  bulkSortKey = signal<string>('dps');
  bulkSortAsc = signal(false); // default descending for numeric stats

  /** Click a column header: toggles direction if same key, otherwise
   *  switches to the new key with a sensible default direction. */
  toggleBulkSort(key: string): void {
    if (this.bulkSortKey() === key) {
      this.bulkSortAsc.set(!this.bulkSortAsc());
    } else {
      this.bulkSortKey.set(key);
      // Strings default ascending, numbers default descending
      this.bulkSortAsc.set(key === 'name');
    }
  }

  /** Visual indicator next to a column header for the active sort. */
  bulkSortIndicator(key: string): string {
    if (this.bulkSortKey() !== key) return '';
    return this.bulkSortAsc() ? ' ▲' : ' ▼';
  }

  /** Format a missile lock range (meters) as a compact km string,
   *  e.g. 1500 → "1.5km", 12000 → "12km". Falls back to raw meters
   *  for very small values. */
  fmtLockRange(meters: number): string {
    if (meters < 1000) return `${meters.toFixed(0)}m`;
    const km = meters / 1000;
    return km >= 10 ? `${km.toFixed(0)}km` : `${km.toFixed(1)}km`;
  }

  /** Available gun sizes across all weapon sub-slots. */
  bulkGunSizes = computed(() => {
    const subs = this.subSlotsMap();
    const sizes = new Set<number>();
    for (const children of Object.values(subs)) {
      for (const child of children) {
        if (child.type === 'WeaponGun' && child.maxSize && !child.portTags) sizes.add(child.maxSize);
      }
    }
    return [...sizes].sort((a, b) => a - b);
  });

  /** Available missile sizes across all missile sub-slots. */
  bulkMissileSizes = computed(() => {
    const subs = this.subSlotsMap();
    const sizes = new Set<number>();
    for (const children of Object.values(subs)) {
      for (const child of children) {
        if (child.type === 'Missile' && child.maxSize) sizes.add(child.maxSize);
      }
    }
    return [...sizes].sort((a, b) => a - b);
  });

  /** Sizes for the active tab. */
  bulkEquipSizes = computed(() =>
    this.bulkEquipTab() === 'guns' ? this.bulkGunSizes() : this.bulkMissileSizes()
  );

  /** Items available for the selected bulk equip tab + size. */
  bulkEquipOptions = computed(() => {
    const size = this.bulkEquipSize();
    if (!size) return [];
    const tab = this.bulkEquipTab();
    const q = this.bulkEquipSearch().toLowerCase().trim();
    const sortKey = this.bulkSortKey();
    const asc = this.bulkSortAsc();

    let opts: Item[];
    const shipCls = this.data.selectedShip()?.className ?? '';
    if (tab === 'guns') {
      opts = this.data.items().filter(i => {
        if (i.type !== 'WeaponGun' && i.type !== 'WeaponTachyon') return false;
        if (i.size !== size || (i.dps ?? 0) <= 0) return false;
        const cls = i.className.toLowerCase();
        if (cls.endsWith('_turret') || cls.includes('_aagun_')) return false;
        // Ship-aware exclusion: hides PICKER_BLACKLIST entries plus
        // ship-exclusive guns when not on the matching ship, and (on
        // Wolf ships) every non-Wolf gun.
        return !this.data.isItemExcludedFromBulkEquip(cls, shipCls, i);
      });
    } else {
      opts = this.data.items().filter(i => {
        if (i.type !== 'Missile' || i.size !== size) return false;
        const cls = i.className.toLowerCase();
        // Ground-vehicle missile variants (gmisl_*) are parallel duplicates
        // restricted to ground vehicle hardpoints — never show on ships.
        if (cls.startsWith('gmisl_')) return false;
        // Honour the same blacklist used by per-slot pickers
        if (this.data.isBlacklisted(cls)) return false;
        return true;
      });
    }
    if (q) {
      opts = opts.filter(o =>
        o.name.toLowerCase().includes(q) ||
        (o.manufacturer ?? '').toLowerCase().includes(q)
      );
    }

    // Sort by the active key. Strings use locale compare, numbers use
    // direct subtraction. Nulls are treated as 0/empty so they sort to
    // the bottom of a descending sort.
    return [...opts].sort((a, b) => {
      let va: any = (a as any)[sortKey];
      let vb: any = (b as any)[sortKey];
      if (va == null) va = typeof vb === 'string' ? '' : 0;
      if (vb == null) vb = typeof va === 'string' ? '' : 0;
      let cmp: number;
      if (typeof va === 'string') cmp = va.localeCompare(vb);
      else cmp = (va as number) - (vb as number);
      return asc ? cmp : -cmp;
    });
  });

  private bulkEquipWatcher = effect(() => {
    if (this.data.bulkEquipRequested()) {
      this.data.bulkEquipRequested.set(false);
      this.openBulkEquip();
    }
  });

  private milAWatcher = effect(() => {
    if (this.data.milARequested()) {
      this.data.milARequested.set(false);
      this.applyMilitaryA();
    }
  });

  /** Apply Military Grade A components to all compatible slots. */
  private applyMilitaryA(): void {
    const ship = this.data.selectedShip();
    if (!ship) return;
    const items = this.data.items();

    // Build lookup: type → size → best Military A item
    const milA = new Map<string, Map<number, Item>>();
    const targetTypes = ['Shield', 'PowerPlant', 'Cooler', 'QuantumDrive', 'Radar'];

    for (const item of items) {
      if (!targetTypes.includes(item.type)) continue;
      if (item.grade !== 'A' || item.itemClass !== 'Military') continue;
      const size = item.size ?? 0;
      if (!milA.has(item.type)) milA.set(item.type, new Map());
      const bySize = milA.get(item.type)!;
      const existing = bySize.get(size);
      if (!existing || this.milAPrimaryStat(item) > this.milAPrimaryStat(existing)) {
        bySize.set(size, item);
      }
    }

    // Apply to each component hardpoint (skip locked slots)
    for (const hp of ship.hardpoints) {
      if (this.isSlotLocked(hp)) continue;
      const bySize = milA.get(hp.type);
      if (!bySize) continue;
      const best = bySize.get(hp.maxSize);
      if (best) this.data.setLoadoutItem(hp.id, best);
    }
    this.data.reinitPower();
  }

  /** Primary stat used to pick the best Military A item when multiple exist. */
  private milAPrimaryStat(item: Item): number {
    switch (item.type) {
      case 'Shield': return item.hp ?? 0;
      case 'PowerPlant': return item.powerOutput ?? 0;
      case 'Cooler': return item.coolingRate ?? 0;
      case 'QuantumDrive': return item.speed ?? 0;
      case 'Radar': return item.aimMax ?? 0;
      default: return 0;
    }
  }

  private stealthAWatcher = effect(() => {
    if (this.data.stealthARequested()) {
      this.data.stealthARequested.set(false);
      this.applyStealthA();
    }
  });

  /** Apply Stealth Grade A components to all compatible slots. */
  private applyStealthA(): void {
    const ship = this.data.selectedShip();
    if (!ship) return;
    const items = this.data.items();

    // Build lookup: type → size → best Stealth A item (lowest signature)
    const stealthA = new Map<string, Map<number, Item>>();
    const targetTypes = ['Shield', 'PowerPlant', 'Cooler', 'QuantumDrive', 'Radar'];

    for (const item of items) {
      if (!targetTypes.includes(item.type)) continue;
      if (item.grade !== 'A' || item.itemClass !== 'Stealth') continue;
      const size = item.size ?? 0;
      if (!stealthA.has(item.type)) stealthA.set(item.type, new Map());
      const bySize = stealthA.get(item.type)!;
      const existing = bySize.get(size);
      if (!existing || this.stealthAPrimaryStat(item) < this.stealthAPrimaryStat(existing)) {
        bySize.set(size, item);
      }
    }

    for (const hp of ship.hardpoints) {
      if (this.isSlotLocked(hp)) continue;
      const bySize = stealthA.get(hp.type);
      if (!bySize) continue;
      const best = bySize.get(hp.maxSize);
      if (best) this.data.setLoadoutItem(hp.id, best);
    }
    this.data.reinitPower();
  }

  /** Primary stat for Stealth A: lowest signature wins. */
  private stealthAPrimaryStat(item: Item): number {
    switch (item.type) {
      case 'PowerPlant': return item.emSignature ?? Infinity;
      case 'Cooler': return item.irSignature ?? Infinity;
      case 'Shield': return (item.emSignature ?? 0) + (item.irSignature ?? 0);
      case 'QuantumDrive': return (item.emSignature ?? 0) + (item.irSignature ?? 0);
      case 'Radar': return (item.emSignature ?? 0) + (item.irSignature ?? 0);
      default: return Infinity;
    }
  }

  openBulkEquip(): void {
    this.bulkEquipTab.set('guns');
    const sizes = this.bulkGunSizes();
    this.bulkEquipSize.set(sizes.length ? sizes[0] : null);
    this.bulkEquipSearch.set('');
    this.bulkEquipOpen.set(true);
  }

  switchBulkTab(tab: 'guns' | 'missiles'): void {
    this.bulkEquipTab.set(tab);
    this.bulkEquipSearch.set('');
    const sizes = tab === 'guns' ? this.bulkGunSizes() : this.bulkMissileSizes();
    this.bulkEquipSize.set(sizes.length ? sizes[0] : null);
    // Reset sort to a sensible default for the new tab. Guns default to
    // DPS desc, missiles to alphaDamage desc (since missiles have no DPS).
    this.bulkSortKey.set(tab === 'guns' ? 'dps' : 'alphaDamage');
    this.bulkSortAsc.set(false);
  }

  closeBulkEquip(): void {
    this.bulkEquipOpen.set(false);
  }

  bulkLastApplied = signal('');

  private isSlotLocked(hp: Hardpoint): boolean {
    const flags = hp.flags ?? '';
    return flags.includes('uneditable') || flags.includes('$uneditable');
  }

  applyBulkEquip(item: Item): void {
    const tab = this.bulkEquipTab();
    const subs = this.subSlotsMap();
    const targetType = tab === 'guns' ? 'WeaponGun' : 'Missile';
    for (const children of Object.values(subs)) {
      for (const child of children) {
        if (child.type === targetType && child.maxSize === item.size && !this.isSlotLocked(child)
            && !child.portTags) {
          this.data.setLoadoutItem(child.id, item);
        }
      }
    }
    this.bulkLastApplied.set(item.className);
  }

  collapsedSections = signal<Set<string>>(new Set([
    'pilot-guns', 'crew-guns', 'missiles', 'power', 'pdc', 'tractor', 'coolers', 'ls',
  ]));

  isCollapsed(section: string): boolean {
    return this.collapsedSections().has(section);
  }

  toggleSection(section: string): void {
    this.collapsedSections.update(s => {
      const next = new Set(s);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  }

  // Ship-specific hardpoints that are pilot-controlled despite their controllerTag
  private readonly FORCE_PILOT_HARDPOINTS: Record<string, Set<string>> = {
    'aegs_redeemer': new Set(['hardpoint_turret_remote_front']),
  };

  private isCrewHardpoint(hp: Hardpoint): boolean {
    // Check ship-specific pilot overrides first
    const shipCls = this.data.selectedShip()?.className?.toLowerCase() ?? '';
    if (this.FORCE_PILOT_HARDPOINTS[shipCls]?.has(hp.id.toLowerCase())) return false;

    if (hp.type === 'TurretBase') return true;
    if (hp.type === 'Turret') {
      const ct = hp.controllerTag?.toLowerCase() ?? '';
      // gunNacelle = pilot-controlled weapon nacelle (e.g., Constellation nose guns)
      // Note: 'copilotSeat' is crew, 'pilotSeat' is pilot — match exact token, not substring
      return !!ct && !ct.includes('remote_turret') && !ct.startsWith('pilotseat') && !ct.includes('gunnacelle') && !ct.includes('gunnose') && !ct.includes('weaponpilot');
    }
    return false;
  }

  private isPdc(hp: Hardpoint): boolean {
    return hp.id.toLowerCase().includes('_pdc_') || hp.id.toLowerCase().includes('_pdc');
  }

  private isTractorTurret(hp: Hardpoint): boolean {
    return hp.type === 'Turret' && hp.id.toLowerCase().includes('tractor');
  }

  gunSlots = computed(() => {
    const ship = this.data.selectedShip();
    if (!ship) return [];
    const missileHpIds = new Set(this.baseMissileSlots().map(hp => hp.id));
    const lo = ship.defaultLoadout ?? {};
    return ship.hardpoints.filter(hp => {
      if (hp.type === 'MissileLauncher' || hp.type === 'BombLauncher') return false;
      if (hp.type === 'EMP' || hp.type === 'QuantumInterdictionGenerator') return false;
      if (this.isPdc(hp)) return false;
      if (this.isSalvageTurret(hp)) return false;
      if (this.isTractorTurret(hp)) return false;
      if (missileHpIds.has(hp.id)) return false;
      if (hp.controllerTag?.toLowerCase() === 'torpedoseat') return false;
      if (hp.id.toLowerCase().includes('turret_cap')) return false;
      // Skip variant-only turrets with no loadout (e.g., A2 turrets on shared M2/C2 XML)
      // But keep turrets with portTags — they're real configurable slots, just empty by default
      if (hp.type === 'Turret' && !lo[hp.id.toLowerCase()] && !hp.portTags) return false;
      return hp.type === 'WeaponGun' || hp.type === 'Turret' || hp.type === 'TurretBase' ||
        hp.allTypes?.some(t => t.type === 'WeaponGun' || t.type === 'Turret' || t.type === 'TurretBase');
    });
  });

  empSlots = computed(() => {
    const ship = this.data.selectedShip();
    if (!ship) return [];
    return ship.hardpoints.filter(hp => hp.type === 'EMP');
  });

  qedSlots = computed(() => {
    const ship = this.data.selectedShip();
    if (!ship) return [];
    return ship.hardpoints.filter(hp => hp.type === 'QuantumInterdictionGenerator');
  });

  tractorSlots = computed(() => {
    const ship = this.data.selectedShip();
    if (!ship) return [];
    return ship.hardpoints.filter(hp => this.isTractorTurret(hp));
  });

  pdcSlots = computed(() => {
    const ship = this.data.selectedShip();
    if (!ship) return [];
    return ship.hardpoints.filter(hp =>
      this.isPdc(hp) && hp.type === 'Turret'
    );
  });

  pilotGunSlots = computed(() =>
    this.gunSlots().filter(hp => !this.isCrewHardpoint(hp))
      .sort((a, b) => {
        const aRocket = a.id.toLowerCase().includes('rocket') ? 1 : 0;
        const bRocket = b.id.toLowerCase().includes('rocket') ? 1 : 0;
        return aRocket - bRocket;
      })
  );
  crewGunSlots  = computed(() => this.gunSlots().filter(hp =>  this.isCrewHardpoint(hp)));

  private isSalvageTurret(hp: Hardpoint): boolean {
    return hp.type === 'Turret' && hp.id.toLowerCase().includes('salvage');
  }

  miningSlots = computed(() => {
    const ship = this.data.selectedShip();
    if (!ship) return [];
    // Mining and salvage slots (including Turret-type salvage arms like Reclaimer)
    return ship.hardpoints.filter(hp => {
      if (this.isSalvageTurret(hp)) return true;
      const types = [hp.type, ...(hp.allTypes?.map(t => t.type) ?? [])];
      return types.some(t => ['ToolArm', 'WeaponMining', 'UtilityTurret', 'SalvageHead'].includes(t));
    });
  });

  /** Get combined stats for a specific laser slot ID, or null if no modules equipped. */
  getCombinedForLaser(laserId: string) {
    return this.miningCombinedStats().find(c => c.laserId === laserId) ?? null;
  }

  /** Get combined totals record for a specific laser slot, for passing to hardpoint-slot input. */
  getCombinedTotals(laserId: string): Record<string, number> | null {
    return this.miningCombinedStats().find(c => c.laserId === laserId)?.totals ?? null;
  }

  /** True when the ship has mining/salvage equipment — reorders left column to prioritize tools. */
  isMiningShip = computed(() => this.miningSlots().length > 0);

  /** Combined mining stats: base laser + all equipped modules, per laser slot.
   *  Only shown when at least one module is equipped. */
  miningCombinedStats = computed(() => {
    const loadout = this.data.loadout();
    const results: { laserId: string; laserName: string; totals: Record<string, number>; stats: { label: string; value: string }[] }[] = [];

    for (const [slotId, item] of Object.entries(loadout)) {
      if (item?.type !== 'WeaponMining') continue;

      // Check if any modules are equipped under this laser
      const hasModules = Object.entries(loadout).some(
        ([key, mod]) => key.startsWith(slotId + '.') && mod?.type === 'MiningModifier'
      );
      if (!hasModules) continue;

      const modKeys = ['miningInstability', 'miningOptimalWindow', 'miningOptimalRate',
                        'miningResistance', 'miningShatterDamage', 'miningInertMaterials', 'miningOvercharge'] as const;
      const totals: Record<string, number> = {};
      for (const k of modKeys) {
        if ((item as any)[k] != null) totals[k] = (item as any)[k];
      }
      // Sum module modifiers
      for (const [key, mod] of Object.entries(loadout)) {
        if (key.startsWith(slotId + '.') && mod?.type === 'MiningModifier') {
          for (const k of modKeys) {
            if ((mod as any)[k] != null) totals[k] = (totals[k] ?? 0) + (mod as any)[k];
          }
        }
      }
      const fmtPct = (v: number) => (v > 0 ? '+' : '') + Math.round(v) + '%';
      const labels: Record<string, string> = {
        miningInstability: 'Instability', miningOptimalWindow: 'Optimal Window',
        miningOptimalRate: 'Optimal Rate', miningResistance: 'Resistance',
        miningShatterDamage: 'Shatter Dmg', miningInertMaterials: 'Inert Materials',
        miningOvercharge: 'Overcharge',
      };
      // Compute combined power multiplier from active modules
      let powerMult = 1;
      for (const [key, mod] of Object.entries(loadout)) {
        if (key.startsWith(slotId + '.') && mod?.type === 'MiningModifier' && mod.miningPowerMult) {
          powerMult *= mod.miningPowerMult;
        }
      }
      const combinedMinPower = item.miningMinPower ? Math.round(item.miningMinPower * powerMult) : null;
      const combinedMaxPower = item.miningMaxPower ? Math.round(item.miningMaxPower * powerMult) : null;
      if (combinedMinPower != null) totals['miningMinPower'] = combinedMinPower;
      if (combinedMaxPower != null) totals['miningMaxPower'] = combinedMaxPower;

      const stats: { label: string; value: string }[] = [];
      // Power stats (with module multiplier applied)
      if (combinedMinPower != null) stats.push({ label: 'Min Power', value: combinedMinPower.toString() });
      if (combinedMaxPower != null) stats.push({ label: 'Max Power', value: combinedMaxPower.toString() });
      if (item.optimalRange) stats.push({ label: 'Opt Range', value: item.optimalRange + 'm' });
      if (item.maxRange) stats.push({ label: 'Max Range', value: item.maxRange + 'm' });
      // Combined modifier stats
      for (const k of modKeys) {
        if (totals[k] != null) stats.push({ label: labels[k], value: fmtPct(totals[k]) });
      }
      if (stats.length) results.push({ laserId: slotId, laserName: item.name, totals, stats });
    }
    return results;
  });

  moduleSlots = computed(() => {
    const ship = this.data.selectedShip();
    if (!ship) return [];
    const seen = new Set<string>();
    return ship.hardpoints.filter(hp => {
      if (hp.type !== 'Module') return false;
      if (seen.has(hp.id)) return false;
      seen.add(hp.id);
      return true;
    });
  });

  /** Missile slots including module-promoted entries. */
  missileSlots = computed(() => this.allMissileSlots());

  utilitySlots = computed(() => {
    const ship = this.data.selectedShip();
    if (!ship) return [];
    return ship.hardpoints.filter(hp => this.utilityTypes.includes(hp.type));
  });

  otherSlots = computed(() => {
    const ship = this.data.selectedShip();
    if (!ship) return [];
    const guns = this.gunSlots();
    const missiles = this.baseMissileSlots();
    const utilities = this.utilitySlots();
    const pdcs = this.pdcSlots();
    const modules = this.moduleSlots();
    return ship.hardpoints.filter(hp =>
      !guns.includes(hp) && !missiles.includes(hp) && !utilities.includes(hp) &&
      !pdcs.includes(hp) && !modules.includes(hp) && !this.isPdc(hp) &&
      !['Radar', 'Sensor', 'QuantumFuelTank', 'Paints'].includes(hp.type)
    );
  });

  massDisplay = computed(() => {
    const m = this.data.selectedShip()?.mass;
    return m ? (m / 1000).toFixed(0) + 't' : '—';
  });

  shipImageSrc = computed(() => {
    const cls = this.data.selectedShip()?.className ?? '';
    // Try wiki .jpg first, then .webp, then .png (silhouette fallback)
    return `ship-images/${cls}.jpg`;
  });

  onShipImageError(img: HTMLImageElement): void {
    const cls = this.data.selectedShip()?.className ?? '';
    if (img.src.endsWith('.jpg')) {
      img.src = `ship-images/${cls}.webp`;
    } else if (img.src.endsWith('.webp')) {
      img.src = `ship-images/${cls}.png`;
    } else {
      img.style.display = 'none';
    }
  }

  /** Effective cargo: base + module cargoBonus (if any). */
  effectiveCargo = computed(() => {
    const base = this.data.selectedShip()?.cargoCapacity ?? 0;
    const loadout = this.data.loadout();
    let bonus = 0;
    for (const item of Object.values(loadout)) {
      if (item?.cargoBonus) bonus += item.cargoBonus;
    }
    return base + bonus;
  });

  /** Two cheapest buy prices for the selected ship. */
  cheapestPrice = computed(() => {
    const prices = this.data.selectedShip()?.shopPrices;
    if (!prices?.length) return null;
    const valid = prices.filter(p => p.price > 0);
    if (!valid.length) return null;
    return valid.reduce((min, p) => p.price < min.price ? p : min);
  });

  shipBuyPrices = computed(() => {
    const prices = this.data.selectedShip()?.shopPrices;
    if (!prices?.length) return [];
    return [...prices]
      .filter(p => p.price > 0)
      .sort((a, b) => a.price - b.price)
      .slice(0, 2);
  });

  fmtPrice(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'm';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
    return n.toString();
  }

  /** Build key-value rows from the focused item's data fields. */
  focusRows = computed(() => {
    const item = this.data.focusedItem();
    if (!item) return [];
    const skip = new Set(['className', 'sruRef', 'heatRef', 'psruRef', 'ammoRef',
      'powerBands', 'damage', 'powerMin']);
    // For mining lasers, overlay combined stats (laser + modules) on top of base values
    const miningOverrides: Record<string, number> = {};
    if (item.type === 'WeaponMining') {
      const loadout = this.data.loadout();
      // Find the slot ID for this focused laser
      for (const [slotId, equipped] of Object.entries(loadout)) {
        if (equipped?.className === item.className && equipped?.type === 'WeaponMining') {
          const combined = this.getCombinedTotals(slotId);
          if (combined) Object.assign(miningOverrides, combined);
          break;
        }
      }
    }
    const rows: { key: string; value: string }[] = [];
    for (const [k, v] of Object.entries(item)) {
      if (skip.has(k) || v == null || v === '' || v === 0 || v === false) continue;
      if (typeof v === 'object' && k === 'damage') {
        const dmg = v as Record<string, number>;
        for (const [dk, dv] of Object.entries(dmg)) {
          if (dv > 0) rows.push({ key: `dmg.${dk}`, value: String(dv) });
        }
      } else if (typeof v === 'object') {
        continue; // skip complex objects
      } else {
        // Use combined value for mining stats if available
        const displayVal = (k in miningOverrides) ? miningOverrides[k] : v;
        rows.push({ key: k, value: String(typeof displayVal === 'number' ? Math.round(displayVal * 100) / 100 : displayVal) });
      }
    }
    // Add damage breakdown
    const dmg = item.damage;
    if (dmg) {
      for (const [dk, dv] of Object.entries(dmg)) {
        if ((dv as number) > 0) rows.push({ key: `dmg.${dk}`, value: String(dv) });
      }
    }
    return rows;
  });

  private _subSlotData = computed(() => {
    const ship = this.data.selectedShip();
    if (!ship?.defaultLoadout) return { slots: {} as Record<string, Hardpoint[]>, rackLeafs: {} as Record<string, string[]> };
    const defaultLoadout = ship.defaultLoadout;
    const currentLoadout = this.data.loadout();
    const allKeys = Object.keys(defaultLoadout);
    const items = this.data.items();
    const slots: Record<string, Hardpoint[]> = {};
    const rackLeafs: Record<string, string[]> = {};

    for (const hp of ship.hardpoints) {
      const parentItem = currentLoadout[hp.id];
      const hpIsTurret = hp.type === 'Turret' || hp.type === 'TurretBase';
      const hpIsRack   = hp.type === 'MissileLauncher' || hp.type === 'BombLauncher';
      const isRack = hpIsRack ||
                     parentItem?.type === 'MissileLauncher' ||
                     parentItem?.type === 'BombLauncher';
      const parentIsDirectWeapon = parentItem?.type === 'WeaponGun' || parentItem?.type === 'WeaponTachyon';
      const hpIsToolArm = hp.type === 'ToolArm' || hp.type === 'UtilityTurret';
      // Modules are handled separately below (whether on a Module hardpoint or a Turret hardpoint)
      if (hp.type === 'Module' || parentItem?.type === 'Module') continue;
      const showSubs = !parentIsDirectWeapon && (
                       parentItem?.type === 'WeaponMount' ||
                       parentItem?.type === 'Turret' ||
                       parentItem?.type === 'TurretBase' ||
                       parentItem?.type === 'ToolArm' ||
                       parentItem?.type === 'UtilityTurret' ||
                       hpIsTurret || hpIsToolArm ||
                       isRack);
      if (!showSubs) continue;

      const prefix = hp.id.toLowerCase() + '.';
      // Check both default loadout keys AND current loadout keys (for PDC auto-fill etc.)
      // Exclude dynamic module keys (.module_N) — these are generated, not part of the loadout hierarchy
      const loadoutKeys = Object.keys(currentLoadout)
        .map(k => k.toLowerCase())
        .filter(k => !k.includes('.module_'));
      const childKeys = [...new Set([
        ...allKeys.filter(k => k.startsWith(prefix)),
        ...loadoutKeys.filter(k => k.startsWith(prefix)),
      ])];
      // If no child keys exist but parent has subPorts, let the subPorts path handle it
      if (!childKeys.length && parentItem?.subPorts?.length) {
        // Fall through to subPorts-based construction below
      } else if (!childKeys.length && parentItem?.type === 'WeaponMount') {
        // WeaponMount without subPorts or child keys: generate a synthetic gun sub-slot
        slots[hp.id] = [{
          id: `${hp.id}.hardpoint_class_2`,
          label: 'Gun 1',
          type: 'WeaponGun',
          subtypes: '',
          minSize: 1,
          maxSize: Math.max(1, hp.maxSize - 1),
          flags: '',
          allTypes: [{ type: 'WeaponGun', subtypes: '' }],
        }];
        continue;
      } else if (!childKeys.length) {
        continue;
      }
      const leaves = childKeys.filter(k => !childKeys.some(k2 => k2.startsWith(k + '.')));

      if (isRack) {
        // Collect all missile leaf keys from default + current loadout
        const missileLeaves = leaves.filter(leaf => {
          const cls = defaultLoadout[leaf] ?? currentLoadout[leaf]?.className;
          if (!cls) return false;
          const item = items.find(i => i.className.toLowerCase() === cls.toLowerCase());
          return item?.type === 'Missile' || item?.type === 'Bomb';
        });
        // Derive size and capacity from the currently equipped rack, falling back to default loadout
        const equippedRack = (parentItem?.type === 'MissileLauncher' || parentItem?.type === 'BombLauncher')
          ? parentItem : null;
        const isBombRack = parentItem?.type === 'BombLauncher';
        const capacity  = equippedRack?.capacity ?? missileLeaves.length;
        // If rack capacity exceeds known leaves, generate synthetic attach keys
        if (capacity > missileLeaves.length) {
          const basePrefix = hp.id.toLowerCase();
          for (let n = missileLeaves.length + 1; n <= capacity; n++) {
            const padded = String(n).padStart(2, '0');
            missileLeaves.push(`${basePrefix}.missile_${padded}_attach`);
          }
        }
        if (!missileLeaves.length) continue;
        const slotSize = equippedRack?.missileSize
          ?? items.find(i => i.className.toLowerCase() === (defaultLoadout[missileLeaves[0]] ?? '').toLowerCase())?.size
          ?? hp.maxSize;
        const activeLeaves = missileLeaves.slice(0, capacity);
        const firstLeaf = activeLeaves[0];
        slots[hp.id] = [{
          id: firstLeaf,
          label: isBombRack ? `Bombs ×${capacity}` : `Missiles ×${capacity}`,
          type: isBombRack ? 'Bomb' : 'Missile',
          subtypes: '',
          minSize: slotSize,
          maxSize: slotSize,
          flags: '',
          allTypes: [{ type: 'Missile', subtypes: '' }],
        }];
        rackLeafs[firstLeaf] = activeLeaves;
      } else if (parentItem?.subPorts?.length) {
        // ── subPorts-based turret/mount sub-slot construction ──
        // The equipped turret/mount declares its own child slots via subPorts.
        // Build slots directly from that data — no loadout-key scanning needed.
        const weaponLock = parentItem.weaponLock ?? null;
        const lockedWeapon = weaponLock
          ? items.find(i => i.className.toLowerCase() === weaponLock.toLowerCase()) ?? null
          : null;
        const subSlots: Hardpoint[] = [];
        let gunIdx = 1;
        const allLoadoutKeys = [...new Set([...allKeys, ...Object.keys(currentLoadout).map(k => k.toLowerCase())])];

        for (const sp of parentItem.subPorts) {
          const subId = `${hp.id}.${sp.id}`.toLowerCase();

          if (sp.type === 'MissileLauncher' || sp.type === 'BombLauncher') {
            // Nested missile rack inside turret — find rack children from loadout
            const rackPrefix = subId.toLowerCase() + '.';
            const rackChildren = allLoadoutKeys.filter(k => k.startsWith(rackPrefix));
            const missileLeaves: string[] = [];
            if (rackChildren.length) {
              const rackLeafKeys = rackChildren.filter(k => !rackChildren.some(k2 => k2.startsWith(k + '.')));
              missileLeaves.push(...rackLeafKeys.filter(leaf => {
                const cls = defaultLoadout[leaf] ?? currentLoadout[leaf]?.className;
                const mi = cls ? items.find(i => i.className.toLowerCase() === cls.toLowerCase()) : null;
                return mi?.type === 'Missile' || mi?.type === 'Bomb';
              }));
            }
            // Check equipped rack, default loadout, or locked rack from subPort
            const equippedRack = currentLoadout[subId];
            const lockedRackCls = (sp as any).locked as string | undefined;
            const rackItem = (equippedRack?.type === 'MissileLauncher' || equippedRack?.type === 'BombLauncher')
              ? equippedRack
              : items.find(i => i.className.toLowerCase() === (defaultLoadout[subId.toLowerCase()] ?? '').toLowerCase())
              ?? (lockedRackCls ? items.find(i => i.className.toLowerCase() === lockedRackCls.toLowerCase()) : null)
              ?? null;
            if (rackItem?.capacity && !missileLeaves.length) {
              for (let mi = 1; mi <= rackItem.capacity; mi++) {
                missileLeaves.push(`${subId}.missile_${String(mi).padStart(2, '0')}_attach`);
              }
            }
            if (!missileLeaves.length) {
              // No rack in loadout — show an empty missile rack slot from subPort info
              subSlots.push({
                id: subId,
                label: sp.type === 'BombLauncher' ? 'Bombs' : 'Missiles',
                type: sp.type === 'BombLauncher' ? 'Bomb' : 'MissileLauncher',
                subtypes: '',
                minSize: sp.minSize,
                maxSize: sp.maxSize,
                flags: lockedRackCls ? '$uneditable' : '',
                allTypes: sp.allTypes.map((t: any) => ({ type: t.type, subtypes: '' })),
              });
              continue;
            }
            const capacity = rackItem?.capacity ?? missileLeaves.length;
            const activeLeaves = missileLeaves.slice(0, capacity);
            const firstLeaf = activeLeaves[0];
            const missileSize = rackItem?.missileSize
              ?? items.find(i => i.className.toLowerCase() === (defaultLoadout[firstLeaf] ?? '').toLowerCase())?.size
              ?? sp.maxSize;
            const isBomb = rackItem?.type === 'BombLauncher';
            subSlots.push({
              id: firstLeaf,
              label: isBomb ? `Bombs ×${capacity}` : `Missiles ×${capacity}`,
              type: isBomb ? 'Bomb' : 'Missile',
              subtypes: '',
              minSize: missileSize,
              maxSize: missileSize,
              flags: '',
              allTypes: [{ type: 'Missile', subtypes: '' }],
            });
            rackLeafs[firstLeaf] = activeLeaves;
            continue;
          }

          // Gun/weapon/utility port — check if a gimbal is equipped on this sub-port
          // Use case-insensitive lookup: subPort ids may differ in case from loadout keys
          const equippedChild = currentLoadout[subId] ?? currentLoadout[subId.toLowerCase()];
          const defaultChildCls = defaultLoadout[subId.toLowerCase()];
          const childItem = equippedChild
            ?? (defaultChildCls ? items.find(i => i.className.toLowerCase() === defaultChildCls.toLowerCase()) : null);
          const isGimbal = childItem?.type === 'WeaponMount';

          // Bespoke per-sub-port lock: extracted from the source XML when a
          // sub-port pairs Flags="uneditable" with a non-empty RequiredPortTags
          // (e.g. Polaris lower front Maris cannons). This propagates through
          // both the gimbal-wrapped and direct-mount branches below so the
          // synthesised weapon slot inherits the lock.
          const subPortLocked = (sp as any).flags?.includes('uneditable') ?? false;

          if (isGimbal && childItem?.subPorts?.length) {
            // Gimbal equipped: build the gun slot from the gimbal's own subPorts
            const gimbalPort = childItem.subPorts[0];
            const gunLeafId = `${subId}.${gimbalPort.id}`;
            const gunCls = defaultLoadout[gunLeafId.toLowerCase()] ?? currentLoadout[gunLeafId]?.className ?? currentLoadout[gunLeafId.toLowerCase()]?.className;
            const gunItem = gunCls ? items.find(i => i.className.toLowerCase() === gunCls.toLowerCase()) : null;
            const gunSize = lockedWeapon?.size ?? gunItem?.size ?? gimbalPort.maxSize;
            const gunFlags = weaponLock
              ? `weaponLock:${weaponLock}`
              : (subPortLocked ? '$uneditable' : '');
            subSlots.push({
              id: gunLeafId,
              label: `Gun ${gunIdx++}`,
              type: 'WeaponGun',
              subtypes: '',
              minSize: lockedWeapon || subPortLocked ? gunSize : Math.max(1, gunSize - 1),
              maxSize: gunSize,
              flags: gunFlags,
              allTypes: [{ type: 'WeaponGun', subtypes: '' }],
            });
          } else {
            // Direct weapon port (no gimbal intermediary)
            const slotType = sp.type === 'WeaponMining' ? 'WeaponMining'
              : sp.type === 'MiningModifier' ? 'MiningModifier'
              : sp.type === 'SalvageHead' ? 'SalvageHead'
              : sp.type === 'SalvageModifier' ? 'SalvageModifier'
              : sp.type === 'TractorBeam' ? 'TractorBeam'
              : 'WeaponGun';
            const slotLabel = slotType === 'WeaponMining' ? `Laser ${gunIdx++}`
              : slotType === 'MiningModifier' ? `Module ${gunIdx++}`
              : slotType === 'SalvageHead' ? `Salvage Head ${gunIdx++}`
              : slotType === 'SalvageModifier' ? `Salvage Tool ${gunIdx++}`
              : `Gun ${gunIdx++}`;
            const slotSize = lockedWeapon?.size ?? sp.maxSize;
            const directFlags = weaponLock
              ? `weaponLock:${weaponLock}`
              : (subPortLocked ? '$uneditable'
                  : (sp.type === 'TractorBeam' && hp.flags?.includes('uneditable') ? '$uneditable' : ''));
            subSlots.push({
              id: subId,
              label: slotLabel,
              type: slotType,
              subtypes: '',
              minSize: lockedWeapon ? slotSize : sp.minSize,
              maxSize: slotSize,
              flags: directFlags,
              allTypes: sp.allTypes.map((t: any) => ({ type: t.type, subtypes: '' })),
            });
          }
        }

        // Generate dynamic module slots for mining lasers
        for (const sub of subSlots) {
          if (sub.type !== 'WeaponMining') continue;
          const equippedLaser = currentLoadout[sub.id];
          const numModules = equippedLaser?.moduleSlots ?? 0;
          if (numModules > 0) {
            const moduleSubSlots: Hardpoint[] = [];
            for (let mi = 1; mi <= numModules; mi++) {
              const modId = `${sub.id}.module_${mi}`;
              moduleSubSlots.push({
                id: modId,
                label: `Module ${mi}`,
                type: 'MiningModifier',
                subtypes: '',
                minSize: 1,
                maxSize: 1,
                flags: '',
                allTypes: [{ type: 'MiningModifier', subtypes: '' }],
              });
            }
            slots[sub.id] = moduleSubSlots;
          }
        }

        if (subSlots.length) slots[hp.id] = subSlots;
      } else {
        // ── Fallback: leaf-based gun sub-slot discovery (items without subPorts) ──
        const weaponLock = parentItem?.weaponLock ?? null;
        const lockedWeapon = weaponLock
          ? items.find(i => i.className.toLowerCase() === weaponLock.toLowerCase()) ?? null
          : null;

        const subSlots: Hardpoint[] = [];
        let gunIdx = 1;
        for (const leaf of leaves) {
          const cls = defaultLoadout[leaf] ?? currentLoadout[leaf]?.className;
          if (!cls) continue;
          const item = items.find(i => i.className.toLowerCase() === cls.toLowerCase());
          if (!item) continue;
          const isGun = item.type === 'WeaponGun';
          const isTractor = item.type === 'TractorBeam';
          const isMiningLaser = item.type === 'WeaponMining';
          const isMiningMod = item.type === 'MiningModifier';
          const isSalvageHead = item.type === 'SalvageHead';
          const isSalvageMod = item.type === 'SalvageModifier';
          if (!isGun && !isTractor && !isMiningLaser && !isMiningMod && !isSalvageHead && !isSalvageMod) continue;
          const slotSize = lockedWeapon ? (lockedWeapon.size ?? hp.maxSize) : (item.size ?? hp.maxSize);
          const isGimbal = parentItem?.type === 'WeaponMount';
          const slotType = isMiningLaser ? 'WeaponMining' : isMiningMod ? 'MiningModifier' : isSalvageHead ? 'SalvageHead' : isSalvageMod ? 'SalvageModifier' : isTractor ? 'TractorBeam' : 'WeaponGun';
          const slotLabel = isMiningLaser ? `Laser ${gunIdx++}` : isMiningMod ? `Module ${gunIdx++}` : isSalvageHead ? `Salvage Head ${gunIdx++}` : isSalvageMod ? `Salvage Tool ${gunIdx++}` : `Gun ${gunIdx++}`;
          subSlots.push({
            id: leaf,
            label: slotLabel,
            type: slotType,
            subtypes: '',
            minSize: weaponLock ? slotSize : (isGimbal && isGun ? Math.max(1, slotSize - 1) : slotSize),
            maxSize: slotSize,
            flags: weaponLock ? `weaponLock:${weaponLock}` : (isTractor && hp.flags?.includes('uneditable') ? '$uneditable' : ''),
            allTypes: [{ type: slotType, subtypes: '' }],
            ...(hp.portTags ? { portTags: hp.portTags } : {}),
          });
        }

        // Generate dynamic module slots for mining lasers (fallback path)
        for (const sub of subSlots) {
          if (sub.type !== 'WeaponMining') continue;
          const equippedLaser = currentLoadout[sub.id];
          const numModules = equippedLaser?.moduleSlots ?? 0;
          if (numModules > 0) {
            const moduleSubSlots: Hardpoint[] = [];
            for (let mi = 1; mi <= numModules; mi++) {
              const modId = `${sub.id}.module_${mi}`;
              moduleSubSlots.push({
                id: modId,
                label: `Module ${mi}`,
                type: 'MiningModifier',
                subtypes: '',
                minSize: 1,
                maxSize: 1,
                flags: '',
                allTypes: [{ type: 'MiningModifier', subtypes: '' }],
              });
            }
            slots[sub.id] = moduleSubSlots;
          }
        }

        if (subSlots.length) slots[hp.id] = subSlots;
      }
    }
    // Module sub-slots: build from equipped module's subPorts + default loadout
    for (const hp of ship.hardpoints) {
      if (hp.type !== 'Module') continue;
      const equippedModule = currentLoadout[hp.id];
      if (!equippedModule?.subPorts?.length) continue;

      const moduleSubs: Hardpoint[] = [];
      const prefix = hp.id.toLowerCase() + '.';

      // Group missile sub-ports into a single collapsed rack entry
      const missilePorts = equippedModule.subPorts.filter((sp: any) => sp.type === 'Missile' || sp.type === 'MissileLauncher');
      if (missilePorts.length) {
        // Find missile leaves from both defaultLoadout AND current loadout
        const missileLeaves: string[] = [];
        const allLoadoutKeys = [...new Set([...allKeys, ...Object.keys(currentLoadout).map(k => k.toLowerCase())])];
        for (const sp of missilePorts) {
          const rackKey = `${hp.id}.${sp.id}`;
          const rackPrefix = rackKey.toLowerCase() + '.';
          const rackChildren = allLoadoutKeys.filter(k => k.startsWith(rackPrefix));
          if (rackChildren.length) {
            const leaves = rackChildren.filter(k => !rackChildren.some(k2 => k2.startsWith(k + '.')));
            missileLeaves.push(...leaves);
          } else {
            // No children found — check if the rack itself is equipped and use its capacity
            const equippedRack = currentLoadout[rackKey];
            if (equippedRack?.type === 'MissileLauncher' && equippedRack.capacity) {
              for (let mi = 1; mi <= equippedRack.capacity; mi++) {
                missileLeaves.push(`${rackKey}.missile_0${mi}_attach`);
              }
            }
          }
        }
        if (missileLeaves.length) {
          const firstMissileItem = currentLoadout[missileLeaves[0]] ??
            items.find(i => i.className.toLowerCase() === (defaultLoadout[missileLeaves[0]] ?? '').toLowerCase());
          const missileSize = firstMissileItem?.size ?? 9;
          const firstLeaf = missileLeaves[0];
          moduleSubs.push({
            id: firstLeaf,
            label: `${missileSize >= 5 ? 'Torpedoes' : 'Missiles'} ×${missileLeaves.length}`,
            type: 'Missile',
            subtypes: '',
            minSize: missileSize,
            maxSize: missileSize,
            flags: '',
            allTypes: [{ type: 'Missile', subtypes: '' }],
          });
          rackLeafs[firstLeaf] = missileLeaves;
        }
      }

      // Non-missile/door sub-ports (e.g. shield)
      for (const sp of equippedModule.subPorts) {
        if (sp.type === 'Missile' || sp.type === 'MissileLauncher' || sp.type === 'Door' || sp.type === 'Misc') continue;
        const subId = `${hp.id}.${sp.id}`;
        moduleSubs.push({
          id: subId,
          label: sp.type === 'Shield' ? 'Shield' : sp.id.replace(/_/g, ' '),
          type: sp.type,
          subtypes: '',
          minSize: sp.minSize,
          maxSize: sp.maxSize,
          flags: '',
          allTypes: sp.allTypes.map((t: any) => ({ type: t.type, subtypes: '' })),
        });
      }

      if (moduleSubs.length) slots[hp.id] = moduleSubs;
    }

    return { slots, rackLeafs };
  });

  subSlotsMap    = computed(() => this._subSlotData().slots);
  rackLeafIdsMap = computed(() => this._subSlotData().rackLeafs);

  // ── Module sub-slot promotion ──────────────────────
  private readonly PROMOTABLE_TYPES = new Set(['Shield', 'Missile', 'MissileLauncher', 'BombLauncher']);

  /** Module sub-slots that should be promoted to their logical sections. */
  promotedModuleSubSlots = computed(() => {
    const subs = this.subSlotsMap();
    const modules = this.moduleSlots();
    const promoted: Hardpoint[] = [];
    for (const modHp of modules) {
      for (const child of subs[modHp.id] ?? []) {
        if (this.PROMOTABLE_TYPES.has(child.type)) {
          promoted.push({ ...child, sourceModuleHpId: modHp.id });
        }
      }
    }
    return promoted;
  });

  /** Module sub-slots minus promoted ones — for the Modules section display. */
  unpromotedSubSlotsForModules = computed(() => {
    const subs = this.subSlotsMap();
    const modules = this.moduleSlots();
    const result: Record<string, Hardpoint[]> = {};
    for (const modHp of modules) {
      const remaining = (subs[modHp.id] ?? []).filter(c => !this.PROMOTABLE_TYPES.has(c.type));
      if (remaining.length) result[modHp.id] = remaining;
    }
    return result;
  });

  // Type-specific system slot groups (with module promotion)
  private baseShieldSlots = computed(() => this.utilitySlots().filter(hp => hp.type === 'Shield'));
  allShieldSlots = computed(() => [
    ...this.baseShieldSlots(),
    ...this.promotedModuleSubSlots().filter(hp => hp.type === 'Shield'),
  ]);
  /** Shield slots including module-promoted entries. */
  shieldSlots = computed(() => this.allShieldSlots());
  primaryShieldSlots = computed(() => this.allShieldSlots().slice(0, 2));
  excessShieldSlots = computed(() => this.allShieldSlots().slice(2));

  private baseMissileSlots = computed(() => {
    const ship = this.data.selectedShip();
    if (!ship) return [];
    const lo = ship.defaultLoadout ?? {};
    return ship.hardpoints.filter(hp => {
      if ((hp.type === 'MissileLauncher' || hp.type === 'BombLauncher') && lo[hp.id.toLowerCase()]) return true;
      // Turret hardpoints whose default item is a missile rack (e.g., Polaris remote turret)
      if (hp.type === 'Turret') {
        const cls = lo[hp.id.toLowerCase()];
        if (cls) {
          const item = this.data.items().find(i => i.className.toLowerCase() === cls.toLowerCase());
          if (item?.type === 'MissileLauncher') return true;
        }
      }
      return false;
    });
  });
  allMissileSlots = computed(() => [
    ...this.baseMissileSlots(),
    ...this.promotedModuleSubSlots().filter(hp =>
      hp.type === 'Missile' || hp.type === 'MissileLauncher' || hp.type === 'BombLauncher'
    ),
  ]);
  ppSlots     = computed(() => this.utilitySlots().filter(hp => hp.type === 'PowerPlant'));
  coolerSlots = computed(() => this.utilitySlots().filter(hp => hp.type === 'Cooler'));
  bladeSlots  = computed(() => this.utilitySlots().filter(hp => hp.type === 'FlightController'));
  qdSlots     = computed(() => this.utilitySlots().filter(hp => hp.type === 'QuantumDrive'));

  /** Jump drive sub-slots — always shown if the ship's default loadout has one. */
  jumpDriveSlots = computed(() => {
    const ship = this.data.selectedShip();
    if (!ship?.defaultLoadout) return [];
    const loadout = this.data.loadout();
    const items = this.data.items();
    const slots: Hardpoint[] = [];
    for (const qdHp of this.qdSlots()) {
      const jdKey = `${qdHp.id}.hardpoint_jump_drive`;
      // Check current loadout first, fall back to default loadout item
      const jdItem = loadout[jdKey] ?? this._resolveDefaultJD(ship, jdKey, items);
      if (jdItem) {
        slots.push({
          id: jdKey,
          label: 'Jump Module',
          type: 'JumpDrive',
          subtypes: '',
          minSize: jdItem.size ?? 1,
          maxSize: jdItem.size ?? 1,
          flags: '$uneditable',
          allTypes: [{ type: 'JumpDrive', subtypes: '' }],
        });
      }
    }
    return slots;
  });

  private _resolveDefaultJD(ship: Ship, jdKey: string, items: Item[]): Item | null {
    const cls = ship.defaultLoadout?.[jdKey];
    if (!cls) return null;
    return items.find(i => i.className.toLowerCase() === cls.toLowerCase()) ?? null;
  }
  radarSlots  = computed(() => this.utilitySlots().filter(hp => hp.type === 'Radar'));
  lsSlots     = computed(() => {
    const base = this.utilitySlots().filter(hp => hp.type === 'LifeSupportGenerator');
    if (base.length) return base;
    // Fallback: scan loadout for LS items not in ship.hardpoints
    const loadout = this.data.loadout();
    for (const [key, item] of Object.entries(loadout)) {
      if (item?.type === 'LifeSupportGenerator' && !key.includes('.')) {
        return [{
          id: key, label: 'Life Support', type: 'LifeSupportGenerator',
          subtypes: '', minSize: item.size ?? 1, maxSize: item.size ?? 1,
          flags: '', allTypes: [{ type: 'LifeSupportGenerator', subtypes: '' }],
        }];
      }
    }
    return [];
  });

  /** The currently equipped flight controller (blade) item. */
  equippedBlade = computed(() => {
    const ship = this.data.selectedShip();
    if (!ship) return null;
    const loadout = this.data.loadout();
    for (const hp of ship.hardpoints) {
      if (hp.type === 'FlightController') {
        const item = loadout[hp.id];
        if (item) return item;
      }
    }
    return null;
  });

  /** Flight stats sourced from the equipped blade (falls back to ship for accel/boost data). */
  flightScmSpeed = computed(() => this.equippedBlade()?.scmSpeed ?? this.data.selectedShip()?.scmSpeed);
  flightNavSpeed = computed(() => this.equippedBlade()?.navSpeed ?? this.data.selectedShip()?.navSpeed);
  flightBoostFwd = computed(() => this.equippedBlade()?.boostSpeedFwd ?? this.data.selectedShip()?.boostSpeedFwd);
  flightBoostBwd = computed(() => this.data.selectedShip()?.boostSpeedBwd);

  // Thruster-power-scaled rotation values.
  // thrusterMult = 0 at bar 1 (min), 1 at bar max (full).
  private thrusterMult = computed(() => {
    const ship = this.data.selectedShip();
    const maxBars = ship?.thrusterPowerBars ?? 0;
    if (!maxBars || maxBars <= 1) return 1;
    return (this.data.thrusterPower() - 1) / (maxBars - 1);
  });

  private rotAtPower(base: number | undefined, boosted: number | undefined): { base: number; boosted: number } | null {
    if (!base) return null;
    const b = boosted ?? base;
    const m = this.thrusterMult();
    const boostedVal = base + m * (b - base);
    return { base: Math.round(base * 10) / 10, boosted: Math.round(boostedVal * 10) / 10 };
  }

  pitchRot = computed(() => {
    const blade = this.equippedBlade();
    const s = this.data.selectedShip();
    return this.rotAtPower(blade?.pitch ?? s?.pitch, blade?.pitchBoosted ?? s?.pitchBoosted);
  });
  yawRot = computed(() => {
    const blade = this.equippedBlade();
    const s = this.data.selectedShip();
    return this.rotAtPower(blade?.yaw ?? s?.yaw, blade?.yawBoosted ?? s?.yawBoosted);
  });
  rollRot = computed(() => {
    const blade = this.equippedBlade();
    const s = this.data.selectedShip();
    return this.rotAtPower(blade?.roll ?? s?.roll, blade?.rollBoosted ?? s?.rollBoosted);
  });

  private router = inject(Router);
  constructor(public data: DataService) {}

  signalPct(val: number | undefined): string {
    if (val === undefined) return '—';
    const pct = Math.round((val - 1) * 100);
    return pct >= 0 ? `+${pct}%` : `${pct}%`;
  }
}
