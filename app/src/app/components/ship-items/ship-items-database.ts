import { Component, computed, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { ShipItemDbComponent, ItemColumn, DropdownFilter } from './ship-item-db';
import { Item } from '../../models/db.models';

/** Shared column prefix — every ship-item table starts with these. */
const COMMON_COLS: ItemColumn[] = [
  { label: 'Name',         field: 'name',         sortable: true },
  { label: 'Manufacturer', field: 'manufacturer', sortable: true },
  { label: 'Grade',        field: 'grade',        sortable: true },
  { label: 'Size',         field: 'size',         sortable: true, align: 'right' },
];

const COMPONENT_DROPDOWNS: DropdownFilter[] = [
  { label: 'Class', allLabel: 'All Classes', value: i => i.itemClass },
  { label: 'Grade', allLabel: 'All Grades',  value: i => i.grade },
];

/** Weapon types derived from className patterns. CIG doesn't model this as
 *  an explicit field; we infer from the className tokens. Falls back to
 *  'Other' so every weapon gets a value. */
function weaponTypeOf(i: Item): string {
  const cn = (i.className ?? '').toLowerCase();
  if (/ballisticcannon|lasercannon|plasmacannon|neutroncannon|tachyoncannon|energycannon|distortioncannon/.test(cn)) return 'Cannon';
  if (cn.includes('repeater')) return 'Repeater';
  if (cn.includes('scattergun')) return 'Scattergun';
  if (cn.includes('gatling')) return 'Gatling';
  if (cn.includes('massdriver')) return 'Mass Driver';
  if (cn.startsWith('rpod_')) return 'Rocket Pod';
  if (cn.includes('beamweapon') || cn.includes('laserbeam')) return 'Beam';
  if (cn.includes('railgun')) return 'Railgun';
  return 'Other';
}

function ammoTypeOf(i: Item): string {
  if ((i.damage?.distortion ?? 0) > 0) return 'Distortion';
  return i.isBallistic ? 'Ballistic' : 'Energy';
}

function fmtMod(v: number | null | undefined): string {
  if (v == null) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v}%`;
}

function fmtMultPct(m: number | null | undefined): string {
  if (m == null) return '—';
  const pct = Math.round((m - 1) * 100);
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct}%`;
}

function moduleTypeOf(i: Item): string {
  const st = (i.subType ?? '').toLowerCase();
  if (st === 'active') return 'Active';
  if (st === 'passive') return 'Passive';
  return '—';
}

/** Single source of truth for every ship-component DB tab. Each entry
 *  has the slug used in the URL (`?cat=`), the visible tab label, and
 *  the config passed straight into <app-ship-item-db>. */
interface ShipItemCategory {
  slug: string;
  label: string;
  title: string;
  itemType: string;
  columns: ItemColumn[];
  dropdowns: DropdownFilter[];
  defaultSort: string;
}

const SHIP_ITEM_CATEGORIES: ShipItemCategory[] = [
  {
    slug: 'weapons',
    label: 'Weapons',
    title: 'Ship Weapons',
    itemType: 'WeaponGun',
    defaultSort: 'dps',
    dropdowns: [
      { label: 'Type',      allLabel: 'All Types',      value: i => weaponTypeOf(i) },
      { label: 'Ammo Type', allLabel: 'All Ammo Types', value: i => ammoTypeOf(i) },
    ],
    columns: [
      { label: 'Name',         field: 'name',         sortable: true },
      { label: 'Manufacturer', field: 'manufacturer', sortable: true },
      { label: 'Size',         field: 'size',         sortable: true, align: 'right' },
      { label: 'Class',        field: '_wtype',          value: i => weaponTypeOf(i) },
      { label: 'Ammo Type',    field: '_ammo',           value: i => ammoTypeOf(i) },
      { label: 'DPS',          field: 'dps',             sortable: true, align: 'right', decimals: 0 },
      { label: 'Alpha',        field: 'alphaDamage',     sortable: true, align: 'right', decimals: 0 },
      { label: 'RPM',          field: 'fireRate',        sortable: true, align: 'right', decimals: 0 },
      { label: 'Range',        field: 'range',           sortable: true, align: 'right', decimals: 0, unit: 'm' },
      { label: 'Speed',        field: 'projectileSpeed', sortable: true, align: 'right', decimals: 0, unit: ' m/s' },
      { label: 'Ammo',         field: 'ammoCount',       sortable: true, align: 'right', decimals: 0 },
      { label: 'Pwr Draw',     field: 'powerDraw',       sortable: true, align: 'right', decimals: 1 },
    ],
  },
  {
    slug: 'shields',
    label: 'Shields',
    title: 'Shields',
    itemType: 'Shield',
    defaultSort: 'hp',
    dropdowns: COMPONENT_DROPDOWNS,
    columns: [
      ...COMMON_COLS,
      { label: 'HP',          field: 'hp',                sortable: true, align: 'right', decimals: 0 },
      { label: 'Regen/s',     field: 'regenRate',         sortable: true, align: 'right', decimals: 0 },
      { label: 'Dmg Delay',   field: 'damagedRegenDelay', sortable: true, align: 'right', decimals: 1, unit: 's' },
      { label: 'Down Delay',  field: 'downedRegenDelay',  sortable: true, align: 'right', decimals: 1, unit: 's' },
      { label: 'Phys Resist', field: 'resistPhysMax',     sortable: true, align: 'right', percent: true },
      { label: 'Enrg Resist', field: 'resistEnrgMax',     sortable: true, align: 'right', percent: true },
      { label: 'Dist Resist', field: 'resistDistMax',     sortable: true, align: 'right', percent: true },
      { label: 'Component HP',field: 'componentHp',       sortable: true, align: 'right', decimals: 0 },
    ],
  },
  {
    slug: 'coolers',
    label: 'Coolers',
    title: 'Coolers',
    itemType: 'Cooler',
    defaultSort: 'coolingRate',
    dropdowns: COMPONENT_DROPDOWNS,
    columns: [
      ...COMMON_COLS,
      { label: 'Cooling',      field: 'coolingRate',  sortable: true, align: 'right', decimals: 1 },
      { label: 'Power Draw',   field: 'powerDraw',    sortable: true, align: 'right', decimals: 1 },
      { label: 'IR Sig',       field: 'irSignature',  sortable: true, align: 'right', decimals: 0 },
      { label: 'EM Max',       field: 'emMax',        sortable: true, align: 'right', decimals: 0 },
      { label: 'Component HP', field: 'componentHp',  sortable: true, align: 'right', decimals: 0 },
      { label: 'Class',        field: 'itemClass' },
    ],
  },
  {
    slug: 'power-plants',
    label: 'Power Plants',
    title: 'Power Plants',
    itemType: 'PowerPlant',
    defaultSort: 'powerOutput',
    dropdowns: COMPONENT_DROPDOWNS,
    columns: [
      ...COMMON_COLS,
      { label: 'Power Out',    field: 'powerOutput',        sortable: true, align: 'right', decimals: 0 },
      { label: 'EM Sig',       field: 'emSignature',        sortable: true, align: 'right', decimals: 0 },
      { label: 'EM Max',       field: 'emMax',              sortable: true, align: 'right', decimals: 0 },
      { label: 'Dist Max',     field: 'distortionMax',      sortable: true, align: 'right', decimals: 0 },
      { label: 'Misfire',      field: 'misfireCountdown',   sortable: true, align: 'right', decimals: 1, unit: 's' },
      { label: 'Component HP', field: 'componentHp',        sortable: true, align: 'right', decimals: 0 },
      { label: 'Class',        field: 'itemClass' },
    ],
  },
  {
    slug: 'quantum-drives',
    label: 'Quantum Drives',
    title: 'Quantum Drives',
    itemType: 'QuantumDrive',
    defaultSort: 'speed',
    dropdowns: COMPONENT_DROPDOWNS,
    columns: [
      ...COMMON_COLS,
      { label: 'Speed',        field: 'speed',         sortable: true, align: 'right', decimals: 0, unit: ' m/s' },
      { label: 'Spool',        field: 'spoolTime',     sortable: true, align: 'right', decimals: 1, unit: 's' },
      { label: 'Cooldown',     field: 'cooldownTime',  sortable: true, align: 'right', decimals: 1, unit: 's' },
      { label: 'Fuel Rate',    field: 'fuelRate',      sortable: true, align: 'right', decimals: 3 },
      { label: 'Stage 1 Accel',field: 'stageOneAccel', sortable: true, align: 'right', decimals: 0 },
      { label: 'Stage 2 Accel',field: 'stageTwoAccel', sortable: true, align: 'right', decimals: 0 },
      { label: 'HP',           field: 'hp',            sortable: true, align: 'right', decimals: 0 },
    ],
  },
  {
    slug: 'mining-lasers',
    label: 'Mining Lasers',
    title: 'Mining Lasers',
    itemType: 'WeaponMining',
    defaultSort: 'miningMaxPower',
    dropdowns: [
      { label: 'Class', allLabel: 'All Classes', value: i => i.itemClass },
      { label: 'Grade', allLabel: 'All Grades',  value: i => i.grade },
    ],
    columns: [
      { label: 'Name',         field: 'name',                 sortable: true },
      { label: 'Manufacturer', field: 'manufacturer',         sortable: true },
      { label: 'Grade',        field: 'grade',                sortable: true },
      { label: 'Size',         field: 'size',                 sortable: true, align: 'right' },
      { label: 'Power',        field: 'miningMaxPower',       sortable: true, align: 'right', decimals: 0 },
      { label: 'Instability',  field: 'miningInstability',    sortable: true, align: 'right', value: i => fmtMod(i.miningInstability) },
      { label: 'Charge Zone',  field: 'miningOptimalWindow',  sortable: true, align: 'right', value: i => fmtMod(i.miningOptimalWindow) },
      { label: 'Resistance',   field: 'miningResistance',     sortable: true, align: 'right', value: i => fmtMod(i.miningResistance) },
      { label: 'Inert Mat',    field: 'miningInertMaterials', sortable: true, align: 'right', value: i => fmtMod(i.miningInertMaterials) },
      { label: 'Opt Range',    field: 'optimalRange',         sortable: true, align: 'right', decimals: 0, unit: 'm' },
      { label: 'Modules',      field: 'moduleSlots',          sortable: true, align: 'right', decimals: 0 },
    ],
  },
  {
    slug: 'salvage',
    label: 'Salvage',
    title: 'Salvage Modules',
    itemType: 'SalvageModifier',
    defaultSort: 'salvageSpeed',
    dropdowns: [],
    columns: [
      { label: 'Name',         field: 'name',               sortable: true },
      { label: 'Manufacturer', field: 'manufacturer',       sortable: true },
      { label: 'Size',         field: 'size',               sortable: true, align: 'right' },
      { label: 'Speed',        field: 'salvageSpeed',       sortable: true, align: 'right', decimals: 2 },
      { label: 'Radius',       field: 'salvageRadius',      sortable: true, align: 'right', decimals: 1, unit: 'm' },
      { label: 'Efficiency',   field: 'salvageEfficiency',  sortable: true, align: 'right', percent: true },
    ],
  },
  {
    slug: 'mining-modules',
    label: 'Mining Modules',
    title: 'Mining Modules',
    itemType: 'MiningModifier',
    defaultSort: 'name',
    dropdowns: [
      { label: 'Type', allLabel: 'All Types', value: i => moduleTypeOf(i) },
    ],
    columns: [
      { label: 'Name',         field: 'name',                 sortable: true },
      { label: 'Manufacturer', field: 'manufacturer',         sortable: true },
      { label: 'Size',         field: 'size',                 sortable: true, align: 'right' },
      { label: 'Type',         field: '_mtype',               value: i => moduleTypeOf(i) },
      { label: 'Charges',      field: 'charges',              sortable: true, align: 'right', decimals: 0 },
      { label: 'Instability',  field: 'miningInstability',    sortable: true, align: 'right', value: i => fmtMod(i.miningInstability) },
      { label: 'Window',       field: 'miningOptimalWindow',  sortable: true, align: 'right', value: i => fmtMod(i.miningOptimalWindow) },
      { label: 'Rate',         field: 'miningOptimalRate',    sortable: true, align: 'right', value: i => fmtMod(i.miningOptimalRate) },
      { label: 'Resist',       field: 'miningResistance',     sortable: true, align: 'right', value: i => fmtMod(i.miningResistance) },
      { label: 'Shatter',      field: 'miningShatterDamage',  sortable: true, align: 'right', value: i => fmtMod(i.miningShatterDamage) },
      { label: 'Inert Mat',    field: 'miningInertMaterials', sortable: true, align: 'right', value: i => fmtMod(i.miningInertMaterials) },
      { label: 'Overcharge',   field: 'miningOvercharge',     sortable: true, align: 'right', value: i => fmtMod(i.miningOvercharge) },
      { label: 'Power',        field: 'miningPowerMult',      sortable: true, align: 'right', value: i => fmtMultPct(i.miningPowerMult) },
    ],
  },
];

const DEFAULT_SLUG = SHIP_ITEM_CATEGORIES[0].slug;

@Component({
  selector: 'app-ship-items-database',
  standalone: true,
  imports: [ShipItemDbComponent],
  templateUrl: './ship-items-database.html',
  styleUrl: './ship-items-database.scss',
})
export class ShipItemsDatabaseComponent {
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  /** Reactive query-param read so back/forward + deep-links Just Work. */
  private readonly queryParams = toSignal(this.route.queryParamMap, {
    initialValue: this.route.snapshot.queryParamMap,
  });

  readonly categories = SHIP_ITEM_CATEGORIES;

  /** Active category — falls back to the first slug if `?cat=` is missing
   *  or doesn't match any defined slug. */
  readonly active = computed<ShipItemCategory>(() => {
    const slug = this.queryParams().get('cat') ?? DEFAULT_SLUG;
    return SHIP_ITEM_CATEGORIES.find(c => c.slug === slug) ?? SHIP_ITEM_CATEGORIES[0];
  });

  selectCategory(slug: string): void {
    if (slug === this.active().slug) return;
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { cat: slug },
      queryParamsHandling: 'merge',
    });
  }

  isActive(slug: string): boolean {
    return this.active().slug === slug;
  }
}
