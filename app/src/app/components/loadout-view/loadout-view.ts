import { Component, computed, signal, output } from '@angular/core';
import { UpperCasePipe } from '@angular/common';
import { DataService } from '../../services/data.service';
import { DpsPanelComponent } from '../dps-panel/dps-panel';
import { HardpointSlotComponent } from '../hardpoint-slot/hardpoint-slot';
import { PowerBarsComponent } from '../power-bars/power-bars';
import { Hardpoint, Item } from '../../models/db.models';

@Component({
  selector: 'app-loadout-view',
  standalone: true,
  imports: [DpsPanelComponent, HardpointSlotComponent, PowerBarsComponent, UpperCasePipe],
  templateUrl: './loadout-view.html',
  styleUrl: './loadout-view.scss',
})
export class LoadoutViewComponent {
  goToSubmit = output<void>();

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

  /** Available gun sizes across all weapon sub-slots. */
  bulkGunSizes = computed(() => {
    const subs = this.subSlotsMap();
    const sizes = new Set<number>();
    for (const children of Object.values(subs)) {
      for (const child of children) {
        if (child.type === 'WeaponGun' && child.maxSize) sizes.add(child.maxSize);
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
    let opts: Item[];
    if (tab === 'guns') {
      opts = this.data.items().filter(i =>
        (i.type === 'WeaponGun' || i.type === 'WeaponTachyon') && i.size === size
      );
    } else {
      opts = this.data.items().filter(i => i.type === 'Missile' && i.size === size);
    }
    if (q) {
      opts = opts.filter(o =>
        o.name.toLowerCase().includes(q) ||
        (o.manufacturer ?? '').toLowerCase().includes(q)
      );
    }
    return tab === 'guns'
      ? opts.sort((a, b) => (b.dps ?? 0) - (a.dps ?? 0))
      : opts.sort((a, b) => (b.alphaDamage ?? 0) - (a.alphaDamage ?? 0));
  });

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
  }

  closeBulkEquip(): void {
    this.bulkEquipOpen.set(false);
  }

  bulkLastApplied = signal('');

  applyBulkEquip(item: Item): void {
    const tab = this.bulkEquipTab();
    const subs = this.subSlotsMap();
    const targetType = tab === 'guns' ? 'WeaponGun' : 'Missile';
    for (const children of Object.values(subs)) {
      for (const child of children) {
        if (child.type === targetType && child.maxSize === item.size) {
          this.data.setLoadoutItem(child.id, item);
        }
      }
    }
    this.bulkLastApplied.set(item.className);
  }

  collapsedSections = signal<Set<string>>(new Set([
    'pilot-guns', 'crew-guns', 'missiles', 'mining', 'power', 'pdc', 'tractor', 'coolers', 'modules',
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
      return !!ct && !ct.includes('remote_turret') && ct !== 'pilotseat' && !ct.includes('gunnacelle') && !ct.includes('gunnose');
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
    return ship.hardpoints.filter(hp => {
      if (hp.type === 'MissileLauncher' || hp.type === 'BombLauncher') return false;
      if (hp.type === 'EMP' || hp.type === 'QuantumInterdictionGenerator') return false;
      if (this.isPdc(hp)) return false;
      if (this.isSalvageTurret(hp)) return false;
      if (this.isTractorTurret(hp)) return false;
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
      img.src = `ship-images/${cls.toLowerCase()}.webp`;
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
        rows.push({ key: k, value: String(v) });
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
      // Modules are handled separately below
      if (hp.type === 'Module') continue;
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
      // If a WeaponMount is equipped but has no child keys, generate a synthetic gun sub-slot
      if (!childKeys.length && parentItem?.type === 'WeaponMount') {
        const synthId = `${hp.id}.hardpoint_class_2`;
        const gunSize = Math.max(1, hp.maxSize - 1);
        slots[hp.id] = [{
          id: synthId,
          label: 'Gun 1',
          type: 'WeaponGun',
          subtypes: '',
          minSize: 1,
          maxSize: gunSize,
          flags: '',
          allTypes: [{ type: 'WeaponGun', subtypes: '' }],
        }];
        continue;
      }
      if (!childKeys.length) continue;
      const leaves = childKeys.filter(k => !childKeys.some(k2 => k2.startsWith(k + '.')));

      if (isRack) {
        // Collect all missile leaf keys
        const missileLeaves = leaves.filter(leaf => {
          const cls = defaultLoadout[leaf];
          const item = items.find(i => i.className.toLowerCase() === cls.toLowerCase());
          return item?.type === 'Missile';
        });
        if (!missileLeaves.length) continue;
        // Derive size and capacity from the currently equipped rack, falling back to default loadout
        const equippedRack = (parentItem?.type === 'MissileLauncher' || parentItem?.type === 'BombLauncher')
          ? parentItem : null;
        const slotSize = equippedRack?.missileSize
          ?? items.find(i => i.className.toLowerCase() === (defaultLoadout[missileLeaves[0]] ?? '').toLowerCase())?.size
          ?? hp.maxSize;
        const capacity  = equippedRack?.capacity ?? missileLeaves.length;
        const activeLeaves = missileLeaves.slice(0, capacity);
        const firstLeaf = activeLeaves[0];
        slots[hp.id] = [{
          id: firstLeaf,
          label: `Missiles ×${capacity}`,
          type: 'Missile',
          subtypes: '',
          minSize: slotSize,
          maxSize: slotSize,
          flags: '',
          allTypes: [{ type: 'Missile', subtypes: '' }],
        }];
        rackLeafs[firstLeaf] = activeLeaves;
      } else {
        // WeaponMount / Turret: individual gun sub-slots
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
          });
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

        // Check for nested missile racks — only when the default turret is equipped,
        // since the rack belongs to that specific turret, not a replacement like the TMSB-5
        const defaultParentCls = defaultLoadout[hp.id.toLowerCase()];
        const equippedParentCls = currentLoadout[hp.id]?.className?.toLowerCase();
        const isDefaultTurretEquipped = !equippedParentCls || !defaultParentCls ||
          equippedParentCls === defaultParentCls.toLowerCase();

        const hpDepth = hp.id.split('.').length;
        const directChildKeys = isDefaultTurretEquipped
          ? childKeys.filter(k => k.split('.').length === hpDepth + 1)
          : [];
        for (const childKey of directChildKeys) {
          const rackCls = defaultLoadout[childKey];
          if (!rackCls) continue;
          const rackDefaultItem = items.find(i => i.className.toLowerCase() === rackCls.toLowerCase());
          if (!rackDefaultItem || (rackDefaultItem.type !== 'MissileLauncher' && rackDefaultItem.type !== 'BombLauncher')) continue;

          // Find missile leaves under this rack
          const rackPrefix = childKey.toLowerCase() + '.';
          const rackChildKeys = allKeys.filter(k => k.startsWith(rackPrefix));
          const rackLeafKeys = rackChildKeys.filter(k => !rackChildKeys.some(k2 => k2.startsWith(k + '.')));
          const missileLeafKeys = rackLeafKeys.filter(leaf => {
            const missileCls = defaultLoadout[leaf];
            const missileItem = items.find(i => i.className.toLowerCase() === missileCls?.toLowerCase());
            return missileItem?.type === 'Missile';
          });
          if (!missileLeafKeys.length) continue;

          // Use the currently equipped rack if available, otherwise fall back to default
          const equippedRack = currentLoadout[childKey];
          const rackItem = (equippedRack?.type === 'MissileLauncher' || equippedRack?.type === 'BombLauncher')
            ? equippedRack : rackDefaultItem;
          const slotSize = rackItem.missileSize
            ?? items.find(i => i.className.toLowerCase() === (defaultLoadout[missileLeafKeys[0]] ?? '').toLowerCase())?.size
            ?? hp.maxSize;
          const capacity = rackItem.capacity ?? missileLeafKeys.length;
          const activeLeaves = missileLeafKeys.slice(0, capacity);
          const firstMissileLeaf = activeLeaves[0];

          subSlots.push({
            id: firstMissileLeaf,
            label: `Missiles ×${capacity}`,
            type: 'Missile',
            subtypes: '',
            minSize: slotSize,
            maxSize: slotSize,
            flags: '',
            allTypes: [{ type: 'Missile', subtypes: '' }],
          });
          rackLeafs[firstMissileLeaf] = activeLeaves;
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
            label: `Torpedoes ×${missileLeaves.length}`,
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
    return ship.hardpoints.filter(hp =>
      (hp.type === 'MissileLauncher' || hp.type === 'BombLauncher') && lo[hp.id.toLowerCase()]
    );
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
  radarSlots  = computed(() => this.utilitySlots().filter(hp => hp.type === 'Radar'));
  lsSlots     = computed(() => this.utilitySlots().filter(hp => hp.type === 'LifeSupportGenerator'));

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

  constructor(public data: DataService) {}

  signalPct(val: number | undefined): string {
    if (val === undefined) return '—';
    const pct = Math.round((val - 1) * 100);
    return pct >= 0 ? `+${pct}%` : `${pct}%`;
  }
}
