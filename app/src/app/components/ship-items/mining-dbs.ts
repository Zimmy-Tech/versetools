import { Component } from '@angular/core';
import { ShipItemDbComponent, ItemColumn, DropdownFilter } from './ship-item-db';
import { Item } from '../../models/db.models';

/** Signed-percent formatter matching the main picker's `fmtMod`:
 *  `null/undefined` → em-dash, otherwise `+N%` for positive and `-N%` for
 *  negative. Used on every mining modifier column. */
function fmtMod(v: number | null | undefined): string {
  if (v == null) return '\u2014';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v}%`;
}

/** Convert a multiplier field (e.g., `miningPowerMult = 1.2`) into the
 *  `+20%` delta the picker surfaces. */
function fmtMultPct(m: number | null | undefined): string {
  if (m == null) return '\u2014';
  const pct = Math.round((m - 1) * 100);
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct}%`;
}

const HOST_STYLE = `:host { display: flex; flex: 1; overflow: hidden; }`;

// ── Mining Lasers ────────────────────────────────────────

@Component({
  selector: 'app-mining-lasers-db',
  standalone: true,
  imports: [ShipItemDbComponent],
  styles: [HOST_STYLE],
  template: `<app-ship-item-db
    title="Mining Lasers"
    itemType="WeaponMining"
    [columns]="cols"
    [dropdownFilters]="dropdowns"
    defaultSort="miningMaxPower" />`,
})
export class MiningLasersDbComponent {
  readonly dropdowns: DropdownFilter[] = [
    { label: 'Class', allLabel: 'All Classes', value: i => i.itemClass },
    { label: 'Grade', allLabel: 'All Grades',  value: i => i.grade },
  ];

  readonly cols: ItemColumn[] = [
    { label: 'Name',         field: 'name',         sortable: true },
    { label: 'Manufacturer', field: 'manufacturer', sortable: true },
    { label: 'Grade',        field: 'grade',        sortable: true },
    { label: 'Size',         field: 'size',         sortable: true, align: 'right' },
    { label: 'Power',        field: 'miningMaxPower',     sortable: true, align: 'right', decimals: 0 },
    { label: 'Instability',  field: 'miningInstability',  sortable: true, align: 'right', value: i => fmtMod(i.miningInstability) },
    { label: 'Charge Zone',  field: 'miningOptimalWindow',sortable: true, align: 'right', value: i => fmtMod(i.miningOptimalWindow) },
    { label: 'Resistance',   field: 'miningResistance',   sortable: true, align: 'right', value: i => fmtMod(i.miningResistance) },
    { label: 'Inert Mat',    field: 'miningInertMaterials', sortable: true, align: 'right', value: i => fmtMod(i.miningInertMaterials) },
    { label: 'Opt Range',    field: 'optimalRange',       sortable: true, align: 'right', decimals: 0, unit: 'm' },
    { label: 'Modules',      field: 'moduleSlots',        sortable: true, align: 'right', decimals: 0 },
  ];
}

// ── Mining Modules ──────────────────────────────────────

/** Type value shown in the Type column + driving the dropdown filter.
 *  Falls back to em-dash when CIG hasn't tagged the module. */
function moduleTypeOf(i: Item): string {
  const st = (i.subType ?? '').toLowerCase();
  if (st === 'active') return 'Active';
  if (st === 'passive') return 'Passive';
  return '\u2014';
}

@Component({
  selector: 'app-mining-modules-db',
  standalone: true,
  imports: [ShipItemDbComponent],
  styles: [HOST_STYLE],
  template: `<app-ship-item-db
    title="Mining Modules"
    itemType="MiningModifier"
    [columns]="cols"
    [dropdownFilters]="dropdowns"
    defaultSort="name" />`,
})
export class MiningModulesDbComponent {
  readonly dropdowns: DropdownFilter[] = [
    { label: 'Type', allLabel: 'All Types', value: i => moduleTypeOf(i) },
  ];

  readonly cols: ItemColumn[] = [
    { label: 'Name',         field: 'name',         sortable: true },
    { label: 'Manufacturer', field: 'manufacturer', sortable: true },
    { label: 'Size',         field: 'size',         sortable: true, align: 'right' },
    { label: 'Type',         field: '_mtype',       value: i => moduleTypeOf(i) },
    { label: 'Charges',      field: 'charges',       sortable: true, align: 'right', decimals: 0 },
    { label: 'Instability',  field: 'miningInstability',    sortable: true, align: 'right', value: i => fmtMod(i.miningInstability) },
    { label: 'Window',       field: 'miningOptimalWindow',  sortable: true, align: 'right', value: i => fmtMod(i.miningOptimalWindow) },
    { label: 'Rate',         field: 'miningOptimalRate',    sortable: true, align: 'right', value: i => fmtMod(i.miningOptimalRate) },
    { label: 'Resist',       field: 'miningResistance',     sortable: true, align: 'right', value: i => fmtMod(i.miningResistance) },
    { label: 'Shatter',      field: 'miningShatterDamage',  sortable: true, align: 'right', value: i => fmtMod(i.miningShatterDamage) },
    { label: 'Inert Mat',    field: 'miningInertMaterials', sortable: true, align: 'right', value: i => fmtMod(i.miningInertMaterials) },
    { label: 'Overcharge',   field: 'miningOvercharge',     sortable: true, align: 'right', value: i => fmtMod(i.miningOvercharge) },
    { label: 'Power',        field: 'miningPowerMult',      sortable: true, align: 'right', value: i => fmtMultPct(i.miningPowerMult) },
  ];
}
