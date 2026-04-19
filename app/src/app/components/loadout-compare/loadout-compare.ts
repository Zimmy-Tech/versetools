import { Component, Input, Output, EventEmitter, computed, signal } from '@angular/core';
import { DataService } from '../../services/data.service';
import { Ship, Item, Hardpoint } from '../../models/db.models';

export interface StoredLoadout {
  name: string;
  shipClassName: string;
  shipName: string;
  items: Record<string, string>;
  powerAlloc: Record<string, number>;
  weaponsPower: number;
  thrusterPower: number;
  timestamp: number;
  peakDps?: number;
  totalAlpha?: number;
}

interface WeaponEntry {
  name: string;
  size: number;
  dps: number;
  alpha: number;
  type: string;
}

interface MissileGroup {
  name: string;
  size: number;
  count: number;
}

interface LoadoutStats {
  label: string;
  peakDpsPilot: number;
  peakDpsCrew: number;
  totalAlpha: number;
  pilotWeapons: WeaponEntry[];
  crewWeapons: WeaponEntry[];
  shieldHp: number;
  shieldRegen: number;
  shieldCount: number;
  missileCount: number;
  missileTotalDmg: number;
  missileGroups: MissileGroup[];
  powerOutput: number;
  powerDraw: number;
  coolingRate: number;
  emSignature: number;
  irSignature: number;
  qtSpeed: number;
  qtRange: number;
  // Shield resists
  shieldResistPhys: number;
  shieldResistEnrg: number;
  shieldResistDist: number;
  // Armor
  armorDeflectPhys: number;
  armorDeflectEnrg: number;
  // Rotation
  pitch: number;
  yaw: number;
  roll: number;
  // Weapon velocity
  avgProjectileSpeed: number;
  // Industrial
  miningLaserCount: number;
  miningMinPower: number;
  miningMaxPower: number;
  miningOptimalRange: number;
  miningMaxRange: number;
  salvageHeadCount: number;
  cargoCapacity: number;
}

@Component({
  selector: 'app-loadout-compare',
  standalone: true,
  templateUrl: './loadout-compare.html',
  styleUrl: './loadout-compare.scss',
})
export class LoadoutCompareComponent {
  @Input() allLoadouts: StoredLoadout[] = [];
  @Output() close = new EventEmitter<void>();

  constructor(public data: DataService) {}

  // Phase: 'pick' = selecting loadouts, 'compare' = showing comparison
  phase = signal<'pick' | 'compare'>('pick');
  selectedIndices = signal<Set<number>>(new Set());
  /** When true, include the live in-app loadout as a "Current" column
   *  alongside selected saved loadouts. Toggle defaults on. */
  includeCurrent = signal<boolean>(true);

  toggleIncludeCurrent(): void {
    this.includeCurrent.set(!this.includeCurrent());
  }

  toggleSelect(index: number): void {
    const current = new Set(this.selectedIndices());
    if (current.has(index)) {
      current.delete(index);
    } else if (current.size < 3) {
      current.add(index);
    }
    this.selectedIndices.set(current);
  }

  isSelected(index: number): boolean {
    return this.selectedIndices().has(index);
  }

  canCompare(): boolean {
    return this.selectedIndices().size > 0;
  }

  startCompare(): void {
    if (this.canCompare()) this.phase.set('compare');
  }

  backToPick(): void {
    this.phase.set('pick');
  }

  ship = computed(() => this.data.selectedShip());

  // Build stats for all selected columns: [current, ...saved]
  columns = computed<LoadoutStats[]>(() => {
    const ship = this.ship();
    if (!ship) return [];
    const allItems = this.data.items();
    const result: LoadoutStats[] = [];

    // Current loadout first, only if the "Compare current" toggle is on.
    if (this.includeCurrent()) {
      const currentEntries = Object.entries(this.data.loadout()).map(
        ([k, v]) => [k, v] as [string, Item]
      );
      result.push({ ...this.computeStats(currentEntries, ship, this.data.powerAlloc()), label: 'Current' });
    }

    // Selected saved loadouts — look up each loadout's ship for correct stats
    const allShips = this.data.ships();
    const indices = Array.from(this.selectedIndices()).sort((a, b) => a - b);
    for (const idx of indices) {
      const saved = this.allLoadouts[idx];
      if (!saved) continue;
      const savedShip = allShips.find(s => s.className === saved.shipClassName) ?? ship;
      const entries: [string, Item][] = [];
      for (const [slotId, className] of Object.entries(saved.items)) {
        const item = allItems.find(i => i.className === className);
        if (item) entries.push([slotId, item]);
      }
      result.push({ ...this.computeStats(entries, savedShip, saved.powerAlloc ?? {}), label: saved.name });
    }

    return result;
  });

  // Stats to compare as rows
  statRows = computed(() => {
    const cols = this.columns();
    if (cols.length < 1) return [];

    const rows: { label: string; values: number[]; unit: string; invert: boolean; section?: string }[] = [
      // Firepower
      { label: 'Peak DPS (Pilot)', values: cols.map(c => c.peakDpsPilot), unit: '', invert: false, section: 'Firepower' },
      { label: 'Total Alpha', values: cols.map(c => c.totalAlpha), unit: '', invert: false },
      { label: 'Avg Projectile Speed', values: cols.map(c => c.avgProjectileSpeed), unit: ' m/s', invert: false },
      // Defense
      { label: 'Shield HP', values: cols.map(c => c.shieldHp), unit: '', invert: false, section: 'Defense' },
      { label: 'Shield Regen/s', values: cols.map(c => c.shieldRegen), unit: '', invert: false },
      // Lower = better (regen to full faster). Zero regen → 0 (rendered as "—"
      // via the template check if you want — for now we show "0 s").
      { label: 'Full Regen Time', values: cols.map(c => c.shieldRegen > 0 ? c.shieldHp / c.shieldRegen : 0), unit: ' s', invert: true },
      { label: 'Phys Resist', values: cols.map(c => c.shieldResistPhys), unit: '%', invert: false },
      { label: 'Enrg Resist', values: cols.map(c => c.shieldResistEnrg), unit: '%', invert: false },
      // Armor
      { label: 'Armor Deflect (Phys)', values: cols.map(c => c.armorDeflectPhys), unit: '', invert: false, section: 'Armor' },
      { label: 'Armor Deflect (Enrg)', values: cols.map(c => c.armorDeflectEnrg), unit: '', invert: false },
      // Rotation
      { label: 'Pitch', values: cols.map(c => c.pitch), unit: '°/s', invert: false, section: 'Rotation' },
      { label: 'Yaw', values: cols.map(c => c.yaw), unit: '°/s', invert: false },
      { label: 'Roll', values: cols.map(c => c.roll), unit: '°/s', invert: false },
      // Ordnance
      { label: 'Missile Count', values: cols.map(c => c.missileCount), unit: '', invert: false, section: 'Ordnance' },
      { label: 'Missile Salvo Dmg', values: cols.map(c => c.missileTotalDmg), unit: '', invert: false },
      // Systems
      { label: 'Power Output', values: cols.map(c => c.powerOutput), unit: '', invert: false, section: 'Systems' },
      { label: 'Power Draw', values: cols.map(c => c.powerDraw), unit: '', invert: true },
      { label: 'Cooling Rate', values: cols.map(c => c.coolingRate), unit: '', invert: false },
      // Signatures
      { label: 'EM Signature', values: cols.map(c => c.emSignature), unit: '', invert: true, section: 'Signatures' },
      { label: 'IR Signature', values: cols.map(c => c.irSignature), unit: '', invert: true },
      // Quantum
      { label: 'QT Speed', values: cols.map(c => c.qtSpeed), unit: ' m/s', invert: false, section: 'Quantum' },
      { label: 'QT Range', values: cols.map(c => c.qtRange), unit: ' Gm', invert: false },
      // Industrial
      { label: 'Mining Lasers', values: cols.map(c => c.miningLaserCount), unit: '', invert: false, section: 'Industrial' },
      { label: 'Mining Min Power', values: cols.map(c => c.miningMinPower), unit: '', invert: false },
      { label: 'Mining Max Power', values: cols.map(c => c.miningMaxPower), unit: '', invert: false },
      { label: 'Mining Opt Range', values: cols.map(c => c.miningOptimalRange), unit: ' m', invert: false },
      { label: 'Mining Max Range', values: cols.map(c => c.miningMaxRange), unit: ' m', invert: false },
      { label: 'Salvage Heads', values: cols.map(c => c.salvageHeadCount), unit: '', invert: false },
      { label: 'Cargo', values: cols.map(c => c.cargoCapacity), unit: ' SCU', invert: false },
    ];

    // Add crew DPS row only if any column has crew weapons
    if (cols.some(c => c.peakDpsCrew > 0)) {
      rows.splice(1, 0, { label: 'Peak DPS (Crew)', values: cols.map(c => c.peakDpsCrew), unit: '', invert: false });
    }

    // Filter out rows where all values are 0
    return rows.filter(r => r.values.some(v => v > 0));
  });

  bestIndex(values: number[], invert: boolean): number {
    if (values.length < 2) return -1;
    let bestIdx = 0;
    for (let i = 1; i < values.length; i++) {
      const isBetter = invert ? values[i] < values[bestIdx] : values[i] > values[bestIdx];
      if (isBetter) bestIdx = i;
    }
    // Only highlight if not all equal
    return values.every(v => Math.abs(v - values[0]) < 0.1) ? -1 : bestIdx;
  }

  private isTurret(hp: Hardpoint | undefined, ship: Ship): boolean {
    if (!hp) return false;
    const FORCE_PILOT: Record<string, Set<string>> = {
      'aegs_redeemer': new Set(['hardpoint_turret_remote_front']),
    };
    if (FORCE_PILOT[ship.className?.toLowerCase()]?.has(hp.id.toLowerCase())) return false;
    if (hp.type === 'TurretBase') return true;
    if (hp.type === 'Turret') {
      const ct = hp.controllerTag?.toLowerCase() ?? '';
      return !!ct && !ct.includes('remote_turret') && !ct.startsWith('pilotseat') && !ct.includes('gunnacelle') && !ct.includes('gunnose');
    }
    return false;
  }

  private computeStats(entries: [string, Item][], ship: Ship, powerAlloc: Record<string, number> = {}): Omit<LoadoutStats, 'label'> {
    const hardpoints = ship.hardpoints ?? [];
    let peakDpsPilot = 0, peakDpsCrew = 0, totalAlpha = 0;
    const pilotWeapons: WeaponEntry[] = [];
    const crewWeapons: WeaponEntry[] = [];
    let shieldHp = 0, shieldCount = 0;
    // Shields 1-2 are active (contribute regen); 3+ are reserve (HP only).
    // We track primaries to scale regen by allocated power pips — mirrors the
    // dps-panel formula so "Full Regen Time" matches the in-app live figure.
    const primaryShields: { slotId: string; item: Item }[] = [];
    const missileMap: Record<string, MissileGroup> = {};
    let missileTotalDmg = 0;
    let powerOutput = 0, powerDraw = 0, coolingRate = 0;
    let emSignature = 0, irSignature = 0;
    let qtSpeed = 0, qtRange = 0;
    let resistPhysSum = 0, resistEnrgSum = 0, resistDistSum = 0;
    let velocitySum = 0, velocityCount = 0;
    let miningLaserCount = 0, miningMinPower = 0, miningMaxPower = 0;
    let miningOptimalRange = 0, miningMaxRange = 0;
    let salvageHeadCount = 0;

    for (const [slotId, item] of entries) {
      const isGun = item.type === 'WeaponGun' || item.type === 'WeaponTachyon';
      const isPdc = slotId.toLowerCase().includes('_pdc');

      if (isGun && !isPdc) {
        const topKey = slotId.split('.')[0];
        const hp = hardpoints.find(h => h.id.toLowerCase() === topKey.toLowerCase());
        const isCrew = this.isTurret(hp, ship);
        const dps = item.dps ?? 0;
        const alpha = item.alphaDamage ?? 0;
        const entry: WeaponEntry = {
          name: item.name ?? item.className,
          size: item.size ?? 0,
          dps: Math.round(dps * 10) / 10,
          alpha: Math.round(alpha * 10) / 10,
          type: item.isBallistic ? 'Ballistic' : 'Energy',
        };
        if (isCrew) { peakDpsCrew += dps; crewWeapons.push(entry); }
        else { peakDpsPilot += dps; pilotWeapons.push(entry); }
        totalAlpha += alpha;
        if (item.projectileSpeed && item.projectileSpeed > 0 && !isCrew) {
          velocitySum += item.projectileSpeed;
          velocityCount++;
        }
      }

      if (item.type === 'Shield') {
        shieldHp += item.hp ?? 0;
        // In-game, a ship runs at most 2 shields "active" at once. Any shields
        // beyond the first two are reserve pools — they add HP but contribute
        // no regen (they auto-activate when the active pair depletes).
        if (shieldCount < 2) primaryShields.push({ slotId, item });
        shieldCount++;
        resistPhysSum += item.resistPhysMax ?? 0;
        resistEnrgSum += item.resistEnrgMax ?? 0;
        resistDistSum += item.resistDistMax ?? 0;
      }

      if (item.type === 'Missile') {
        const key = item.className;
        if (!missileMap[key]) missileMap[key] = { name: item.name ?? key, size: item.size ?? 0, count: 0 };
        missileMap[key].count++;
        missileTotalDmg += item.alphaDamage ?? 0;
      }

      if (item.type === 'PowerPlant') {
        powerOutput += item.powerOutput ?? 0;
        emSignature += item.emSignature ?? 0;
      } else {
        powerDraw += item.powerDraw ?? 0;
      }

      if (item.type === 'Cooler') {
        coolingRate += item.coolingRate ?? 0;
        irSignature += item.emSignature ?? 0;
      }

      if (item.type === 'QuantumDrive') {
        qtSpeed = item.speed ?? 0;
        qtRange = item.range ?? 0;
      }

      if (item.type === 'WeaponMining') {
        miningLaserCount++;
        miningMinPower += item.miningMinPower ?? 0;
        miningMaxPower += item.miningMaxPower ?? 0;
        miningOptimalRange = Math.max(miningOptimalRange, item.optimalRange ?? 0);
        miningMaxRange = Math.max(miningMaxRange, item.maxRange ?? 0);
      }

      if (item.type === 'SalvageHead') {
        salvageHeadCount++;
      }
    }

    // Scale shield regen by allocated power pips, mirroring dps-panel.ts's
    // formula: regen = maxRegen × (totalAlloc / totalMax). Max regen is the
    // theoretical ceiling at full pips; in practice the player splits pips
    // between the two primaries. The saved loadout carries its own powerAlloc.
    const maxPrimaryRegen = primaryShields.reduce((s, { item }) => s + (item.regenRate ?? 0), 0);
    const totalAlloc = primaryShields.reduce((s, { slotId }) => s + (powerAlloc[slotId] ?? 0), 0);
    const totalMax = primaryShields.reduce((s, { item }) => s + Math.max(1, (item.powerMax ?? 0) - 1), 0);
    const shieldRegen = (totalMax > 0 && totalAlloc > 0) ? maxPrimaryRegen * (totalAlloc / totalMax) : 0;

    return {
      peakDpsPilot: Math.round(peakDpsPilot),
      peakDpsCrew: Math.round(peakDpsCrew),
      totalAlpha: Math.round(totalAlpha * 10) / 10,
      pilotWeapons, crewWeapons,
      shieldHp: Math.round(shieldHp),
      shieldRegen: Math.round(shieldRegen),
      shieldCount,
      missileCount: Object.values(missileMap).reduce((s, m) => s + m.count, 0),
      missileTotalDmg: Math.round(missileTotalDmg),
      missileGroups: Object.values(missileMap).sort((a, b) => b.size - a.size),
      powerOutput: Math.round(powerOutput),
      powerDraw: Math.round(powerDraw),
      coolingRate: Math.round(coolingRate),
      emSignature: Math.round(emSignature),
      irSignature: Math.round(irSignature),
      qtSpeed: Math.round(qtSpeed),
      qtRange: Math.round(qtRange * 10) / 10,
      shieldResistPhys: shieldCount > 0 ? Math.round(resistPhysSum / shieldCount * 100) : 0,
      shieldResistEnrg: shieldCount > 0 ? Math.round(resistEnrgSum / shieldCount * 100) : 0,
      shieldResistDist: shieldCount > 0 ? Math.round(resistDistSum / shieldCount * 100) : 0,
      armorDeflectPhys: ship.armorDeflectPhys ?? 0,
      armorDeflectEnrg: ship.armorDeflectEnrg ?? 0,
      pitch: ship.pitch ?? 0,
      yaw: ship.yaw ?? 0,
      roll: ship.roll ?? 0,
      avgProjectileSpeed: velocityCount > 0 ? Math.round(velocitySum / velocityCount) : 0,
      miningLaserCount,
      miningMinPower: Math.round(miningMinPower),
      miningMaxPower: Math.round(miningMaxPower),
      miningOptimalRange: Math.round(miningOptimalRange),
      miningMaxRange: Math.round(miningMaxRange),
      salvageHeadCount,
      cargoCapacity: ship.cargoCapacity ?? 0,
    };
  }

  fmtNum(n: number): string {
    return n.toLocaleString('en-US', { maximumFractionDigits: 1 });
  }
}
