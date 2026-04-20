import { Component } from '@angular/core';
import { ShipItemDbComponent, ItemColumn, DropdownFilter } from './ship-item-db';
import { Item } from '../../models/db.models';

/** Shared column prefix — every ship-item table starts with these. */
const COMMON_COLS: ItemColumn[] = [
  { label: 'Name',         field: 'name',         sortable: true },
  { label: 'Manufacturer', field: 'manufacturer', sortable: true },
  { label: 'Grade',        field: 'grade',        sortable: true },
  { label: 'Size',         field: 'size',         sortable: true, align: 'right' },
];

/** Dropdown filters for component pages (Shields / Coolers / Power / Quantum).
 *  Class and Grade both read directly off item fields. */
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

/** Ammo type derived from damage profile. Distortion weapons carry
 *  damage.distortion > 0; remaining weapons split Ballistic vs Energy
 *  by the isBallistic flag. */
function ammoTypeOf(i: Item): string {
  if ((i.damage?.distortion ?? 0) > 0) return 'Distortion';
  return i.isBallistic ? 'Ballistic' : 'Energy';
}

// ── Shields ──────────────────────────────────────────────────

const HOST_STYLE = `:host { display: flex; flex: 1; overflow: hidden; }`;

@Component({
  selector: 'app-ship-shields',
  standalone: true,
  imports: [ShipItemDbComponent],
  styles: [HOST_STYLE],
  template: `<app-ship-item-db
    title="Shields"
    itemType="Shield"
    [columns]="cols"
    [dropdownFilters]="dropdowns"
    defaultSort="hp" />`,
})
export class ShipShieldsComponent {
  readonly dropdowns = COMPONENT_DROPDOWNS;
  readonly cols: ItemColumn[] = [
    ...COMMON_COLS,
    { label: 'HP',          field: 'hp',                sortable: true, align: 'right', decimals: 0 },
    { label: 'Regen/s',     field: 'regenRate',         sortable: true, align: 'right', decimals: 0 },
    { label: 'Dmg Delay',   field: 'damagedRegenDelay', sortable: true, align: 'right', decimals: 1, unit: 's' },
    { label: 'Down Delay',  field: 'downedRegenDelay',  sortable: true, align: 'right', decimals: 1, unit: 's' },
    { label: 'Phys Resist', field: 'resistPhysMax',     sortable: true, align: 'right', percent: true },
    { label: 'Enrg Resist', field: 'resistEnrgMax',     sortable: true, align: 'right', percent: true },
    { label: 'Dist Resist', field: 'resistDistMax',     sortable: true, align: 'right', percent: true },
    { label: 'Component HP',field: 'componentHp',       sortable: true, align: 'right', decimals: 0 },
  ];
}

// ── Coolers ──────────────────────────────────────────────────

@Component({
  selector: 'app-ship-coolers',
  standalone: true,
  imports: [ShipItemDbComponent],
  styles: [HOST_STYLE],
  template: `<app-ship-item-db
    title="Coolers"
    itemType="Cooler"
    [columns]="cols"
    [dropdownFilters]="dropdowns"
    defaultSort="coolingRate" />`,
})
export class ShipCoolersComponent {
  readonly dropdowns = COMPONENT_DROPDOWNS;
  readonly cols: ItemColumn[] = [
    ...COMMON_COLS,
    { label: 'Cooling',      field: 'coolingRate',  sortable: true, align: 'right', decimals: 1 },
    { label: 'Power Draw',   field: 'powerDraw',    sortable: true, align: 'right', decimals: 1 },
    { label: 'IR Sig',       field: 'irSignature',  sortable: true, align: 'right', decimals: 0 },
    { label: 'EM Max',       field: 'emMax',        sortable: true, align: 'right', decimals: 0 },
    { label: 'Component HP', field: 'componentHp',  sortable: true, align: 'right', decimals: 0 },
    { label: 'Class',        field: 'itemClass' },
  ];
}

// ── Ship Weapons ─────────────────────────────────────────────

@Component({
  selector: 'app-ship-weapons-db',
  standalone: true,
  imports: [ShipItemDbComponent],
  styles: [HOST_STYLE],
  template: `<app-ship-item-db
    title="Ship Weapons"
    itemType="WeaponGun"
    [columns]="cols"
    [dropdownFilters]="dropdowns"
    defaultSort="dps" />`,
})
export class ShipWeaponsDbComponent {
  /** Two dropdowns — Type (Cannon / Repeater / …) and Ammo Type
   *  (Ballistic / Energy / Distortion). Class and Grade don't apply to
   *  SC weapons (they're all Grade 1). */
  readonly dropdowns: DropdownFilter[] = [
    { label: 'Type',      allLabel: 'All Types',      value: i => weaponTypeOf(i) },
    { label: 'Ammo Type', allLabel: 'All Ammo Types', value: i => ammoTypeOf(i) },
  ];

  /** Grade column dropped — all SC weapons are Grade 1, so it's dead space. */
  readonly cols: ItemColumn[] = [
    { label: 'Name',         field: 'name',         sortable: true },
    { label: 'Manufacturer', field: 'manufacturer', sortable: true },
    { label: 'Size',         field: 'size',         sortable: true, align: 'right' },
    { label: 'Class',   field: '_wtype', value: i => weaponTypeOf(i) },
    { label: 'Ammo Type', field: '_ammo', value: i => ammoTypeOf(i) },
    { label: 'DPS',     field: 'dps',             sortable: true, align: 'right', decimals: 0 },
    { label: 'Alpha',   field: 'alphaDamage',     sortable: true, align: 'right', decimals: 0 },
    { label: 'RPM',     field: 'fireRate',        sortable: true, align: 'right', decimals: 0 },
    { label: 'Range',   field: 'range',           sortable: true, align: 'right', decimals: 0, unit: 'm' },
    { label: 'Speed',   field: 'projectileSpeed', sortable: true, align: 'right', decimals: 0, unit: ' m/s' },
    { label: 'Ammo',    field: 'ammoCount',       sortable: true, align: 'right', decimals: 0 },
    { label: 'Pwr Draw',field: 'powerDraw',       sortable: true, align: 'right', decimals: 1 },
  ];
}

// ── Power Plants ─────────────────────────────────────────────

@Component({
  selector: 'app-ship-power-plants',
  standalone: true,
  imports: [ShipItemDbComponent],
  styles: [HOST_STYLE],
  template: `<app-ship-item-db
    title="Power Plants"
    itemType="PowerPlant"
    [columns]="cols"
    [dropdownFilters]="dropdowns"
    defaultSort="powerOutput" />`,
})
export class ShipPowerPlantsComponent {
  readonly dropdowns = COMPONENT_DROPDOWNS;
  readonly cols: ItemColumn[] = [
    ...COMMON_COLS,
    { label: 'Power Out',    field: 'powerOutput',        sortable: true, align: 'right', decimals: 0 },
    { label: 'EM Sig',       field: 'emSignature',        sortable: true, align: 'right', decimals: 0 },
    { label: 'EM Max',       field: 'emMax',              sortable: true, align: 'right', decimals: 0 },
    { label: 'Dist Max',     field: 'distortionMax',      sortable: true, align: 'right', decimals: 0 },
    { label: 'Misfire',      field: 'misfireCountdown',   sortable: true, align: 'right', decimals: 1, unit: 's' },
    { label: 'Component HP', field: 'componentHp',        sortable: true, align: 'right', decimals: 0 },
    { label: 'Class',        field: 'itemClass' },
  ];
}

// ── Quantum Drives ───────────────────────────────────────────

@Component({
  selector: 'app-ship-quantum-drives',
  standalone: true,
  imports: [ShipItemDbComponent],
  styles: [HOST_STYLE],
  template: `<app-ship-item-db
    title="Quantum Drives"
    itemType="QuantumDrive"
    [columns]="cols"
    [dropdownFilters]="dropdowns"
    defaultSort="speed" />`,
})
export class ShipQuantumDrivesComponent {
  readonly dropdowns = COMPONENT_DROPDOWNS;
  readonly cols: ItemColumn[] = [
    ...COMMON_COLS,
    { label: 'Speed',       field: 'speed',         sortable: true, align: 'right', decimals: 0, unit: ' m/s' },
    { label: 'Spool',       field: 'spoolTime',     sortable: true, align: 'right', decimals: 1, unit: 's' },
    { label: 'Cooldown',    field: 'cooldownTime',  sortable: true, align: 'right', decimals: 1, unit: 's' },
    { label: 'Fuel Rate',   field: 'fuelRate',      sortable: true, align: 'right', decimals: 3 },
    { label: 'Stage 1 Accel',field: 'stageOneAccel',sortable: true, align: 'right', decimals: 0 },
    { label: 'Stage 2 Accel',field: 'stageTwoAccel',sortable: true, align: 'right', decimals: 0 },
    { label: 'HP',          field: 'hp',            sortable: true, align: 'right', decimals: 0 },
  ];
}
