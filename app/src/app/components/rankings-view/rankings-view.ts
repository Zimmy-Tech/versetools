import { Component, signal, computed, effect } from '@angular/core';
import { UpperCasePipe } from '@angular/common';
import { DataService } from '../../services/data.service';
import { Ship } from '../../models/db.models';

type RotationField = 'pitch' | 'yaw' | 'roll';
type AccelField = 'accelFwd' | 'accelRetro' | 'accelStrafe' | 'accelUp' | 'accelDown';
type SortField = RotationField | 'pitchBoosted' | 'yawBoosted' | 'rollBoosted'
  | AccelField | 'accelAbFwd' | 'accelAbRetro' | 'accelAbStrafe' | 'accelAbUp' | 'accelAbDown';

interface RankedShip {
  ship: Ship;
  value: number;
  bar: number;
  rank: number;
}

interface RadarPoint { x: number; y: number; }

const SLOT_COLORS = ['#00c8ff', '#4aff7a', '#ffaa4a'];
const CX = 150, CY = 150, R = 110;

type PanelMode = 'rankings' | 'rotation' | 'acceleration';

@Component({
  selector: 'app-rankings-view',
  standalone: true,
  imports: [UpperCasePipe],
  templateUrl: './rankings-view.html',
  styleUrl: './rankings-view.scss',
})
export class RankingsViewComponent {
  activePanel = signal<PanelMode>('rankings');
  sortField = signal<SortField>('pitch');
  sizeFilter = signal('');
  searchQuery = signal('');
  listBoosted = signal(false);
  rotBoosted = signal(false);
  accelBoosted = signal(false);
  readonly slotColors = SLOT_COLORS;

  // Radar ship pickers (3 slots each)
  rotSlots = signal<(Ship | null)[]>([null, null, null]);
  accelSlots = signal<(Ship | null)[]>([null, null, null]);

  private slotsInitialized = false;

  constructor(public data: DataService) {
    effect(() => {
      if (this.slotsInitialized) return;
      const rotShips = this.shipsWithRotation();
      const accelShips = this.shipsWithAccel();
      if (rotShips.length === 0 && accelShips.length === 0) return;
      this.slotsInitialized = true;
      if (rotShips.length > 0) {
        const slots: (Ship | null)[] = [rotShips[0] ?? null, rotShips[1] ?? null, rotShips[2] ?? null];
        this.rotSlots.set(slots);
      }
      if (accelShips.length > 0) {
        const slots: (Ship | null)[] = [accelShips[0] ?? null, accelShips[1] ?? null, accelShips[2] ?? null];
        this.accelSlots.set(slots);
      }
    });
  }

  readonly sizeOptions = ['', 'Small', 'Medium', 'Large', 'Capital'];

  /** Ships that have rotation data, sorted by name. */
  shipsWithRotation = computed(() =>
    this.data.ships()
      .filter(s => (s.pitch ?? 0) > 0)
      .sort((a, b) => a.name.localeCompare(b.name))
  );

  /** Ships that have acceleration data, sorted by name. */
  shipsWithAccel = computed(() =>
    this.data.ships()
      .filter(s => (s.accelFwd ?? 0) > 0)
      .sort((a, b) => a.name.localeCompare(b.name))
  );

  // ── Rankings list ──────────────────────────────────────

  activeSortField = computed<SortField>(() => {
    const base = this.sortField();
    if (!this.listBoosted()) return base;
    const map: Record<string, SortField> = {
      pitch: 'pitchBoosted', yaw: 'yawBoosted', roll: 'rollBoosted',
      pitchBoosted: 'pitchBoosted', yawBoosted: 'yawBoosted', rollBoosted: 'rollBoosted',
      accelFwd: 'accelAbFwd', accelRetro: 'accelAbRetro', accelStrafe: 'accelAbStrafe',
      accelUp: 'accelAbUp', accelDown: 'accelAbDown',
      accelAbFwd: 'accelAbFwd', accelAbRetro: 'accelAbRetro', accelAbStrafe: 'accelAbStrafe',
      accelAbUp: 'accelAbUp', accelAbDown: 'accelAbDown',
    };
    return map[base] ?? base;
  });

  rankedShips = computed<RankedShip[]>(() => {
    const field = this.activeSortField();
    const size = this.sizeFilter();
    const search = this.searchQuery().toLowerCase();
    const ships = this.data.ships().filter(s => {
      const val = (s as any)[field];
      if (val == null || val <= 0) return false;
      if (size && s.size !== size) return false;
      if (search && !s.name.toLowerCase().includes(search) &&
          !s.manufacturer.toLowerCase().includes(search)) return false;
      return true;
    });
    ships.sort((a, b) => ((b as any)[field] ?? 0) - ((a as any)[field] ?? 0));
    const maxVal = ships.length ? (ships[0] as any)[field] : 1;
    return ships.map((ship, i) => ({
      ship,
      value: (ship as any)[field],
      bar: Math.round(((ship as any)[field] / maxVal) * 100),
      rank: i + 1,
    }));
  });

  setSort(field: SortField): void { this.sortField.set(field); }

  fieldLabel(field: SortField): string {
    const labels: Record<string, string> = {
      pitch: 'Pitch', yaw: 'Yaw', roll: 'Roll',
      pitchBoosted: 'Pitch (Boosted)', yawBoosted: 'Yaw (Boosted)', rollBoosted: 'Roll (Boosted)',
      accelFwd: 'Forward', accelRetro: 'Retro', accelStrafe: 'Strafe', accelUp: 'Up', accelDown: 'Down',
      accelAbFwd: 'Forward (Boosted)', accelAbRetro: 'Retro (Boosted)', accelAbStrafe: 'Strafe (Boosted)',
      accelAbUp: 'Up (Boosted)', accelAbDown: 'Down (Boosted)',
    };
    return labels[field] ?? field;
  }

  fieldUnit(field: SortField): string {
    return field.startsWith('accel') ? 'G' : 'deg/s';
  }

  fmtVal(n: number): string {
    return n % 1 === 0 ? n.toString() : n.toFixed(1);
  }

  // ── Radar: shared geometry ─────────────────────────────

  private polarPoint(axisIdx: number, total: number, norm: number): RadarPoint {
    const angle = (2 * Math.PI * axisIdx / total) - Math.PI / 2;
    return { x: CX + Math.cos(angle) * R * norm, y: CY + Math.sin(angle) * R * norm };
  }

  private buildGrid(axisCount: number) {
    const rings = [0.25, 0.5, 0.75, 1.0];
    return rings.map(frac => {
      const pts = Array.from({ length: axisCount }, (_, i) => this.polarPoint(i, axisCount, frac));
      return pts.map(p => `${p.x},${p.y}`).join(' ');
    });
  }

  private buildSpokes(axisCount: number) {
    return Array.from({ length: axisCount }, (_, i) => this.polarPoint(i, axisCount, 1));
  }

  private buildLabels(names: string[], axisCount: number) {
    return names.map((name, i) => {
      const p = this.polarPoint(i, axisCount, 1.18);
      const anchor = p.x < CX - 5 ? 'end' : p.x > CX + 5 ? 'start' : 'middle';
      return { x: p.x, y: p.y, text: name, anchor };
    });
  }

  private buildPolygon(values: number[], maxValues: number[]): string {
    const n = values.length;
    return values.map((v, i) => {
      const norm = maxValues[i] > 0 ? Math.max(0.06, v / maxValues[i]) : 0.06;
      const p = this.polarPoint(i, n, norm);
      return `${p.x},${p.y}`;
    }).join(' ');
  }

  // ── Rotation radar ─────────────────────────────────────

  private readonly rotAxes = ['Pitch', 'Yaw', 'Roll'];
  private readonly rotFields: (keyof Ship)[] = ['pitch', 'yaw', 'roll'];
  private readonly rotFieldsBoosted: (keyof Ship)[] = ['pitchBoosted', 'yawBoosted', 'rollBoosted'];

  rotGrid   = this.buildGrid(3);
  rotSpokes = this.buildSpokes(3);
  rotLabels = this.buildLabels(this.rotAxes, 3);

  private rotActiveFields = computed(() => this.rotBoosted() ? this.rotFieldsBoosted : this.rotFields);

  rotMaxValues = computed(() => {
    const fields = this.rotActiveFields();
    const ships = this.rotSlots().filter(Boolean) as Ship[];
    return fields.map(f => Math.max(...ships.map(s => (s as any)[f] ?? 0), 1));
  });

  rotPolygons = computed(() => {
    const fields = this.rotActiveFields();
    const maxVals = this.rotMaxValues();
    return this.rotSlots().map((ship, i) => {
      if (!ship) return null;
      const values = fields.map(f => (ship as any)[f] ?? 0);
      return { points: this.buildPolygon(values, maxVals), color: SLOT_COLORS[i], values };
    });
  });

  // ── Acceleration radar ─────────────────────────────────

  private readonly accelAxes = ['Fwd', 'Retro', 'Strafe', 'Up', 'Down'];
  private readonly accelFields: (keyof Ship)[] = ['accelFwd', 'accelRetro', 'accelStrafe', 'accelUp', 'accelDown'];
  private readonly accelFieldsBoosted: (keyof Ship)[] = ['accelAbFwd', 'accelAbRetro', 'accelAbStrafe', 'accelAbUp', 'accelAbDown'];

  accelGrid   = this.buildGrid(5);
  accelSpokes = this.buildSpokes(5);
  accelLabels = this.buildLabels(this.accelAxes, 5);

  private accelActiveFields = computed(() => this.accelBoosted() ? this.accelFieldsBoosted : this.accelFields);

  accelMaxValues = computed(() => {
    const fields = this.accelActiveFields();
    const ships = this.accelSlots().filter(Boolean) as Ship[];
    return fields.map(f => Math.max(...ships.map(s => (s as any)[f] ?? 0), 1));
  });

  accelPolygons = computed(() => {
    const fields = this.accelActiveFields();
    const maxVals = this.accelMaxValues();
    return this.accelSlots().map((ship, i) => {
      if (!ship) return null;
      const values = fields.map(f => (ship as any)[f] ?? 0);
      return { points: this.buildPolygon(values, maxVals), color: SLOT_COLORS[i], values };
    });
  });

  // ── Ship pickers ───────────────────────────────────────

  setRotSlot(index: number, className: string): void {
    const ship = this.data.ships().find(s => s.className === className) ?? null;
    this.rotSlots.update(s => { const n = [...s]; n[index] = ship; return n; });
  }

  setAccelSlot(index: number, className: string): void {
    const ship = this.data.ships().find(s => s.className === className) ?? null;
    this.accelSlots.update(s => { const n = [...s]; n[index] = ship; return n; });
  }
}
