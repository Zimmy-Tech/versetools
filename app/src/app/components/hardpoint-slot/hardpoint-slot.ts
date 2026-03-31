import { Component, input, computed, signal, HostListener, ElementRef } from '@angular/core';
import { DataService } from '../../services/data.service';
import { Hardpoint, Item, calcWeaponAmmo, calcMaxPips, componentCoolingDemand } from '../../models/db.models';

@Component({
  selector: 'app-hardpoint-slot',
  standalone: true,
  templateUrl: './hardpoint-slot.html',
  styleUrl: './hardpoint-slot.scss',
})
export class HardpointSlotComponent {
  hardpoint   = input.required<Hardpoint>();
  rackLeafIds = input<string[]>([]);
  miningCombined = input<Record<string, number> | null>(null);
  collapsed   = input(false);

  isLocked = computed(() => {
    const flags = this.hardpoint().flags ?? '';
    return flags.includes('uneditable') || flags.includes('$uneditable');
  });

  options = computed(() => this.data.getOptionsForSlot(this.hardpoint()));

  // Show rich picker when any option is a gun (WeaponGun / WeaponTachyon)
  isWeaponSlot = computed(() =>
    this.options().some(o => o.type === 'WeaponGun' || o.type === 'WeaponTachyon' || o.type === 'TractorBeam')
  );

  isShieldSlot = computed(() =>
    this.options().some(o => o.type === 'Shield')
  );

  isCoolerSlot = computed(() =>
    this.options().some(o => o.type === 'Cooler')
  );

  isRadarSlot = computed(() =>
    this.options().some(o => o.type === 'Radar')
  );

  fmtRadarMinPwr(opt: Item): string {
    const pd = opt.powerDraw ?? 0;
    const mcf = opt.minConsumptionFraction ?? 0.25;
    return pd > 0 ? Math.max(1, Math.round(pd * mcf)).toString() : '—';
  }

  isMissileSlot = computed(() =>
    this.options().some(o => o.type === 'Missile')
  );

  isPowerPlantSlot = computed(() =>
    this.options().some(o => o.type === 'PowerPlant')
  );

  isQuantumDriveSlot = computed(() =>
    this.options().some(o => o.type === 'QuantumDrive')
  );

  isLifeSupportSlot = computed(() =>
    this.hardpoint().type === 'LifeSupportGenerator' ||
    this.options().some(o => o.type === 'LifeSupportGenerator')
  );

  isMiningModSlot = computed(() =>
    this.hardpoint().type === 'MiningModifier' ||
    this.options().some(o => o.type === 'MiningModifier')
  );

  private readonly HIDE_LABEL_TYPES = new Set([
    'Shield', 'PowerPlant', 'Cooler', 'QuantumDrive', 'Radar', 'LifeSupportGenerator',
    'WeaponGun', 'WeaponTachyon', 'TractorBeam',
  ]);
  hideLabel = computed(() => this.HIDE_LABEL_TYPES.has(this.hardpoint().type));

  fmtMod(v: number | undefined | null): string {
    if (v == null) return '—';
    return (v > 0 ? '+' : '') + v + '%';
  }

  lsStats = computed(() => {
    const item = this.currentItem();
    if (!item || item.type !== 'LifeSupportGenerator') return null;
    const pips = this.data.powerAlloc()[this.hardpoint().id] ?? 0;
    const cooling = componentCoolingDemand(item, pips);
    return {
      pips, powerDraw: item.powerDraw ?? 0, cooling: cooling.toFixed(1),
      hp: item.componentHp ?? 0, emMax: item.emMax ?? 0,
      distMax: item.distortionMax ?? 0,
    };
  });

  currentItem = computed(() => this.data.loadout()[this.hardpoint().id] ?? null);

  hasPowerToggle = computed(() => {
    const item = this.currentItem();
    if (!item || item.type === 'Missile') return false;
    return (item.emSignature ?? 0) > 0 || (item.emMax ?? 0) > 0 ||
           (item.irSignature ?? 0) > 0 ||
           (item.dps ?? 0) > 0 || (item.alphaDamage ?? 0) > 0;
  });

  isPowered = computed(() => !this.data.poweredOff().has(this.hardpoint().id));

  hasPowerSegs = computed(() => (this.currentItem()?.powerBands?.length ?? 0) > 0);

  isFlightRestricted = computed(() => this.data.isFlightRestricted(this.currentItem()));

  allocated = computed(() => this.data.powerAlloc()[this.hardpoint().id] ?? 0);

  effectiveMod = computed(() => this.data.getMod(this.allocated(), this.currentItem()));

  /** Jane's Spec Card data — primary stat callout + classification for supported types. */
  janeCard = computed<{ classCode: string; primaryVal: string; primaryUnit: string; meta: string[] } | null>(() => {
    const item = this.currentItem();
    if (!item) return null;
    const mfr = item.manufacturer || '—';
    const grade = item.grade ? 'Grade ' + item.grade : '';
    const cls = item.itemClass || '';
    const meta = [mfr, grade, cls].filter(Boolean);

    switch (item.type) {
      case 'WeaponGun':
      case 'WeaponTachyon': {
        const dmg = item.damage ?? {} as any;
        let dmgType = 'ENERGY';
        if (item.isBallistic) dmgType = 'BALLISTIC';
        else if (dmg.distortion > 0) dmgType = 'DISTORTION';
        const gMult = this.data.gimbalMode() === 'gimbal' ? this.data.GIMBAL_FIRE_RATE_MULT : 1;
        return { classCode: dmgType.slice(0, 4) + '-S' + (item.size ?? '?'), primaryVal: ((item.dps ?? 0) * gMult).toFixed(0), primaryUnit: 'DPS', meta };
      }
      case 'Missile':
        return { classCode: 'MSL-S' + (item.size ?? '?'), primaryVal: (item.alphaDamage ?? 0).toFixed(0), primaryUnit: 'DMG', meta };
      case 'Shield':
        return { classCode: 'SHD-' + (item.size ?? '?'), primaryVal: (item.hp ?? 0).toLocaleString(), primaryUnit: 'HP', meta };
      case 'PowerPlant':
        return { classCode: 'PWR-' + (item.size ?? '?'), primaryVal: (item.powerOutput ?? 0).toString(), primaryUnit: 'SEG', meta };
      case 'Cooler':
        return { classCode: 'CLR-' + (item.size ?? '?'), primaryVal: (item.coolingRate ?? 0).toLocaleString(), primaryUnit: 'RATE', meta };
      case 'QuantumDrive':
        return { classCode: 'QDR-' + (item.size ?? '?'), primaryVal: item.speed ? ((item.speed / 1e3).toFixed(0)) : '—', primaryUnit: 'Mm/s', meta };
      case 'Radar': {
        const alloc = this.data.powerAlloc();
        const pips = alloc[this.hardpoint().id] ?? 0;
        const maxPips = Math.max(1, item.powerDraw ?? 1);
        const frac = Math.min(pips / maxPips, 1);
        const lockRange = (item.aimMin ?? 0) + ((item.aimMax ?? 0) - (item.aimMin ?? 0)) * frac;
        return { classCode: 'RDR-' + (item.size ?? '?'), primaryVal: lockRange.toFixed(0), primaryUnit: 'm LOCK', meta };
      }
      case 'WeaponMining':
        return { classCode: 'MNG-' + (item.size ?? '?'), primaryVal: (item.miningMaxPower ?? 0).toFixed(0), primaryUnit: 'PWR', meta };
      case 'SalvageHead':
        return { classCode: 'SLV-' + (item.size ?? '?'), primaryVal: 'S' + (item.size ?? '?'), primaryUnit: 'HEAD', meta };
      case 'SalvageModifier': {
        const ship = this.data.selectedShip();
        const hs = ship?.salvageSpeedMult ?? 1;
        const effSpeed = item.salvageSpeed ? (item.salvageSpeed * hs) : 0;
        return { classCode: 'SLV-' + (item.size ?? '?'), primaryVal: effSpeed > 0 ? effSpeed.toFixed(2) : '—', primaryUnit: 'SPD', meta };
      }
      case 'LifeSupportGenerator':
        return { classCode: 'LSG-' + (item.size ?? '?'), primaryVal: (item.componentHp ?? 0).toString(), primaryUnit: 'HP', meta };
      case 'EMP':
        return { classCode: 'EMP-S' + (item.size ?? '?'), primaryVal: (item.distortionDamage ?? 0).toFixed(0), primaryUnit: 'DMG', meta };
      case 'QuantumInterdictionGenerator':
        return { classCode: 'QED-S' + (item.size ?? '?'), primaryVal: (item.powerDraw ?? 0).toString(), primaryUnit: 'SEG', meta };
      case 'FlightController':
        return { classCode: 'BLADE', primaryVal: (item.scmSpeed ?? 0).toFixed(0), primaryUnit: 'm/s SCM', meta };
      default:
        return null;
    }
  });

  /** Compact inline weapon card data. */
  weaponCompact = computed<{ size: string; name: string; dmgType: string; stats: { key: string; val: string; cls?: string }[] } | null>(() => {
    const item = this.currentItem();
    if (!item || (item.type !== 'WeaponGun' && item.type !== 'WeaponTachyon' && item.type !== 'TractorBeam')) return null;
    const _alloc = this.data.powerAlloc(); // reactivity

    if (item.type === 'TractorBeam') {
      return { size: 'S' + (item.size ?? '?'), name: item.name, dmgType: 'TRACTOR', stats: [] };
    }

    const dmg = item.damage ?? {};
    let dmgType = 'ENERGY';
    if (item.isBallistic) dmgType = 'BALLISTIC';
    else if ((dmg as any).distortion > 0) dmgType = 'DISTORTION';

    const gMult = this.data.gimbalMode() === 'gimbal' ? this.data.GIMBAL_FIRE_RATE_MULT : 1;
    const stats: { key: string; val: string; cls?: string }[] = [];
    if (item.dps) stats.push({ key: 'DPS', val: (item.dps * gMult).toFixed(1) });
    if (item.alphaDamage) stats.push({ key: 'ALPHA', val: item.alphaDamage.toFixed(1) });

    if (item.penetrationDistance) stats.push({ key: 'PEN.D', val: item.penetrationDistance.toFixed(2) + 'm' });
    if (item.penetrationMaxRadius) stats.push({ key: 'PEN.R', val: item.penetrationMinRadius?.toFixed(2) + '-' + item.penetrationMaxRadius.toFixed(2) + 'm' });

    if (item.isBallistic) {
      if (item.heatPerShot && item.maxHeat && item.fireRate) {
        const rounds = Math.floor(item.maxHeat / item.heatPerShot);
        const time = rounds / (item.fireRate / 60);
        stats.push({ key: 'OH', val: time.toFixed(1) + 's', cls: 'warn' });
        if (item.overheatCooldown) {
          stats.push({ key: 'COOL', val: item.overheatCooldown.toFixed(1) + 's', cls: 'warn' });
        }
      }
    } else {
      const poolSize = this.data.selectedShip()?.weaponPowerPoolSize ?? 4;
      const curPips = this.data.weaponsPower();
      const allWeapons = this.data.allLoadoutWeapons();
      const maxPips = calcMaxPips(poolSize, allWeapons);
      const displayPips = curPips > 0 ? Math.min(curPips, maxPips) : maxPips;
      const mult = this.data.selectedShip()?.ammoLoadMultiplier ?? 1;
      const ammo = calcWeaponAmmo(item, displayPips, poolSize, allWeapons, mult);
      if (ammo != null) {
        stats.push({ key: 'AMMO', val: `${ammo} (${displayPips}/${maxPips})` });
      }
      const regenRPS = item.maxRegenPerSec ?? 15;
      const regenTime = (item.regenCooldown ?? 0.25) + (ammo ?? 0) / regenRPS;
      stats.push({ key: 'REGEN', val: regenTime.toFixed(1) + 's' });
    }

    return { size: 'S' + (item.size ?? '?'), name: item.name, dmgType, stats };
  });

  /** Compact inline missile card data. */
  missileCompact = computed<{ size: string; name: string; acqType: string; count: number; stats: { key: string; val: string; cls?: string }[] } | null>(() => {
    const item = this.currentItem();
    if (!item || item.type !== 'Missile') return null;
    const capacity = this.rackLeafIds().length;

    const stats: { key: string; val: string }[] = [];
    if (item.alphaDamage) {
      const totalDmg = item.alphaDamage * (capacity || 1);
      stats.push({ key: 'DMG', val: totalDmg.toFixed(0) });
    }
    if (item.explosionMaxRadius) stats.push({ key: 'BLAST', val: item.explosionMinRadius?.toFixed(0) + '-' + item.explosionMaxRadius.toFixed(0) + 'm' });
    if (item.lockTime) stats.push({ key: 'LOCK', val: item.lockTime.toFixed(1) + 's' });
    if (item.lockRangeMax) stats.push({ key: 'RNG', val: (item.lockRangeMax / 1000).toFixed(1) + 'km' });

    const acq = item.acquisition ?? item.subType ?? '';
    return {
      size: 'S' + (this.hardpoint().maxSize ?? '?'),
      name: item.name,
      acqType: acq.toUpperCase(),
      count: capacity || 1,
      stats,
    };
  });

  canAddPwr = computed(() => {
    if (this.isFlightRestricted()) return false;
    if (this.allocated() >= (this.currentItem()?.powerMax ?? 0)) return false;
    const totalOut = this.data.totalPowerOut();
    return totalOut === 0 || this.data.totalPowerUsed() < totalOut;
  });

  adjustPwr(delta: number, e: MouseEvent): void {
    e.stopPropagation();
    const item = this.currentItem();
    const cur  = this.allocated();
    const pMin = item?.powerMin ?? 1;
    let next: number;
    if (delta < 0) {
      // Decrement: jump from powerMin straight to 0 (no dead-zone values)
      next = cur <= pMin ? 0 : cur - 1;
    } else {
      // Increment: jump from 0 straight to powerMin
      next = cur === 0 ? pMin : cur + 1;
    }
    this.data.setPowerAlloc(this.hardpoint().id, next, item);
  }

  togglePower(e: MouseEvent): void {
    e.stopPropagation();
    this.data.togglePower(this.hardpoint().id);
  }

  pickerOpen       = signal(false);
  pickerSearch     = signal('');
  pickerSizeFilter = signal<number | null>(null);
  pickerTop        = signal('0px');
  pickerLeft       = signal('0px');
  pickerSortKey    = signal<string>('');
  pickerSortAsc    = signal(true);

  toggleSort(key: string): void {
    if (this.pickerSortKey() === key) {
      this.pickerSortAsc.set(!this.pickerSortAsc());
    } else {
      this.pickerSortKey.set(key);
      this.pickerSortAsc.set(key === 'name'); // name defaults ascending, numbers descending
    }
  }

  sortIndicator(key: string): string {
    if (this.pickerSortKey() !== key) return '';
    return this.pickerSortAsc() ? ' ▲' : ' ▼';
  }

  availableSizes = computed(() => {
    const sizes = [...new Set(this.options().map(o => o.size ?? 0).filter(s => s > 0))];
    return sizes.sort((a, b) => a - b);
  });

  filteredOptions = computed(() => {
    const q = this.pickerSearch().toLowerCase().trim();
    const sizeFilter = this.pickerSizeFilter();
    const sortKey = this.pickerSortKey();
    const asc = this.pickerSortAsc();

    let opts = this.options();
    if (sizeFilter !== null) opts = opts.filter(o => o.size === sizeFilter);
    if (q) {
      opts = opts.filter(o =>
        o.name.toLowerCase().includes(q) ||
        (o.subType ?? '').toLowerCase().includes(q) ||
        (o.manufacturer ?? '').toLowerCase().includes(q) ||
        (o.itemClass ?? '').toLowerCase().includes(q) ||
        String(o.size) === q
      );
    }

    if (sortKey) {
      opts = [...opts].sort((a, b) => {
        let va: any = (a as any)[sortKey];
        let vb: any = (b as any)[sortKey];
        // Handle nulls
        if (va == null) va = typeof vb === 'string' ? '' : 0;
        if (vb == null) vb = typeof va === 'string' ? '' : 0;
        let cmp: number;
        if (typeof va === 'string') cmp = va.localeCompare(vb);
        else cmp = (va as number) - (vb as number);
        return asc ? cmp : -cmp;
      });
    }

    return opts;
  });

  slotStat = computed(() => {
    const item = this.currentItem();
    if (!item) return '';
    if ((item.dps ?? 0) > 0)          return `${item.dps!.toFixed(0)} DPS`;
    if ((item.hp ?? 0) > 0)           return `${item.hp!.toFixed(0)} HP`;
    if ((item.powerOutput ?? 0) > 0)  return `${item.powerOutput} PWR`;
    if ((item.coolingRate ?? 0) > 0)  return `${item.coolingRate!.toFixed(0)} COOL`;
    if ((item.speed ?? 0) > 0)        return `${((item.speed ?? 0) / 1e3).toFixed(0)} Mm/s`;
    if (item.type === 'LifeSupportGenerator') return '';
    if (item.type === 'Missile') {
      const capacity = this.rackLeafIds().length;
      const alpha = item.alphaDamage ?? 0;
      if (capacity > 0 && alpha > 0) return `${(alpha * capacity).toFixed(0)} dmg`;
      if (alpha > 0) return `${alpha.toFixed(0)} dmg`;
      if (item.subType) return item.subType;
    }
    return '';
  });

  missileLabel = computed(() => {
    const item = this.currentItem();
    if (!item) return '— Empty —';
    const capacity = this.rackLeafIds().length;
    if (capacity > 0) return `${item.name} (×${capacity} S${this.hardpoint().maxSize})`;
    return item.name;
  });

  typeLabel = computed(() => {
    const hp = this.hardpoint();
    return hp.type.replace('Launcher', '').replace('Gun', '').trim();
  });

  /** Compute ammo for a weapon option using the full loadout context. */
  ammoForOption(opt: Item): string {
    if (opt.isBallistic) return opt.ammoCount?.toString() ?? '—';
    const ship = this.data.selectedShip();
    const poolSize = ship?.weaponPowerPoolSize ?? 4;
    const mult = ship?.ammoLoadMultiplier ?? 1;
    const allWeapons = this.data.allLoadoutWeapons();
    const maxPips = calcMaxPips(poolSize, allWeapons);
    const ammo = calcWeaponAmmo(opt, maxPips, poolSize, allWeapons, mult);
    return ammo != null ? ammo.toString() : '—';
  }

  itemStatRows = computed(() => {
    const item = this.currentItem();
    const _alloc = this.data.powerAlloc(); // dependency: re-run when power pips change
    if (!item) return [];
    type Row = { label: string; value: string; cls?: string; divider?: true };
    const rows: Row[] = [];
    const f = (v: number | undefined, d = 0) => (v == null || v === 0) ? null : v.toFixed(d);
    const p = (v: number | undefined) => ((v ?? 0) * 100).toFixed(0) + '%';

    if (item.type === 'WeaponGun' || item.type === 'WeaponTachyon') {
      if (item.dps) rows.push({ label: 'DPS', value: item.dps.toFixed(1) });
      if (item.alphaDamage) rows.push({ label: 'Alpha', value: item.alphaDamage.toFixed(1) });
      if (item.fireRate) rows.push({ label: 'Fire Rate', value: item.fireRate.toFixed(0) + ' rpm' });
      if (item.projectileSpeed) rows.push({ label: 'Velocity', value: item.projectileSpeed.toFixed(0) + ' m/s' });
      if (item.range) rows.push({ label: 'Range', value: item.range.toFixed(0) + 'm' });
      if (item.penetrationDistance) rows.push({ label: 'Pen. Distance', value: item.penetrationDistance.toFixed(2) + 'm' });
      if (item.penetrationMaxRadius) rows.push({ label: 'Pen. Radius', value: item.penetrationMinRadius?.toFixed(2) + '–' + item.penetrationMaxRadius.toFixed(2) + 'm' });
      if (item.isBallistic) {
        if (item.heatPerShot && item.maxHeat && item.fireRate) {
          const rounds = Math.floor(item.maxHeat / item.heatPerShot);
          const ohTime = rounds / (item.fireRate / 60);
          rows.push({ label: 'Overheat', value: ohTime.toFixed(1) + 's (' + rounds + ' rds)', cls: 'warn' });
          if (item.overheatCooldown) rows.push({ label: 'Cooldown', value: item.overheatCooldown.toFixed(1) + 's' });
        }
        if (item.ammoCount) rows.push({ label: 'Magazine', value: item.ammoCount.toString() + ' rds' });
      } else {
        const poolSize = this.data.selectedShip()?.weaponPowerPoolSize ?? 4;
        const curPips = this.data.weaponsPower();
        const allWeapons = this.data.allLoadoutWeapons();
        const maxPips = calcMaxPips(poolSize, allWeapons);
        const displayPips = curPips > 0 ? Math.min(curPips, maxPips) : maxPips;
        const mult = this.data.selectedShip()?.ammoLoadMultiplier ?? 1;
        const ammo = calcWeaponAmmo(item, displayPips, poolSize, allWeapons, mult);
        if (ammo != null) rows.push({ label: 'Ammo', value: `${ammo} (${displayPips}/${maxPips} pips)` });
        const regenRPS = item.maxRegenPerSec ?? 15;
        const regenTime = (item.regenCooldown ?? 0.25) + (ammo ?? 0) / regenRPS;
        rows.push({ label: 'Regen', value: regenTime.toFixed(1) + 's' });
      }
    } else if (item.type === 'Missile') {
      if (item.alphaDamage) rows.push({ label: 'Damage', value: item.alphaDamage.toFixed(0) });
      if (item.explosionMaxRadius) rows.push({ label: 'Blast Radius', value: item.explosionMinRadius?.toFixed(0) + '–' + item.explosionMaxRadius.toFixed(0) + 'm' });
      if (item.lockTime) rows.push({ label: 'Lock Time', value: item.lockTime.toFixed(1) + 's' });
      if (item.lockRangeMax) rows.push({ label: 'Lock Range', value: item.lockRangeMax.toFixed(0) + 'm' });
      if (item.speed) rows.push({ label: 'Speed', value: item.speed.toFixed(0) + ' m/s' });
      const dmg = item.damage ?? {} as any;
      if (dmg.physical > 0 || dmg.energy > 0 || dmg.distortion > 0) {
        rows.push({ label: '', value: '', divider: true });
        if (dmg.physical > 0) rows.push({ label: 'Physical', value: dmg.physical.toFixed(1), cls: 'phys' });
        if (dmg.energy > 0) rows.push({ label: 'Energy', value: dmg.energy.toFixed(1), cls: 'enrg' });
        if (dmg.distortion > 0) rows.push({ label: 'Distortion', value: dmg.distortion.toFixed(1), cls: 'dist' });
      }
    } else if (item.type === 'Shield') {
      if (item.hp) rows.push({ label: 'HP Pool', value: f(item.hp)! });
      if (item.regenRate) rows.push({ label: 'Regen', value: f(item.regenRate) + '/s' });
      if (item.damagedRegenDelay) rows.push({ label: 'Dmg Delay', value: f(item.damagedRegenDelay, 1) + 's' });
      if (item.downedRegenDelay) rows.push({ label: 'Dwn Delay', value: f(item.downedRegenDelay, 1) + 's' });
      if ((item.resistPhysMax ?? 0) !== 0 || (item.resistEnrgMax ?? 0) !== 0) {
        rows.push({ label: '', value: '', divider: true });
        rows.push({ label: 'Resist Phys', value: p(item.resistPhysMax) + ' / ' + p(item.resistPhysMin), cls: 'phys' });
        rows.push({ label: 'Resist Enrg', value: p(item.resistEnrgMax) + ' / ' + p(item.resistEnrgMin), cls: 'enrg' });
        rows.push({ label: 'Resist Dist', value: p(item.resistDistMax) + ' / ' + p(item.resistDistMin), cls: 'dist' });
      }
    } else if (item.type === 'PowerPlant') {
      if (item.powerOutput) rows.push({ label: 'Output', value: item.powerOutput + ' seg' });
      if (item.emMax) rows.push({ label: 'EM', value: f(item.emMax)! });
    } else if (item.type === 'Cooler') {
      if (item.coolingRate) rows.push({ label: 'Cooling Rate', value: f(item.coolingRate)! });
      if (item.irSignature) rows.push({ label: 'IR', value: f(item.irSignature)! });
    } else if (item.type === 'QuantumDrive') {
      if (item.speed) rows.push({ label: 'Speed', value: ((item.speed) / 1000).toFixed(0) + ' Mm/s' });
      if (item.splineSpeed) rows.push({ label: 'Spline', value: item.splineSpeed.toFixed(0) + ' km/s' });
      if (item.spoolTime) rows.push({ label: 'Spool', value: item.spoolTime + 's' });
      if (item.cooldownTime) rows.push({ label: 'Cooldown', value: item.cooldownTime + 's' });
      if (item.fuelRate) rows.push({ label: 'Fuel Rate', value: item.fuelRate.toFixed(4) + ' SCU/GM' });
      if (item.interdictionTime) rows.push({ label: 'Interdiction', value: item.interdictionTime + 's' });
    } else if (item.type === 'WeaponMining') {
      const c = this.miningCombined();  // combined stats from parent, or null
      const minPwr = c?.['miningMinPower'] ?? item.miningMinPower;
      const maxPwr = c?.['miningMaxPower'] ?? item.miningMaxPower;
      if (minPwr) rows.push({ label: 'Min Power', value: Math.round(minPwr).toString() });
      if (maxPwr) rows.push({ label: 'Max Power', value: Math.round(maxPwr).toString() });
      if (item.optimalRange) rows.push({ label: 'Opt Range', value: item.optimalRange + 'm' });
      if (item.maxRange) rows.push({ label: 'Max Range', value: item.maxRange + 'm' });
      const fmtPct = (v: number) => (v > 0 ? '+' : '') + Math.round(v) + '%';
      const modKeys: [string, string][] = [
        ['miningInstability', 'Instability'], ['miningOptimalWindow', 'Optimal Window'],
        ['miningOptimalRate', 'Optimal Rate'], ['miningResistance', 'Resistance'],
        ['miningShatterDamage', 'Shatter Dmg'], ['miningInertMaterials', 'Inert Materials'],
        ['miningOvercharge', 'Overcharge'],
      ];
      for (const [key, label] of modKeys) {
        const val = c ? c[key] : (item as any)[key];
        if (val != null) rows.push({ label, value: fmtPct(val) });
      }
      if (item.moduleSlots) rows.push({ label: 'Module Slots', value: item.moduleSlots.toString() });
    } else if (item.type === 'MiningModifier') {
      const fmtMod = (v: number | undefined) => v != null ? (v > 0 ? '+' : '') + v + '%' : null;
      const m = (label: string, v: number | undefined) => { const s = fmtMod(v); if (s) rows.push({ label, value: s }); };
      m('Instability', item.miningInstability);
      m('Opt Window', item.miningOptimalWindow);
      m('Opt Rate', item.miningOptimalRate);
      m('Resistance', item.miningResistance);
      m('Shatter Dmg', item.miningShatterDamage);
      m('Inert Mat', item.miningInertMaterials);
      m('Overcharge', item.miningOvercharge);
      if (item.charges && item.charges > 1) rows.push({ label: 'Charges', value: item.charges.toString() });
    } else if (item.type === 'Radar') {
      const pips = this.data.powerAlloc()[this.hardpoint().id] ?? 0;
      const maxPips = Math.max(1, item.powerDraw ?? 1);
      const pipFrac = Math.min(pips / maxPips, 1);
      if (item.aimMin != null && item.aimMax != null) {
        const lockRange = item.aimMin + (item.aimMax - item.aimMin) * pipFrac;
        rows.push({ label: 'Lock Range', value: lockRange.toFixed(0) + 'm' });
        rows.push({ label: 'Aim Min', value: item.aimMin.toFixed(0) + 'm' });
        rows.push({ label: 'Aim Max', value: item.aimMax.toFixed(0) + 'm' });
      }
      if (item.aimBuffer) rows.push({ label: 'Aim Buffer', value: item.aimBuffer.toFixed(0) + 'm' });
      if (item.irSensitivity) rows.push({ label: 'IR Sens', value: (item.irSensitivity * 100).toFixed(0) + '%' });
      if (item.emSensitivity) rows.push({ label: 'EM Sens', value: (item.emSensitivity * 100).toFixed(0) + '%' });
      if (item.csSensitivity) rows.push({ label: 'CS Sens', value: (item.csSensitivity * 100).toFixed(0) + '%' });
      rows.push({ label: 'Power Pips', value: pips + ' / ' + maxPips });
    } else if (item.type === 'LifeSupportGenerator') {
      if (item.componentHp) rows.push({ label: 'Health', value: f(item.componentHp)! });
      if (item.powerDraw) rows.push({ label: 'Power Draw', value: f(item.powerDraw)! });
      const pips = this.data.powerAlloc()[this.hardpoint().id] ?? 0;
      const cooling = componentCoolingDemand(item, pips);
      rows.push({ label: 'Cooling Demand', value: cooling.toFixed(1) });
      if (item.emMax) rows.push({ label: 'EM Signature', value: f(item.emMax)! });
      if (item.distortionMax) {
        rows.push({ label: '', value: '', divider: true });
        rows.push({ label: 'Distortion Max', value: f(item.distortionMax)! });
        if (item.distortionDecayRate) rows.push({ label: 'Dist Decay Rate', value: f(item.distortionDecayRate)! });
        if (item.distortionDecayDelay) rows.push({ label: 'Dist Decay Delay', value: item.distortionDecayDelay.toFixed(1) + 's' });
      }
    } else if (item.type === 'EMP') {
      if (item.distortionDamage) rows.push({ label: 'Distortion Dmg', value: f(item.distortionDamage)! });
      if (item.empRadius) rows.push({ label: 'EMP Radius', value: f(item.empRadius)! + 'm' });
      if (item.chargeTime) rows.push({ label: 'Charge Time', value: f(item.chargeTime, 1)! + 's' });
      if (item.cooldownTime) rows.push({ label: 'Cooldown', value: f(item.cooldownTime, 1)! + 's' });
    } else if (item.type === 'QuantumInterdictionGenerator') {
      if (item.powerDraw) rows.push({ label: 'Power Draw', value: item.powerDraw + ' seg' });
    } else if (item.type === 'FlightController') {
      if (item.scmSpeed) rows.push({ label: 'SCM Speed', value: f(item.scmSpeed)! + ' m/s' });
      if (item.navSpeed) rows.push({ label: 'NAV Speed', value: f(item.navSpeed)! + ' m/s' });
      if (item.boostSpeedFwd) rows.push({ label: 'Boost Fwd', value: f(item.boostSpeedFwd)! + ' m/s' });
      if (item.pitch) rows.push({ label: 'Pitch', value: f(item.pitch, 1)! + '°/s' });
      if (item.yaw) rows.push({ label: 'Yaw', value: f(item.yaw, 1)! + '°/s' });
      if (item.roll) rows.push({ label: 'Roll', value: f(item.roll, 1)! + '°/s' });
    } else if (item.type === 'SalvageModifier' && item.salvageSpeed) {
      const ship = this.data.selectedShip();
      const hs = ship?.salvageSpeedMult ?? 1;
      const hr = ship?.salvageRadiusMult ?? 1;
      const he = ship?.salvageEfficiency ?? 1;
      rows.push({ label: 'Speed', value: (item.salvageSpeed * hs).toFixed(2) + 'x' });
      rows.push({ label: 'Radius', value: (item.salvageRadius! * hr).toFixed(2) + 'm' });
      rows.push({ label: 'Efficiency', value: ((item.salvageEfficiency! * he) * 100).toFixed(0) + '%' });
    }
    return rows;
  });

  constructor(public data: DataService, private elRef: ElementRef) {}

  @HostListener('document:click', ['$event'])
  onDocClick(e: MouseEvent) {
    if (!this.elRef.nativeElement.contains(e.target as Node)) {
      this.pickerOpen.set(false);
      this.pickerSearch.set('');
    }
  }

  togglePicker(e: MouseEvent) {
    e.stopPropagation();
    this.pickerOpen.update(v => !v);
    if (this.pickerOpen()) {
      this.pickerSearch.set('');
      this.pickerSizeFilter.set(null);
      const rect = (this.elRef.nativeElement as HTMLElement).getBoundingClientRect();
      const maxH = window.innerHeight * 0.7;
      const spaceBelow = window.innerHeight - rect.bottom;
      if (spaceBelow < maxH && rect.top > spaceBelow) {
        // Open upward
        this.pickerTop.set(Math.max(4, rect.top - maxH) + 'px');
      } else {
        this.pickerTop.set(rect.bottom + 'px');
      }
      this.pickerLeft.set(rect.left + 'px');
      setTimeout(() => {
        const input = (this.elRef.nativeElement as HTMLElement)
          .querySelector('.picker-search') as HTMLInputElement;
        input?.focus();
      });
    }
  }

  focusItem(e: MouseEvent) {
    e.stopPropagation();
    const item = this.currentItem();
    if (item) this.data.focusedItem.set(item);
  }

  selectOption(className: string, e: MouseEvent) {
    e.stopPropagation();
    this.onChange(className);
    this.pickerOpen.set(false);
    this.pickerSearch.set('');
  }

  onChange(className: string): void {
    const item = className ? (this.data.items().find(i => i.className === className) ?? null) : null;
    const leafIds = this.rackLeafIds();
    if (leafIds.length > 0) {
      this.data.setRackItems(leafIds, item);
    } else {
      this.data.setLoadoutItem(this.hardpoint().id, item);
    }
  }

  fmt(val: number | undefined, decimals = 0): string {
    if (val == null || val === 0) return '—';
    return val.toFixed(decimals);
  }

  fmtRes(val: number | undefined): string {
    if (val == null || val === 0) return '—';
    return (Math.abs(val) * 100).toFixed(0) + '%';
  }

  fmtRegenTime(hp: number | undefined, rate: number | undefined): string {
    if (!hp || !rate) return '—';
    return (hp / rate).toFixed(1) + 's';
  }

  trackByClass(_: number, item: Item): string { return item.className; }
}
