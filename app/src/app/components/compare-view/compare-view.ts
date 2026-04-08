import { Component, signal, computed, effect, viewChild, ElementRef, HostListener } from '@angular/core';
import { DataService } from '../../services/data.service';
import { Item } from '../../models/db.models';

type RowDef = [string, (i: Item) => string, ((v: string) => number) | null, boolean | null];
type PickerSortKey = 'size' | 'name' | 'dps' | 'alphaDamage' | 'fireRate' | 'projectileSpeed' | 'range' | 'powerDraw';

// Slot colors matching the radar chart
const SLOT_COLORS = ['#00c8ff', '#4aff7a', '#ffaa4a', '#e87ae8'];

interface RadarAxis {
  label: string;
  values: (number | null)[];       // raw values per slot
  normalized: (number | null)[];   // 0–1 normalized per slot
  higherBetter: boolean;
}

@Component({
  selector: 'app-compare-view',
  standalone: true,
  templateUrl: './compare-view.html',
  styleUrl: './compare-view.scss',
})
export class CompareViewComponent {
  slots = signal<(Item | null)[]>([null, null, null, null]);
  readonly slotColors = SLOT_COLORS;

  // ── Picker state ───────────────────────────────────────────────
  pickerSlot = signal<number | null>(null);   // which slot index is being edited (null = closed)
  pickerSearch = signal('');
  pickerSizeFilter = signal<number | null>(null);
  pickerSortBy = signal<PickerSortKey>('dps');
  pickerSortDir = signal<'asc' | 'desc'>('desc');
  pickerSearchInput = viewChild<ElementRef<HTMLInputElement>>('pickerSearchInput');

  weaponItems = computed(() =>
    this.data.items().filter(i => i.type === 'WeaponGun' && (i.dps ?? 0) > 0 && !i.name.includes('PLACEHOLDER'))
      .sort((a, b) => (a.size ?? 0) - (b.size ?? 0) || a.name.localeCompare(b.name))
  );

  availableSizes = computed(() => {
    const sizes = new Set<number>();
    for (const w of this.weaponItems()) if (w.size) sizes.add(w.size);
    return [...sizes].sort((a, b) => a - b);
  });

  filteredOptions = computed(() => {
    const q = this.pickerSearch().toLowerCase().trim();
    const sz = this.pickerSizeFilter();
    const sortBy = this.pickerSortBy();
    const dir = this.pickerSortDir();

    let list = this.weaponItems();
    if (sz !== null) list = list.filter(w => w.size === sz);
    if (q) list = list.filter(w => w.name.toLowerCase().includes(q) || (w.manufacturer ?? '').toLowerCase().includes(q));

    const get = (w: Item): number | string => {
      switch (sortBy) {
        case 'name': return w.name;
        case 'size': return w.size ?? 0;
        case 'dps': return w.dps ?? 0;
        case 'alphaDamage': return w.alphaDamage ?? 0;
        case 'fireRate': return w.fireRate ?? 0;
        case 'projectileSpeed': return w.projectileSpeed ?? 0;
        case 'range': return w.range ?? 0;
        case 'powerDraw': return w.powerDraw ?? 0;
      }
    };
    return [...list].sort((a, b) => {
      const av = get(a), bv = get(b);
      if (typeof av === 'string' && typeof bv === 'string') {
        return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return dir === 'asc' ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });
  });

  private commonRows: RowDef[] = [
    ['Name',         i => i.name,                        null,              null],
    ['Manufacturer', i => i.manufacturer ?? '—',         null,              null],
    ['Size',         i => `S${i.size ?? '?'}`,           null,              null],
    ['Grade',        i => i.grade ?? '—',                null,              null],
  ];

  private typeRows: Record<string, RowDef[]> = {
    WeaponGun: [
      ['DPS',           i => (i.dps ?? 0) > 0 ? i.dps!.toFixed(1) : '—',                         v => parseFloat(v) || 0, true],
      ['Alpha Damage',  i => (i.alphaDamage ?? 0) > 0 ? i.alphaDamage!.toFixed(2) : '—',          v => parseFloat(v) || 0, true],
      ['Fire Rate',     i => (i.fireRate ?? 0) > 0 ? i.fireRate!.toFixed(0) + ' rpm' : '—',       v => parseFloat(v) || 0, true],
      ['Physical',      i => (i.damage?.physical ?? 0) > 0 ? i.damage!.physical!.toFixed(2) : '—', null, null],
      ['Energy',        i => (i.damage?.energy ?? 0) > 0 ? i.damage!.energy!.toFixed(2) : '—',   null, null],
      ['Distortion',    i => (i.damage?.distortion ?? 0) > 0 ? i.damage!.distortion!.toFixed(2) : '—', null, null],
      ['Speed',         i => (i.projectileSpeed ?? 0) > 0 ? i.projectileSpeed!.toFixed(0) + ' m/s' : '—', v => parseFloat(v) || 0, true],
      ['Range',         i => (i.range ?? 0) > 0 ? ((i.range! / 1000).toFixed(1) + ' km') : '—',  v => parseFloat(v) || 0, true],
      ['Pen. Distance',   i => (i.penetrationDistance ?? 0) > 0 ? i.penetrationDistance!.toFixed(2) + 'm' : '—', v => parseFloat(v) || 0, true],
      ['Pen. Radius',     i => (i.penetrationMaxRadius ?? 0) > 0 ? i.penetrationMinRadius!.toFixed(2) + '–' + i.penetrationMaxRadius!.toFixed(2) + 'm' : '—', v => parseFloat(v) || 0, true],
      ['Power Draw',    i => (i.powerDraw ?? 0) > 0 ? i.powerDraw!.toFixed(2) : '—',              v => parseFloat(v) || 0, false],
    ],
    Shield: [
      ['HP',            i => (i.hp ?? 0) > 0 ? i.hp!.toFixed(0) : '—',                           v => parseFloat(v) || 0, true],
      ['Regen Rate',    i => (i.regenRate ?? 0) > 0 ? i.regenRate!.toFixed(0) + '/s' : '—',      v => parseFloat(v) || 0, true],
      ['Damaged Delay', i => (i.damagedRegenDelay ?? 0) > 0 ? i.damagedRegenDelay!.toFixed(2) + 's' : '—', v => parseFloat(v) || 0, false],
      ['Downed Delay',  i => (i.downedRegenDelay ?? 0) > 0 ? i.downedRegenDelay!.toFixed(2) + 's' : '—', v => parseFloat(v) || 0, false],
    ],
    PowerPlant: [
      ['Power Output',  i => (i.powerOutput ?? 0) > 0 ? i.powerOutput + ' segs' : '—',           v => parseFloat(v) || 0, true],
      ['EM Signature',  i => (i.emSignature ?? 0) > 0 ? i.emSignature!.toFixed(0) : '—',         v => parseFloat(v) || 0, false],
    ],
    Cooler: [
      ['Cooling Rate',  i => (i.coolingRate ?? 0) > 0 ? i.coolingRate!.toFixed(0) : '—',         v => parseFloat(v) || 0, true],
      ['IR Signature',  i => (i.irSignature ?? 0) > 0 ? i.irSignature!.toFixed(0) : '—',         v => parseFloat(v) || 0, false],
    ],
    QuantumDrive: [
      ['Speed',         i => (i.speed ?? 0) > 0 ? ((i.speed! / 1e3).toFixed(0) + ' Mm/s') : '—', v => parseFloat(v) || 0, true],
      ['Cal Time',      i => (i.calTime ?? 0) > 0 ? i.calTime!.toFixed(1) + 's' : '—',           v => parseFloat(v) || 0, false],
    ],
  };

  // Extra radar-only axes per type (numeric data not in the table, excluding ammo)
  private radarExtras: Record<string, { label: string; get: (i: Item) => number; higherBetter: boolean }[]> = {
    WeaponGun: [
      // Fire Rate and Speed are now sourced from typeRows (so they highlight
      // best-in-row in the comparison table). No extras needed here.
    ],
    Shield: [
      { label: 'Phys Resist',   get: i => i.resistPhysMax ?? 0,     higherBetter: true },
      { label: 'Enrg Resist',   get: i => i.resistEnrgMax ?? 0,     higherBetter: true },
      { label: 'Dist Resist',   get: i => i.resistDistMax ?? 0,     higherBetter: true },
    ],
    QuantumDrive: [
      { label: 'Spool Time',    get: i => i.spoolTime ?? 0,         higherBetter: false },
      { label: 'Cooldown',      get: i => i.cooldownTime ?? 0,      higherBetter: false },
      { label: 'Fuel Rate',     get: i => i.fuelRate ?? 0,          higherBetter: false },
    ],
  };

  rows = computed(() => {
    const items = this.slots().filter((i): i is Item => i !== null);
    if (!items.length) return [];
    const primaryType = items[0].type;
    return [...this.commonRows, ...(this.typeRows[primaryType] ?? [])];
  });

  // Radar chart data
  radarAxes = computed<RadarAxis[]>(() => {
    const items = this.slots();
    const filled = items.filter((i): i is Item => i !== null);
    if (filled.length < 2) return [];
    const primaryType = filled[0].type;

    // Collect numeric axes from typeRows (those with numFn)
    const typeRowDefs = this.typeRows[primaryType] ?? [];
    const axes: RadarAxis[] = [];

    for (const row of typeRowDefs) {
      const [label, valueFn, numFn, higherBetter] = row;
      if (!numFn || higherBetter === null) continue;

      const rawVals = items.map(i => {
        if (!i) return null;
        const str = valueFn(i);
        const num = numFn(str);
        return num > 0 ? num : null;
      });

      if (rawVals.every(v => v === null || v === 0)) continue;
      axes.push({ label, values: rawVals, normalized: [], higherBetter });
    }

    // Add extra radar axes not in table
    for (const extra of (this.radarExtras[primaryType] ?? [])) {
      // Skip if already covered by table rows
      if (axes.some(a => a.label === extra.label)) continue;
      const rawVals = items.map(i => {
        if (!i) return null;
        const v = extra.get(i);
        return v > 0 ? v : null;
      });
      if (rawVals.every(v => v === null || v === 0)) continue;
      axes.push({ label: extra.label, values: rawVals, normalized: [], higherBetter: extra.higherBetter });
    }

    // Normalize: for each axis, map values to 0–1
    // For "higher is better": normalized = value / max
    // For "lower is better": normalized = min / value (inverted so bigger polygon = better)
    for (const axis of axes) {
      const nums = axis.values.filter((v): v is number => v !== null && v > 0);
      if (nums.length === 0) {
        axis.normalized = axis.values.map(() => null);
        continue;
      }
      const max = Math.max(...nums);
      const min = Math.min(...nums);

      axis.normalized = axis.values.map(v => {
        if (v === null || v === 0) return null;
        if (axis.higherBetter) {
          return max > 0 ? v / max : 0;
        } else {
          return v > 0 ? min / v : 0;
        }
      });
    }

    return axes;
  });

  // SVG polygon points for each slot
  radarPolygons = computed(() => {
    const axes = this.radarAxes();
    if (axes.length < 3) return [];
    const items = this.slots();
    const cx = 150, cy = 150, r = 120;
    const n = axes.length;

    return items.map((item, slotIdx) => {
      if (!item) return null;
      const points = axes.map((axis, ai) => {
        const val = axis.normalized[slotIdx] ?? 0;
        const clampedVal = Math.max(0.08, val); // minimum visibility
        const angle = (Math.PI * 2 * ai) / n - Math.PI / 2;
        const x = cx + Math.cos(angle) * r * clampedVal;
        const y = cy + Math.sin(angle) * r * clampedVal;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      });
      return points.join(' ');
    });
  });

  // Axis label positions
  radarLabels = computed(() => {
    const axes = this.radarAxes();
    const cx = 150, cy = 150, r = 138;
    const n = axes.length;

    return axes.map((axis, ai) => {
      const angle = (Math.PI * 2 * ai) / n - Math.PI / 2;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      // Text anchor based on position
      let anchor = 'middle';
      if (x < cx - 10) anchor = 'end';
      else if (x > cx + 10) anchor = 'start';
      return { label: axis.label, x: x.toFixed(1), y: y.toFixed(1), anchor };
    });
  });

  // Grid rings
  radarGrid = computed(() => {
    const axes = this.radarAxes();
    if (axes.length < 3) return [];
    const cx = 150, cy = 150, r = 120;
    const n = axes.length;
    const rings = [0.25, 0.5, 0.75, 1.0];

    return rings.map(ring => {
      const points = Array.from({ length: n }, (_, ai) => {
        const angle = (Math.PI * 2 * ai) / n - Math.PI / 2;
        const x = cx + Math.cos(angle) * r * ring;
        const y = cy + Math.sin(angle) * r * ring;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      });
      return points.join(' ');
    });
  });

  // Spoke lines
  radarSpokes = computed(() => {
    const axes = this.radarAxes();
    const cx = 150, cy = 150, r = 120;
    const n = axes.length;
    return axes.map((_, ai) => {
      const angle = (Math.PI * 2 * ai) / n - Math.PI / 2;
      return {
        x2: (cx + Math.cos(angle) * r).toFixed(1),
        y2: (cy + Math.sin(angle) * r).toFixed(1),
      };
    });
  });

  constructor(public data: DataService) {
    // Auto-focus the search input when the picker opens. Angular destroys
    // and re-creates the input each time the @if branch toggles, so the
    // native autofocus attribute doesn't fire on subsequent opens.
    effect(() => {
      if (this.pickerSlot() === null) return;
      const ref = this.pickerSearchInput();
      if (ref) queueMicrotask(() => ref.nativeElement.focus());
    });

    // Pre-fill slots once item data has loaded. weaponItems() is empty during
    // the synchronous constructor pass because data.items() loads async, so
    // we need an effect that re-runs when items arrive.
    effect(() => {
      const items = this.weaponItems();
      if (!items.length) return;
      if (this.slots().every(s => s === null)) {
        // Pick four spread across sizes for visual variety
        const bySize = new Map<number, typeof items>();
        for (const w of items) {
          const sz = w.size ?? 0;
          if (!bySize.has(sz)) bySize.set(sz, []);
          bySize.get(sz)!.push(w);
        }
        const sizes = [...bySize.keys()].sort((a, b) => a - b);
        const picks: (typeof items[0] | null)[] = [];
        // Round-robin across sizes, taking the highest-DPS weapon from each
        for (const sz of sizes) {
          const top = [...bySize.get(sz)!].sort((a, b) => (b.dps ?? 0) - (a.dps ?? 0))[0];
          if (top) picks.push(top);
          if (picks.length >= 4) break;
        }
        // Pad with extras from the largest size if we didn't fill 4
        while (picks.length < 4 && sizes.length) {
          const last = bySize.get(sizes[sizes.length - 1])!;
          const next = [...last].sort((a, b) => (b.dps ?? 0) - (a.dps ?? 0))[picks.length];
          picks.push(next ?? null);
        }
        this.slots.set([picks[0] ?? null, picks[1] ?? null, picks[2] ?? null, picks[3] ?? null]);
      }
    });
  }

  setSlot(index: number, className: string): void {
    const item = className ? (this.data.items().find(i => i.className === className) ?? null) : null;
    const updated = [...this.slots()];
    updated[index] = item;
    this.slots.set(updated);
  }

  // ── Picker controls ─────────────────────────────────────────────
  openPicker(index: number, evt?: Event): void {
    evt?.stopPropagation();
    this.pickerSlot.set(index);
    this.pickerSearch.set('');
  }

  closePicker(): void {
    this.pickerSlot.set(null);
  }

  selectFromPicker(item: Item | null): void {
    const slot = this.pickerSlot();
    if (slot === null) return;
    const updated = [...this.slots()];
    updated[slot] = item;
    this.slots.set(updated);
    this.closePicker();
  }

  togglePickerSort(col: PickerSortKey): void {
    if (this.pickerSortBy() === col) {
      this.pickerSortDir.set(this.pickerSortDir() === 'desc' ? 'asc' : 'desc');
    } else {
      this.pickerSortBy.set(col);
      this.pickerSortDir.set(col === 'name' || col === 'powerDraw' ? 'asc' : 'desc');
    }
  }

  pickerSortIndicator(col: PickerSortKey): string {
    if (this.pickerSortBy() !== col) return '';
    return this.pickerSortDir() === 'desc' ? ' \u25BE' : ' \u25B4';
  }

  @HostListener('document:keydown.escape')
  onEsc(): void {
    if (this.pickerSlot() !== null) this.closePicker();
  }

  // ── Trigger card helpers ────────────────────────────────────────
  fmtNum(v: number | undefined | null, decimals = 0): string {
    if (!v) return '\u2014';
    return v.toFixed(decimals);
  }

  weaponDmgTag(w: Item): string {
    if (w.isBallistic) return 'Phys';
    const d = w.damage;
    if (!d) return '';
    if ((d.energy ?? 0) > 0 && (d.physical ?? 0) === 0) return 'Enrg';
    if ((d.distortion ?? 0) > 0) return 'Dist';
    if ((d.physical ?? 0) > 0 && (d.energy ?? 0) > 0) return 'Mixed';
    return '';
  }

  getCellValue(row: RowDef, item: Item | null): string {
    return item ? row[1](item) : '—';
  }

  isBest(row: RowDef, index: number): boolean {
    const numFn = row[2];
    const higherBetter = row[3];
    if (!numFn || higherBetter === null) return false;
    const items = this.slots();
    const vals = items.map(i => i ? numFn(row[1](i)) : (higherBetter ? -Infinity : Infinity));
    const best = higherBetter ? Math.max(...vals) : Math.min(...vals);
    if (!isFinite(best)) return false;
    const item = items[index];
    return item !== null && numFn(row[1](item)) === best;
  }
}
