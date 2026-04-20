import { Component } from '@angular/core';
import { ShipItemDbComponent, ItemColumn } from './ship-item-db';
import { Item } from '../../models/db.models';

/** Shared column prefix — every ship-item table starts with these. */
const COMMON_COLS: ItemColumn[] = [
  { label: 'Name',         field: 'name',         sortable: true },
  { label: 'Manufacturer', field: 'manufacturer', sortable: true },
  { label: 'Grade',        field: 'grade',        sortable: true },
  { label: 'Size',         field: 'size',         sortable: true, align: 'right' },
];

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
    defaultSort="hp" />`,
})
export class ShipShieldsComponent {
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
    defaultSort="coolingRate" />`,
})
export class ShipCoolersComponent {
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
    [subTypeFilters]="subTypes"
    defaultSort="dps" />`,
})
export class ShipWeaponsDbComponent {
  readonly subTypes = [
    { label: 'Ballistic', test: (i: Item) => i.isBallistic === true },
    { label: 'Energy',    test: (i: Item) => i.isBallistic !== true },
  ];

  readonly cols: ItemColumn[] = [
    ...COMMON_COLS,
    { label: 'Type',    field: '_type', value: i => i.isBallistic ? 'Ballistic' : 'Energy' },
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
    defaultSort="powerOutput" />`,
})
export class ShipPowerPlantsComponent {
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
    defaultSort="speed" />`,
})
export class ShipQuantumDrivesComponent {
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
