import { Component, computed } from '@angular/core';
import { DataService } from '../../services/data.service';
import { Item, calcMaxPips, coolerSupply, componentCoolingDemand } from '../../models/db.models';

interface PowerBarCol {
  id: string;
  label: string;
  max: number;
  powerMin: number;   // total blocks in minimum band(s)
  alloc: number;
  restricted: boolean;
  placeholder: boolean;
  item: Item | null;
  /** Per-shield minimum bands for combined shield columns (bottom-up order). */
  shieldBands?: { min: number; hpId: string; item: Item }[];
}

@Component({
  selector: 'app-power-bars',
  standalone: true,
  templateUrl: './power-bars.html',
  styleUrl: './power-bars.scss',
})
export class PowerBarsComponent {
  constructor(public data: DataService) {}

  columns = computed<PowerBarCol[]>(() => {
    const ship = this.data.selectedShip();
    if (!ship) return [];
    const loadout = this.data.loadout();
    const alloc   = this.data.powerAlloc();
    const mode    = this.data.flightMode();
    const cols: PowerBarCol[] = [];

    // Weapons — pool max depends on loadout total power draw
    const poolSize = ship.weaponPowerPoolSize ?? 0;
    const wpnsMax = poolSize > 0 ? calcMaxPips(poolSize, this.data.allLoadoutWeapons()) : 0;
    if (poolSize > 0) {
      cols.push({
        id: '__weapons__', label: 'WPNS',
        max: wpnsMax, powerMin: wpnsMax > 0 ? 1 : 0,
        alloc: Math.min(this.data.weaponsPower(), wpnsMax),
        restricted: mode === 'nav', placeholder: false, item: null,
      });
    }

    // Thrusters — interactive when ship has thrusterPowerBars data
    const thruMax = ship.thrusterPowerBars ?? 4;
    cols.push({
      id: '__thrusters__', label: 'THRU',
      max: thruMax, powerMin: 1,
      alloc: this.data.thrusterPower(),
      restricted: false, placeholder: !ship.thrusterPowerBars, item: null,
    });

    // Shields — only first 2 (primaries) get power pips. 3rd+ are excess (auto-power).
    const shieldSlots = ship.hardpoints
      .filter(hp => loadout[hp.id]?.type === 'Shield' && (loadout[hp.id].powerMax ?? 0) > 0)
      .map(hp => ({ hpId: hp.id, item: loadout[hp.id] }));
    const primaryShields = shieldSlots.slice(0, 2);
    if (primaryShields.length > 0) {
      const totalMax = primaryShields.reduce((s, sl) => s + Math.max(1, (sl.item.powerMax ?? 0) - 1), 0);
      const totalAlloc = primaryShields.reduce((s, sl) => s + (alloc[sl.hpId] ?? 0), 0);
      const bands = primaryShields.map(sl => {
        const b = sl.item.powerBands ?? [];
        let min: number;
        if (b.length <= 1) min = 1;
        else min = Math.max(1, b[1].start - b[0].start);
        return { min, hpId: sl.hpId, item: sl.item };
      });
      const totalMin = bands.reduce((s, b) => s + b.min, 0);
      cols.push({
        id: '__shields__', label: 'SHLD',
        max: totalMax, powerMin: totalMin,
        alloc: totalAlloc,
        restricted: mode === 'nav', placeholder: false, item: null,
        shieldBands: bands,
      });
    }

    // Quantum Drive — one bar per slot
    for (const hp of ship.hardpoints) {
      const item = loadout[hp.id];
      if (item?.type === 'QuantumDrive' && (item.powerMax ?? 0) > 0) {
        // QD powerDraw from SStandardResourceUnit = pip count to activate
        const qMin = item.powerDraw ?? item.powerMin ?? 1;
        cols.push({
          id: hp.id, label: 'QD',
          max: Math.max(qMin, item.powerMax!), powerMin: qMin,
          alloc: alloc[hp.id] ?? 0,
          restricted: mode === 'scm', placeholder: false, item,
        });
      }
    }

    // Tools — 1 pip per mining laser or salvage head equipped (if any)
    const toolCount = Object.values(loadout).filter(
      i => i?.type === 'WeaponMining' || i?.type === 'SalvageHead'
    ).length;
    if (toolCount > 0) {
      cols.push({
        id: '__tools__', label: 'TOOL',
        max: toolCount, powerMin: toolCount,
        alloc: toolCount,
        restricted: false, placeholder: false, item: null,
      });
    }

    // Tractor beams — merged 2-pip block, toggled on/off
    if (this.data.hasTractorBeams()) {
      cols.push({
        id: '__tractor__', label: 'TRAC',
        max: 2, powerMin: 2,
        alloc: this.data.tractorPower(),
        restricted: false, placeholder: false, item: null,
      });
    }

    // Radar
    for (const hp of ship.hardpoints) {
      const item = loadout[hp.id];
      if (item?.type === 'Radar' && (item.powerDraw ?? 0) > 0) {
        const rMin = Math.max(1, Math.round((item.powerDraw ?? 1) * (item.minConsumptionFraction ?? 0.25)));
        cols.push({
          id: hp.id, label: 'RADR',
          max: item.powerDraw!, powerMin: rMin,
          alloc: alloc[hp.id] ?? 0,
          restricted: false, placeholder: false, item,
        });
        break;
      }
    }
    if (!cols.some(c => c.label === 'RADR')) {
      cols.push({
        id: '__radar__', label: 'RADR',
        max: 2, powerMin: 1, alloc: 0,
        restricted: false, placeholder: true, item: null,
      });
    }

    // Life Support
    for (const hp of ship.hardpoints) {
      const item = loadout[hp.id];
      if (item?.type === 'LifeSupportGenerator' && (item.powerMax ?? 0) > 0) {
        cols.push({
          id: hp.id, label: 'LS',
          max: Math.max(1, (item.powerMax ?? 0) - 1), powerMin: 1,
          alloc: alloc[hp.id] ?? 0,
          restricted: false, placeholder: false, item,
        });
        break;
      }
    }
    if (!cols.some(c => c.label === 'LS')) {
      cols.push({
        id: '__ls__', label: 'LS',
        max: 2, powerMin: 1, alloc: 0,
        restricted: false, placeholder: true, item: null,
      });
    }

    // Coolers — one bar per slot
    let ci = 1;
    for (const hp of ship.hardpoints) {
      const item = loadout[hp.id];
      if (item?.type === 'Cooler' && (item.powerMax ?? 0) > 0) {
        const b = item.powerBands ?? [];
        const cMin = b.length <= 1 ? 1 : Math.max(1, b[1].start - b[0].start);
        cols.push({
          id: hp.id, label: `CL${ci++}`,
          max: item.powerMax!, powerMin: cMin,
          alloc: alloc[hp.id] ?? 0,
          restricted: false, placeholder: false, item,
        });
      }
    }

    return cols;
  });

  maxHeight = computed(() =>
    Math.max(1, ...this.columns().map(c => c.max))
  );

  /** Percentage of cooling supply used by demand. >100% = overloaded. */
  coolingPct = computed(() => {
    const supply = this.coolingSupply();
    if (supply <= 0) return 0;
    return Math.round(this.coolingDemand() / supply * 100);
  });

  /** Total cooling supply from all coolers at current pip allocation. */
  coolingSupply = computed(() => {
    const loadout = this.data.loadout();
    const alloc = this.data.powerAlloc();
    const ship = this.data.selectedShip();
    if (!ship) return 0;
    let supply = 0;
    for (const hp of ship.hardpoints) {
      const item = loadout[hp.id];
      if (item?.type === 'Cooler' && item.coolingRate) {
        supply += coolerSupply(item, alloc[hp.id] ?? 0);
      }
    }
    return Math.round(supply * 10) / 10;
  });

  /** Total cooling demand from all powered components. */
  coolingDemand = computed(() => {
    const loadout = this.data.loadout();
    const alloc = this.data.powerAlloc();
    const ship = this.data.selectedShip();
    if (!ship) return 0;
    let demand = 0;
    for (const hp of ship.hardpoints) {
      const item = loadout[hp.id];
      if (!item) continue;
      const pips = alloc[hp.id] ?? 0;
      if (item.type === 'PowerPlant') {
        // Power plants always demand cooling when equipped
        demand += componentCoolingDemand(item, 1);
      } else if (item.type === 'Shield' || item.type === 'Cooler' ||
                 item.type === 'LifeSupportGenerator' || item.type === 'QuantumDrive' ||
                 item.type === 'Radar') {
        demand += componentCoolingDemand(item, pips);
      }
    }
    // Tools (mining lasers / salvage heads) = 1 cooling pip each
    demand += this.data.toolPower();
    return Math.round(demand * 10) / 10;
  });

  range(n: number): number[] {
    return Array.from({ length: n }, (_, i) => i);
  }

  /**
   * Cumulative threshold for the i-th shield band in display order.
   * Bands are rendered top-to-bottom in DOM. The LAST band is visually at the
   * bottom and should activate first (lowest threshold).
   * threshold = sum of mins from this band to the last (bottom-most).
   */
  private readonly iconBaseMap: Record<string, string> = {
    'WPNS': 'weapons',
    'THRU': 'thrusters',
    'SHLD': 'shield',
    'QD':   'qd',
    'TOOL': 'tool',
    'TRAC': 'trac',
    'RADR': 'radar',
    'LS':   'ls',
  };

  iconFor(col: PowerBarCol): string | null {
    const base = this.iconBaseMap[col.label] ?? (col.label.startsWith('CL') ? 'cooler' : null);
    if (!base) return null;
    // Note: thruster off icon is 'thruster_off' (no 's'), on is 'thrusters_on'
    const isOn = col.alloc > 0;
    if (base === 'thrusters') {
      return isOn ? 'power-icons/icon_thrusters_on.png' : 'power-icons/icon_thruster_off.png';
    }
    return `power-icons/icon_${base}_${isOn ? 'on' : 'off'}.png`;
  }

  togglePower(col: PowerBarCol, e: MouseEvent): void {
    e.stopPropagation();
    if (col.placeholder) return;
    if (col.id === '__tools__') return; // Tools always on

    if (col.id === '__tractor__') {
      this.data.tractorPower.set(col.alloc > 0 ? 0 : 2);
      return;
    }

    if (col.alloc > 0) {
      // Turn off
      if (col.id === '__weapons__') {
        this.data.setWeaponsPower(0);
      } else if (col.id === '__thrusters__') {
        // Thrusters can't go to 0
        return;
      } else if (col.shieldBands) {
        const slots = col.shieldBands.map(b => ({ hpId: b.hpId, item: b.item }));
        this.data.setShieldsPower(0, slots);
      } else {
        this.data.setPowerAlloc(col.id, 0, col.item);
      }
    } else {
      // Turn on to default
      if (col.id === '__weapons__') {
        const poolSize = this.data.selectedShip()?.weaponPowerPoolSize ?? 4;
        this.data.setWeaponsPower(Math.max(1, Math.round(poolSize * 0.5)));
      } else if (col.shieldBands) {
        const slots = col.shieldBands.map(b => ({ hpId: b.hpId, item: b.item }));
        this.data.setShieldsPower(col.powerMin, slots);
      } else if (col.item?.type === 'Radar') {
        const rMin = Math.max(1, Math.round((col.item.powerDraw ?? 1) * (col.item.minConsumptionFraction ?? 0.25)));
        this.data.setPowerAlloc(col.id, rMin, col.item);
      } else if (col.item?.type === 'QuantumDrive') {
        this.data.setPowerAlloc(col.id, col.item.powerDraw ?? col.item.powerMin ?? 1, col.item);
      } else {
        this.data.setPowerAlloc(col.id, col.powerMin, col.item);
      }
    }
  }

  shieldBandThreshold(col: PowerBarCol, bandIndex: number): number {
    if (!col.shieldBands) return col.powerMin;
    let sum = 0;
    for (let i = bandIndex; i < col.shieldBands.length; i++) {
      sum += col.shieldBands[i].min;
    }
    return sum;
  }

  // Block number (1-based from bottom). Clicking below powerMin snaps to 0 (off).
  setAlloc(col: PowerBarCol, blockNum: number): void {
    if (col.restricted || col.placeholder) return;
    // For shields with multiple bands, the lowest band's min is the snap-off threshold
    const lowestMin = col.shieldBands
      ? col.shieldBands[col.shieldBands.length - 1].min
      : col.powerMin;
    // Clicking below the lowest activatable band = "off"
    let target = blockNum > 0 && blockNum < lowestMin ? 0 : blockNum;
    // Clicking the current top block steps down (respecting min gap)
    if (target === col.alloc) {
      target = col.alloc <= lowestMin ? 0 : col.alloc - 1;
    }
    target = Math.max(0, target);

    if (col.id === '__tools__') return; // Tools are always on, not adjustable
    if (col.id === '__tractor__') {
      this.data.tractorPower.set(target > 0 ? 2 : 0);
      return;
    }
    if (col.id === '__weapons__') {
      this.data.setWeaponsPower(target);
    } else if (col.id === '__thrusters__') {
      this.data.setThrusterPower(target === 0 ? 1 : target);
    } else if (col.shieldBands) {
      // Distribute target pips across shields: fill each shield's min first, then extras
      const slots = col.shieldBands.map(b => ({ hpId: b.hpId, item: b.item }));
      this.data.setShieldsPower(target, slots);
    } else {
      this.data.setPowerAlloc(col.id, target, col.item);
    }
  }
}
