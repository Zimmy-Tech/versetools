import { Component, signal, computed } from '@angular/core';
import { DataService } from '../../services/data.service';
import { Ship, Item } from '../../models/db.models';

type ClassFilter = 'stock' | 'Military' | 'Civilian' | 'Stealth' | 'Competition' | 'Industrial';
type GradeFilter = 'A' | 'B' | 'C' | 'D';

interface RankedQt {
  ship: Ship;
  drive: Item | null;
  range: number;      // Gm
  fuel: number;       // ship fuel capacity
  fuelRate: number;   // drive fuel rate
  size: number;       // QD slot size
  bar: number;        // 0..100
  rank: number;
  missingReason?: string;
}

@Component({
  selector: 'app-qt-range-view',
  standalone: true,
  templateUrl: './qt-range-view.html',
  styleUrl: './qt-range-view.scss',
})
export class QtRangeViewComponent {
  classFilter = signal<ClassFilter>('stock');
  gradeFilter = signal<GradeFilter>('A');
  searchQuery = signal('');
  sizeFilter = signal<number | ''>('');
  shipSizeFilter = signal<string>('');

  readonly classButtons: { id: ClassFilter; label: string }[] = [
    { id: 'stock',       label: 'STOCK' },
    { id: 'Military',    label: 'MILITARY' },
    { id: 'Civilian',    label: 'CIVILIAN' },
    { id: 'Stealth',     label: 'STEALTH' },
    { id: 'Competition', label: 'COMPETITION' },
    { id: 'Industrial',  label: 'INDUSTRIAL' },
  ];

  readonly gradeButtons: GradeFilter[] = ['A', 'B', 'C', 'D'];

  readonly sizeOptions: (number | '')[] = ['', 1, 2, 3, 4];
  readonly shipSizeOptions: string[] = ['', 'Small', 'Medium', 'Large', 'Capital'];

  /** True if at least one drive exists anywhere for the given class+grade combo. */
  hasAnyDrive(cls: ClassFilter, grade: GradeFilter): boolean {
    if (cls === 'stock') return true;
    for (const [k] of this.bestDriveByClassGradeSize()) {
      const [c, g] = k.split('|');
      if (c === cls && g === grade) return true;
    }
    return false;
  }

  /** Available grades for the currently-selected class (used to grey out empty grade buttons). */
  availableGrades = computed<Set<GradeFilter>>(() => {
    const cls = this.classFilter();
    const out = new Set<GradeFilter>();
    if (cls === 'stock') return out;
    for (const [k] of this.bestDriveByClassGradeSize()) {
      const [c, g] = k.split('|');
      if (c === cls) out.add(g as GradeFilter);
    }
    return out;
  });

  constructor(public data: DataService) {}

  /** Find the quantum drive slot size for a ship via its hardpoints. */
  private qdSlotSize(ship: Ship): number {
    const hp = ship.hardpoints?.find(h =>
      h.type === 'QuantumDrive' ||
      h.allTypes?.some(t => t.type === 'QuantumDrive') ||
      h.controllerTag === 'quantum_drive'
    );
    if (!hp) return 0;
    return hp.maxSize ?? hp.minSize ?? 0;
  }

  /** The ship's currently-fitted default quantum drive, if any. */
  private stockDrive(ship: Ship): Item | null {
    const cls = ship.defaultLoadout?.['hardpoint_quantum_drive'];
    if (!cls) return null;
    return this.data.itemMap().get(cls.toLowerCase()) ?? null;
  }

  /** Map of best drive (lowest fuelRate) keyed by `${itemClass}|${grade}|${size}`. */
  private bestDriveByClassGradeSize = computed(() => {
    const byKey = new Map<string, Item>();
    for (const it of this.data.items()) {
      if (it.type !== 'QuantumDrive') continue;
      if (!it.itemClass || !it.grade || !it.size || !it.fuelRate) continue;
      const key = `${it.itemClass}|${it.grade}|${it.size}`;
      const prev = byKey.get(key);
      // Prefer the drive with the lowest fuel rate (best range for the class/grade/size)
      if (!prev || (it.fuelRate! < (prev.fuelRate ?? Infinity))) byKey.set(key, it);
    }
    return byKey;
  });

  private driveFor(ship: Ship, filter: ClassFilter, grade: GradeFilter): Item | null {
    if (filter === 'stock') return this.stockDrive(ship);
    const size = this.qdSlotSize(ship);
    if (!size) return null;
    return this.bestDriveByClassGradeSize().get(`${filter}|${grade}|${size}`) ?? null;
  }

  /** Ships with non-zero quantumFuelCapacity, filtered & ranked by computed range. */
  rankedShips = computed<RankedQt[]>(() => {
    const filter = this.classFilter();
    const grade = this.gradeFilter();
    const search = this.searchQuery().toLowerCase();
    const sizeF = this.sizeFilter();
    const shipSize = this.shipSizeFilter().toLowerCase();

    const rows: RankedQt[] = [];
    for (const ship of this.data.ships()) {
      if (ship.isGroundVehicle) continue;
      const fuel = ship.quantumFuelCapacity ?? 0;
      if (fuel <= 0) continue;
      const size = this.qdSlotSize(ship);
      if (!size) continue;
      if (sizeF !== '' && size !== sizeF) continue;
      if (shipSize && ship.size?.toLowerCase() !== shipSize) continue;
      if (search &&
          !ship.name.toLowerCase().includes(search) &&
          !ship.manufacturer.toLowerCase().includes(search)) continue;

      const drive = this.driveFor(ship, filter, grade);
      const fuelRate = drive?.fuelRate ?? 0;
      const range = (drive && fuelRate > 0) ? fuel / fuelRate : 0;
      rows.push({
        ship, drive, range, fuel, fuelRate, size,
        bar: 0, rank: 0,
        missingReason: drive ? undefined :
          `No size ${size} ${filter === 'stock' ? 'stock' : filter + ' ' + grade} drive`,
      });
    }

    rows.sort((a, b) => b.range - a.range);
    const maxVal = rows.length ? rows[0].range : 1;
    rows.forEach((r, i) => {
      r.rank = i + 1;
      r.bar = maxVal > 0 ? Math.round((r.range / maxVal) * 100) : 0;
    });
    return rows;
  });

  setClassFilter(id: ClassFilter): void { this.classFilter.set(id); }
  setGradeFilter(g: GradeFilter): void { this.gradeFilter.set(g); }

  fmtRange(gm: number): string {
    if (gm <= 0) return '—';
    if (gm >= 1000) return (gm / 1000).toFixed(2) + ' Tm';
    return gm.toFixed(1) + ' Gm';
  }

  fmtNum(n: number, digits = 2): string {
    if (!n) return '0';
    return n.toFixed(digits);
  }
}
