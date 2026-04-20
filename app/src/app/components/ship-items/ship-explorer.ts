import { Component, signal, computed, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { DataService } from '../../services/data.service';
import { Ship } from '../../models/db.models';

/** Entry from star-citizen.wiki v3 vehicles API — the only data the
 *  Ship Explorer needs beyond the local ship record. Deliberately
 *  isolated from the main DataService / Ship model so this third-party
 *  source can't leak into the loadout / compare / pickers. */
interface ShipMatrixEntry {
  role?: string;          // "Light Fighter", "Medium Fighter", …
  career?: string;        // "Combat", "Transporter", …
  shipMatrixName?: string;
}

interface ShipMatrixFile {
  source: string;
  fetched_at: string;
  total_vehicles_in_api: number;
  map: Record<string, ShipMatrixEntry>;
}

/** A configurable dropdown filter for the ship explorer. */
interface ShipDropdownFilter {
  label: string;
  allLabel: string;
  value: (s: Ship) => string | null | undefined;
}

/** Column descriptor for the ship explorer table. */
interface ShipCol {
  /** Column header text. */
  label: string;
  /** Field key used for sorting (also default value source when `value` omitted). */
  field: string;
  /** Clickable header that toggles sort on this field. */
  sortable?: boolean;
  /** Right-align numeric columns. */
  align?: 'left' | 'right';
  /** Suffix appended after the formatted value (' m/s', ' s', etc.). */
  unit?: string;
  /** Decimals for numeric formatting. */
  decimals?: number;
  /** Multiply raw value by 100 + append '%'. For 0..1 fraction fields. */
  percent?: boolean;
  /** Custom accessor when the value isn't a direct field lookup. */
  value?: (s: Ship) => string | number | null | undefined;
}

@Component({
  selector: 'app-ship-explorer',
  standalone: true,
  templateUrl: './ship-explorer.html',
  styleUrl: './ship-item-db.scss',
  // Override the shared table-wrap's 1500px cap — Ship Explorer has
  // 37 columns and deserves the full viewport on wide screens. The
  // .sid-view's centering is also relaxed so the table can span full
  // width instead of being centered.
  styles: [`
    :host ::ng-deep .sid-view { align-items: stretch; }
    :host ::ng-deep .sid-table-wrap { max-width: none; }
  `],
})
export class ShipExplorerComponent {
  searchQuery = signal('');
  dropdownValues = signal<Record<string, string>>({});
  sortField = signal('');
  sortDir = signal<'asc' | 'desc'>('asc');

  selectedShip = signal<Ship | null>(null);

  /** True when any filter (search or dropdown) is narrowing the list. */
  readonly hasActiveFilter = computed(() => {
    if (this.searchQuery().trim()) return true;
    return Object.values(this.dropdownValues()).some(v => !!v);
  });

  /** Reset filters; sort state kept so column preference survives. */
  clearFilters(): void {
    this.searchQuery.set('');
    this.dropdownValues.set({});
  }

  /** Lazy-loaded map from our internal className (lowercased) to the
   *  star-citizen.wiki role/career entry. Only the Explorer consumes
   *  this — it never lands in DataService or the Ship interface. */
  private matrixMap = signal<Record<string, ShipMatrixEntry>>({});

  constructor(public data: DataService, private http: HttpClient) {
    // Fetch the static JSON once on init. Failure is non-fatal — the
    // Explorer falls back to the local ship.role value, so the page
    // still works if the file is missing (e.g. dev preview before
    // running the fetcher).
    this.http.get<ShipMatrixFile>('live/ship_matrix_roles.json').subscribe({
      next: file => this.matrixMap.set(file?.map ?? {}),
      error: () => this.matrixMap.set({}),
    });
  }

  /** Resolve a ship to its star-citizen.wiki entry with a few fuzzy
   *  fallbacks — the wiki's class_name field diverges from ours on a
   *  handful of ships (e.g. `rsi_aurora_mr` ↔ `rsi_aurora_gs_mr`,
   *  `*_mkii` ↔ `*_mk2`). */
  private matrixEntry(s: Ship): ShipMatrixEntry | undefined {
    const map = this.matrixMap();
    const cn = (s.className ?? '').toLowerCase();
    if (!cn) return undefined;
    if (map[cn]) return map[cn];

    // _mkii ↔ _mk2
    const mkSwap = cn.replace(/_mkii\b/, '_mk2').replace(/_mk2\b/, '_mk2');
    if (map[mkSwap]) return map[mkSwap];
    const mkSwapRev = cn.replace(/_mk2\b/, '_mkii');
    if (map[mkSwapRev]) return map[mkSwapRev];

    // Aurora and a few others: wiki inserts a `_gs_` segment.
    const withGs = cn.replace(/^(rsi_aurora)_/, '$1_gs_');
    if (map[withGs]) return map[withGs];

    // Name-based fallback: match against shipMatrixName.
    const shipName = (s.name ?? '').toLowerCase();
    if (shipName) {
      for (const entry of Object.values(map)) {
        if ((entry.shipMatrixName ?? '').toLowerCase() === shipName) return entry;
      }
    }
    return undefined;
  }

  /** Public accessor used by the column config — returns the wiki role
   *  if we have one, otherwise the local ship.role (fallback ensures
   *  the column is never blank when either source has data). */
  wikiRole(s: Ship): string {
    return this.matrixEntry(s)?.role ?? s.role ?? '';
  }

  /** Ships visible in the table — hidden ships (listed in DataService
   *  hiddenShips) are already excluded by `data.ships()`. */
  readonly ships = computed<Ship[]>(() => this.data.ships());

  readonly dropdowns: ShipDropdownFilter[] = [
    { label: 'Manufacturer', allLabel: 'All Manufacturers', value: s => s.manufacturer },
    { label: 'Size',         allLabel: 'All Sizes',         value: s => s.size },
    { label: 'Career',       allLabel: 'All Careers',       value: s => s.career },
    { label: 'Role',         allLabel: 'All Roles',         value: s => this.wikiRole(s) },
  ];

  /** Dimensions formatter — W × L × H in meters. */
  private dimDisplay(s: Ship): string {
    const w = s.dimWidth, l = s.dimLength, h = s.dimHeight;
    if (w == null && l == null && h == null) return '\u2014';
    const fmt = (n?: number) => n != null ? Math.round(n).toString() : '?';
    return `${fmt(w)} × ${fmt(l)} × ${fmt(h)} m`;
  }

  /** Duration in minutes → compact h:m or just minutes under an hour. */
  private fmtDuration(mins?: number): string {
    if (mins == null) return '\u2014';
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  }

  /** Cheapest shop price or em-dash. */
  private fmtPrice(s: Ship): string {
    const prices = s.shopPrices ?? [];
    if (!prices.length) return '\u2014';
    const min = prices.reduce((acc, p) => Math.min(acc, p.price), Infinity);
    if (!isFinite(min)) return '\u2014';
    return min.toLocaleString('en-US') + ' aUEC';
  }

  readonly cols: ShipCol[] = [
    { label: 'Name',          field: 'name',          sortable: true },
    { label: 'Manufacturer',  field: 'manufacturer',  sortable: true },
    { label: 'Type',          field: '_type',         sortable: true, value: s => s.isGroundVehicle ? 'Vehicle' : 'Ship' },
    { label: 'Career',        field: 'career',        sortable: true },
    { label: 'Role',          field: 'role',          sortable: true, value: s => this.wikiRole(s) },
    { label: 'Size',          field: 'size',          sortable: true },
    { label: 'Crew',          field: 'crew',          sortable: true, align: 'right', decimals: 0 },
    { label: 'Dimensions',    field: '_dims',         value: s => this.dimDisplay(s) },
    { label: 'Mass',          field: 'mass',          sortable: true, align: 'right', decimals: 0, unit: ' kg' },
    { label: 'Cargo',         field: 'cargoCapacity', sortable: true, align: 'right', decimals: 0, unit: ' SCU' },
    { label: 'HP',            field: 'totalHp',       sortable: true, align: 'right', decimals: 0 },
    { label: 'Armor',         field: 'armorHp',       sortable: true, align: 'right', decimals: 0 },
    { label: 'Deflect Phys',  field: 'armorDeflectPhys', sortable: true, align: 'right', decimals: 0 },
    { label: 'Deflect Enrg',  field: 'armorDeflectEnrg', sortable: true, align: 'right', decimals: 0 },
    { label: 'SCM',           field: 'scmSpeed',        sortable: true, align: 'right', decimals: 0, unit: ' m/s' },
    { label: 'Boost Fwd',     field: 'boostSpeedFwd',   sortable: true, align: 'right', decimals: 0, unit: ' m/s' },
    { label: 'Boost Bwd',     field: 'boostSpeedBwd',   sortable: true, align: 'right', decimals: 0, unit: ' m/s' },
    { label: 'NAV',           field: 'navSpeed',        sortable: true, align: 'right', decimals: 0, unit: ' m/s' },
    { label: 'Pitch',         field: 'pitch',           sortable: true, align: 'right', decimals: 1, unit: '°/s' },
    { label: 'Yaw',           field: 'yaw',             sortable: true, align: 'right', decimals: 1, unit: '°/s' },
    { label: 'Roll',          field: 'roll',            sortable: true, align: 'right', decimals: 1, unit: '°/s' },
    { label: 'Pitch Boost',   field: 'pitchBoosted',    sortable: true, align: 'right', decimals: 1, unit: '°/s' },
    { label: 'Yaw Boost',     field: 'yawBoosted',      sortable: true, align: 'right', decimals: 1, unit: '°/s' },
    { label: 'Roll Boost',    field: 'rollBoosted',     sortable: true, align: 'right', decimals: 1, unit: '°/s' },
    { label: 'H2 Capacity',   field: 'hydrogenFuelCapacity', sortable: true, align: 'right', decimals: 0 },
    { label: 'QT Fuel',       field: 'quantumFuelCapacity',  sortable: true, align: 'right', decimals: 0 },
    { label: 'Shield Faces',  field: 'shieldFaceType' },
    { label: 'CM Decoy',      field: 'cmDecoys',        sortable: true, align: 'right', decimals: 0 },
    { label: 'CM Noise',      field: 'cmNoise',         sortable: true, align: 'right', decimals: 0 },
    { label: 'Armor Phys',    field: 'hullDmgPhys',     sortable: true, align: 'right', decimals: 2 },
    { label: 'Armor Enrg',    field: 'hullDmgEnrg',     sortable: true, align: 'right', decimals: 2 },
    { label: 'Sig EM',        field: 'signalEM',        sortable: true, align: 'right', decimals: 2 },
    { label: 'Sig IR',        field: 'signalIR',        sortable: true, align: 'right', decimals: 2 },
    { label: 'Sig CS',        field: 'signalCrossSection', sortable: true, align: 'right', decimals: 2 },
    { label: 'Expedite Fee',  field: 'insuranceExpediteCost',    sortable: true, align: 'right', decimals: 0, unit: ' aUEC' },
    { label: 'Claim Time',    field: 'insuranceStandardMinutes', sortable: true, align: 'right', value: s => this.fmtDuration(s.insuranceStandardMinutes) },
    { label: 'Expedite Time', field: 'insuranceExpediteMinutes', sortable: true, align: 'right', value: s => this.fmtDuration(s.insuranceExpediteMinutes) },
    { label: 'Price',         field: '_price',                   sortable: true, align: 'right',
      value: s => this.fmtPrice(s),
      // Separate numeric accessor via sort order handled in filtered()
    },
  ];

  /** Distinct values for each dropdown filter, sorted. */
  dropdownOptions(filter: ShipDropdownFilter): string[] {
    const values = new Set<string>();
    for (const s of this.ships()) {
      const v = filter.value(s);
      if (v != null && v !== '') values.add(String(v));
    }
    return Array.from(values).sort();
  }

  setDropdownValue(label: string, value: string): void {
    this.dropdownValues.update(m => ({ ...m, [label]: value }));
  }

  readonly filtered = computed<Ship[]>(() => {
    let list = this.ships();
    const q = this.searchQuery().toLowerCase().trim();
    if (q) {
      list = list.filter(s =>
        (s.name ?? '').toLowerCase().includes(q) ||
        (s.manufacturer ?? '').toLowerCase().includes(q) ||
        (s.role ?? '').toLowerCase().includes(q)
      );
    }
    const dropVals = this.dropdownValues();
    for (const f of this.dropdowns) {
      const selected = dropVals[f.label];
      if (selected) {
        list = list.filter(s => String(f.value(s) ?? '') === selected);
      }
    }

    const field = this.sortField();
    if (!field) return list;
    const dir = this.sortDir();
    const sign = dir === 'asc' ? 1 : -1;
    const col = this.cols.find(c => c.field === field);

    return [...list].sort((a, b) => {
      // Price: sort by the underlying numeric minPrice, not the formatted string.
      if (field === '_price') {
        const mp = (s: Ship) => (s.shopPrices ?? []).reduce((acc, p) => Math.min(acc, p.price), Infinity);
        const av = mp(a), bv = mp(b);
        const aInf = !isFinite(av), bInf = !isFinite(bv);
        if (aInf && bInf) return 0;
        if (aInf) return 1;
        if (bInf) return -1;
        return (av - bv) * sign;
      }
      const av = col?.value ? col.value(a) : (a as any)[field];
      const bv = col?.value ? col.value(b) : (b as any)[field];
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sign;
      return String(av ?? '').localeCompare(String(bv ?? '')) * sign;
    });
  });

  formatted(s: Ship, col: ShipCol): string {
    const raw = col.value ? col.value(s) : (s as any)[col.field];
    if (raw == null || raw === '') return '\u2014';
    let v: number | string = raw as any;
    if (col.percent && typeof v === 'number') v = (v * 100).toFixed(col.decimals ?? 0) + '%';
    else if (typeof v === 'number' && col.decimals != null) v = v.toFixed(col.decimals);
    else if (typeof v === 'number') v = v.toLocaleString('en-US', { maximumFractionDigits: 1 });
    return v + (col.unit ?? '');
  }

  toggleSort(col: ShipCol): void {
    if (!col.sortable) return;
    if (this.sortField() === col.field) {
      this.sortDir.set(this.sortDir() === 'desc' ? 'asc' : 'desc');
    } else {
      this.sortField.set(col.field);
      // Numeric / right-aligned columns default to descending (biggest first);
      // text columns ascending.
      this.sortDir.set(col.align === 'right' ? 'desc' : 'asc');
    }
  }

  sortIndicator(col: ShipCol): string {
    if (!col.sortable || this.sortField() !== col.field) return '';
    return this.sortDir() === 'desc' ? ' \u25BE' : ' \u25B4';
  }

  tdClass(col: ShipCol, firstCol: boolean): string {
    const parts: string[] = [];
    if (firstCol) parts.push('col-name');
    if (col.align === 'right') parts.push('col-num');
    return parts.join(' ');
  }
}
