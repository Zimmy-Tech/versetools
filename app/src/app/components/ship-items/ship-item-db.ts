import { Component, signal, computed, input } from '@angular/core';
import { DataService } from '../../services/data.service';
import { Item, Ship } from '../../models/db.models';

/** A configurable dropdown filter. Each wrapper page passes in the set of
 *  dropdowns it wants (e.g. shields want Class + Grade; weapons want Type).
 *  Distinct option values are harvested from the current item set via the
 *  `value` accessor. */
export interface DropdownFilter {
  label: string;                 // Header text, e.g. "Type", "Class"
  allLabel: string;              // Empty-option text, e.g. "All Types"
  value: (item: Item) => string | null | undefined;
}

/** Column descriptor for the generic ship-item database table. */
export interface ItemColumn {
  /** Column header text shown to users. */
  label: string;
  /** Key on the Item object, or a synthetic id used when `value` is supplied. */
  field: string;
  /** Clickable header that toggles sort on this field. */
  sortable?: boolean;
  /** Right-align numeric columns. */
  align?: 'left' | 'right';
  /** Suffix appended after the formatted value (e.g. ' m/s', 's'). */
  unit?: string;
  /** Decimals for numeric formatting. Ignored for non-numeric values. */
  decimals?: number;
  /** Multiply numeric value by 100 + append '%'. Used for 0..1 fraction fields. */
  percent?: boolean;
  /** Custom accessor when the value isn't a direct field lookup. */
  value?: (item: Item) => string | number | null | undefined;
  /** Extra class applied to the td (already includes col-num for right-aligned). */
  className?: string;
}

@Component({
  selector: 'app-ship-item-db',
  standalone: true,
  templateUrl: './ship-item-db.html',
  styleUrl: './ship-item-db.scss',
})
export class ShipItemDbComponent {
  /** Signal inputs so the filter computeds re-track when the parent
   *  rebinds (e.g., the consolidated Ship Items DB tab strip swaps the
   *  config when the user picks a different category). Classic @Input()
   *  is not signal-tracked, so dependent computeds would never re-run. */
  title = input('');
  /** Matches against Item.type — set to 'Shield', 'Cooler', 'WeaponGun', etc. */
  itemType = input('');
  /** Optional secondary filter for WeaponGun (Ballistic vs Energy). Label =
   *  dropdown prompt, predicate picks the rows. Pass multiple for a multi-group. */
  subTypeFilters = input<{ label: string; test: (i: Item) => boolean }[]>([]);
  /** Extra dropdown filters (Class / Grade / Type / ...). Each has a label,
   *  an all-option text, and a value accessor. The component harvests the
   *  distinct values from the unfiltered item set and renders options. */
  dropdownFilters = input<DropdownFilter[]>([]);
  columns = input<ItemColumn[]>([]);
  /** Fields checked by the text search input. Defaults to name + manufacturer. */
  searchFields = input<string[]>(['name', 'manufacturer']);
  /** Initial sort column. */
  defaultSort = input('name');

  searchQuery = signal('');
  subTypeFilter = signal(''); // label of active subType filter or ''
  sizeFilter = signal<number | null>(null);  // null = all sizes
  /** Dropdown filter state keyed by the filter's label. Empty string = no filter. */
  dropdownValues = signal<Record<string, string>>({});
  sortField = signal('');
  sortDir = signal<'asc' | 'desc'>('asc');

  /** Item whose "ships defaulting this" modal is open. Null = modal closed. */
  selectedItem = signal<Item | null>(null);

  constructor(public data: DataService) {}

  /** Ships that default-equip the currently-selected item. Derived signal so
   *  the modal re-reads when ships data changes. */
  readonly selectedItemShips = computed<{ ship: Ship; slotIds: string[] }[]>(() => {
    const item = this.selectedItem();
    if (!item) return [];
    return this.data.getShipsWithDefaultItem(item.className);
  });

  openItemModal(item: Item): void { this.selectedItem.set(item); }
  closeItemModal(): void { this.selectedItem.set(null); }

  private currentSort = computed(() => this.sortField() || this.defaultSort());

  /** Page-local blocklist for phantom variants that CIG left in the game data
   *  but are never player-equippable. These database pages are meant to show
   *  only "real" things a player can actually fit. The underlying
   *  data.items() is untouched so pickers and loadouts keep full visibility.
   *
   *  Categories filtered:
   *  - LOD render copies (`_lowpoly`)
   *  - Dev collision dummies (`_dummy`)
   *  - Size-coded placeholders (`_template` — "S1 Shield", "S2 Cooler", etc.)
   *  - NPC station/event variants (`_securitynetwork`, `_collector`, `_atls`)
   *  - Weapon-only phantom suffixes (`_turret`, `_idris_m`, `_pdc*`)
   *  - Name-level placeholders like `<= PLACEHOLDER =>` and `[Title]` */
  private static readonly SKIP_SUFFIXES_ANY = [
    '_lowpoly', '_dummy', '_template',
    '_securitynetwork', '_securitynetwork_weak',
    '_collector', '_atls',
  ];
  private static readonly SKIP_SUFFIXES_WEAPON = ['_turret', '_idris_m'];
  private static readonly SKIP_SUBSTRINGS_WEAPON = ['_pdc'];
  private static readonly SKIP_EXACT = new Set([
    'anvl_ballisticgatling_bespoke',
    'bengal_ballisticgatling_s6',
    'brra_lasercannon_ap_automatedturret',
    'banu_energyrepeater_s2',
    // Capital-ship NPC weapons that CIG mis-labeled with pilot-weapon loc keys.
    // Not equippable by players — drop from the ship weapons DB page:
    'behr_lasercannon_s8',              // "M9A" name, Idris-only S8 laser
    'behr_lasercannon_s9',              // "M9A" name, Idris-only S9 laser
    'behr_javelinballisticcannon_s7',   // "M9A" name, Javelin ballistic
    'behr_massdriver_s12',              // "M9A" name, Javelin spinal MD
    'bengal_ballisticcannon_s8',        // "Tarantula", Bengal-only S8
    'bengal_ballisticcannon_s7',        // "Tarantula", Bengal-only S7
    'bengal_turret_ballisticcannon_s8', // "Slayer", Bengal-only turret variant
    'behr_laserrepeater_s10',           // "GVSR", S10 145k-DPS capital variant
    'amrs_aagun_cc_s3',                 // "PyroBurst", AA 35-DPS variant
    // TODO: revisit. Vanduul 'WRATH' Cannon has two generations with identical
    // stats except componentHp (gen1: 1050, gen2: 5500). Currently hiding gen2
    // since we don't surface componentHp anywhere and 3 ships use gen1 vs 1
    // using gen2. When component HP becomes a visible stat, un-hide gen2 and
    // let the column show the difference. See memory project_wrath_cannon_gen2.
    'vncl_gen2_plasmacannon_s5',
    // Two "Jericho XL" rocket pods in the data, differ only by tube count /
    // manufacturer. Keeping the Hurston 18-tube version as the canonical one.
    'rpod_s3_fski_9x_s3',               // FireStryke 9-tube, hidden in favor of HRST
  ]);
  private static readonly PLACEHOLDER_NAME_RX = /^\s*(<=|\[)/;

  private shouldHide(item: Item): boolean {
    const cn = (item.className ?? '').toLowerCase();
    if (ShipItemDbComponent.SKIP_EXACT.has(cn)) return true;
    if (ShipItemDbComponent.SKIP_SUFFIXES_ANY.some(s => cn.endsWith(s))) return true;
    if (item.type === 'WeaponGun') {
      if (ShipItemDbComponent.SKIP_SUFFIXES_WEAPON.some(s => cn.endsWith(s))) return true;
      if (ShipItemDbComponent.SKIP_SUBSTRINGS_WEAPON.some(s => cn.includes(s))) return true;
    }
    if (ShipItemDbComponent.PLACEHOLDER_NAME_RX.test(item.name ?? '')) return true;
    // Only the four power-ladder components use letter grades (A–D); for
    // those, a numeric grade is a capital-ship bespoke or placeholder that
    // slipped past the suffix blocklist. Other item types (WeaponMining,
    // MiningModifier, etc.) legitimately carry numeric grades (e.g. all
    // mining lasers are Grade 1), so this check must be type-scoped.
    if (ShipItemDbComponent.LETTER_GRADE_TYPES.has(item.type) &&
        /^\d+$/.test(String(item.grade ?? ''))) return true;
    return false;
  }

  private static readonly LETTER_GRADE_TYPES = new Set([
    'Shield', 'Cooler', 'PowerPlant', 'QuantumDrive',
  ]);

  readonly items = computed<Item[]>(() =>
    this.data.items().filter(i => i.type === this.itemType() && !this.shouldHide(i))
  );

  /** Distinct sizes present in the unfiltered item set, sorted ascending.
   *  Used to render the size button row — we only show sizes that actually
   *  exist for this item type. */
  readonly availableSizes = computed<number[]>(() => {
    const sizes = new Set<number>();
    for (const i of this.items()) {
      if (typeof i.size === 'number') sizes.add(i.size);
    }
    return Array.from(sizes).sort((a, b) => a - b);
  });

  /** Distinct values for each configured dropdown filter, in sorted order. */
  dropdownOptions(filter: DropdownFilter): string[] {
    const values = new Set<string>();
    for (const i of this.items()) {
      const v = filter.value(i);
      if (v != null && v !== '') values.add(String(v));
    }
    return Array.from(values).sort();
  }

  setSizeFilter(size: number | null): void {
    this.sizeFilter.set(this.sizeFilter() === size ? null : size);
  }

  onSizeFilterChange(value: string): void {
    this.sizeFilter.set(value === '' ? null : Number(value));
  }

  setDropdownValue(label: string, value: string): void {
    this.dropdownValues.update(m => ({ ...m, [label]: value }));
  }

  /** True when any filter narrows the list — used to show/hide the Clear
   *  Filters button. Sort state is excluded; it's a view preference, not a
   *  filter. */
  readonly hasActiveFilter = computed(() => {
    if (this.searchQuery().trim()) return true;
    if (this.subTypeFilter()) return true;
    if (this.sizeFilter() !== null) return true;
    const vals = this.dropdownValues();
    return Object.values(vals).some(v => !!v);
  });

  /** Reset every filter to its default. Keeps sort field/direction so the
   *  user's column preference survives a reset. */
  clearFilters(): void {
    this.searchQuery.set('');
    this.subTypeFilter.set('');
    this.sizeFilter.set(null);
    this.dropdownValues.set({});
  }

  readonly filtered = computed(() => {
    let list = this.items();
    const q = this.searchQuery().toLowerCase().trim();
    if (q) {
      list = list.filter(i =>
        this.searchFields().some(f => {
          const v = (i as any)[f];
          return v != null && String(v).toLowerCase().includes(q);
        })
      );
    }
    const sub = this.subTypeFilter();
    if (sub) {
      const match = this.subTypeFilters().find(f => f.label === sub);
      if (match) list = list.filter(match.test);
    }
    const size = this.sizeFilter();
    if (size !== null) {
      list = list.filter(i => i.size === size);
    }
    const dropVals = this.dropdownValues();
    for (const filter of this.dropdownFilters()) {
      const selected = dropVals[filter.label];
      if (selected) {
        list = list.filter(i => {
          const v = filter.value(i);
          return v != null && String(v) === selected;
        });
      }
    }

    const field = this.currentSort();
    const dir = this.sortDir();
    const sign = dir === 'asc' ? 1 : -1;
    const col = this.columns().find(c => c.field === field);
    return [...list].sort((a, b) => {
      const av = this.rawValue(a, col, field);
      const bv = this.rawValue(b, col, field);
      if (typeof av === 'number' && typeof bv === 'number') {
        return (av - bv) * sign;
      }
      return String(av ?? '').localeCompare(String(bv ?? '')) * sign;
    });
  });

  private rawValue(item: Item, col: ItemColumn | undefined, field: string): any {
    if (col?.value) return col.value(item);
    return (item as any)[field];
  }

  formatted(item: Item, col: ItemColumn): string {
    const raw = this.rawValue(item, col, col.field);
    if (raw == null || raw === '') return '\u2014';
    let v: number | string = raw as any;
    if (col.percent && typeof v === 'number') v = (v * 100).toFixed(col.decimals ?? 0) + '%';
    else if (typeof v === 'number' && col.decimals != null) v = v.toFixed(col.decimals);
    else if (typeof v === 'number') v = v.toLocaleString('en-US', { maximumFractionDigits: 1 });
    return v + (col.unit ?? '');
  }

  toggleSort(col: ItemColumn): void {
    if (!col.sortable) return;
    if (this.sortField() === col.field) {
      this.sortDir.set(this.sortDir() === 'desc' ? 'asc' : 'desc');
    } else {
      this.sortField.set(col.field);
      // Numeric-leaning sort: start descending so the "best" row is up top.
      this.sortDir.set(col.field === 'name' ? 'asc' : 'desc');
    }
  }

  sortIndicator(col: ItemColumn): string {
    if (!col.sortable || this.currentSort() !== col.field) return '';
    return this.sortDir() === 'desc' ? ' \u25BE' : ' \u25B4';
  }

  /** Align class for a td. */
  tdClass(col: ItemColumn, firstCol: boolean): string {
    const parts: string[] = [];
    if (firstCol) parts.push('col-name');
    if (col.align === 'right') parts.push('col-num');
    if (col.className) parts.push(col.className);
    return parts.join(' ');
  }
}
