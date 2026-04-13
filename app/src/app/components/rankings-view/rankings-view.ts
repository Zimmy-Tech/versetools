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
const CX = 200, CY = 200, R = 160;

type PanelMode = 'rankings' | 'acceleration';

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
  accelBoosted = signal(false);
  readonly slotColors = SLOT_COLORS;

  accelSlots = signal<(Ship | null)[]>([null, null, null]);

  private slotsInitialized = false;

  constructor(public data: DataService) {
    effect(() => {
      if (this.slotsInitialized) return;
      const accelShips = this.shipsWithAccel();
      if (accelShips.length === 0) return;
      this.slotsInitialized = true;
      const find = (name: string) => accelShips.find(s => s.name.includes(name)) ?? null;
      this.accelSlots.set([find('Gladius'), find('Hawk'), find('Arrow')]);
    });
  }

  readonly sizeOptions = ['', 'Small', 'Medium', 'Large', 'Capital'];

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
      if (size && s.size?.toLowerCase() !== size.toLowerCase()) return false;
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

  // ── Flight profile radar (10-axis clock-face layout) ───
  //
  // Clock positions:  12=Fwd  1=Retro  2=Up  4=Down
  //   5=Left  6=Right  7=Pitch  8=Yaw  10=Roll  11=SCM

  private readonly profileAngles = Array.from({ length: 10 }, (_, i) => (2 * Math.PI * i / 10) - Math.PI / 2);
  private readonly profileLabels10 = ['Fwd', 'Retro', 'Up', 'Down', 'Left', 'Right', 'Pitch', 'Yaw', 'Roll', 'SCM'];
  private readonly profileFields: (keyof Ship)[] =
    ['accelFwd', 'accelRetro', 'accelUp', 'accelDown', 'accelStrafe', 'accelStrafe', 'pitch', 'yaw', 'roll', 'scmSpeed'];
  private readonly profileFieldsBoosted: (keyof Ship)[] =
    ['accelAbFwd', 'accelAbRetro', 'accelAbUp', 'accelAbDown', 'accelAbStrafe', 'accelAbStrafe', 'pitchBoosted', 'yawBoosted', 'rollBoosted', 'boostSpeedFwd'];

  private profilePoint(axisIdx: number, norm: number): RadarPoint {
    const a = this.profileAngles[axisIdx];
    return { x: CX + Math.cos(a) * R * norm, y: CY + Math.sin(a) * R * norm };
  }

  profileGrid = [0.25, 0.5, 0.75, 1.0].map(frac => {
    const pts = this.profileAngles.map((_, i) => this.profilePoint(i, frac));
    return pts.map(p => `${p.x},${p.y}`).join(' ');
  });

  profileSpokes = this.profileAngles.map((_, i) => this.profilePoint(i, 1));

  profileAxisLabels = this.profileLabels10.map((name, i) => {
    const p = this.profilePoint(i, 1.22);
    const anchor = p.x < CX - 5 ? 'end' : p.x > CX + 5 ? 'start' : 'middle';
    return { x: p.x, y: p.y, text: name, anchor };
  });

  private readonly profileUnits = ['G', 'G', 'G', 'G', 'G', 'G', '°/s', '°/s', '°/s', 'm/s'];

  /** Formatted max-value labels positioned at each spoke tip. */
  profileMaxLabels = computed(() => {
    const maxVals = this.profileGlobalMaxBoosted();
    return this.profileSpokes.map((spoke, i) => {
      const val = maxVals[i];
      const text = `${this.fmtVal(val)} ${this.profileUnits[i]}`;
      const anchor = spoke.x < CX - 5 ? 'end' : spoke.x > CX + 5 ? 'start' : 'middle';
      // Nudge outward slightly from the spoke endpoint
      const a = this.profileAngles[i];
      const nudge = 8;
      const x = spoke.x + Math.cos(a) * nudge;
      const y = spoke.y + Math.sin(a) * nudge;
      return { x, y, text, anchor };
    });
  });

  /** Global max per axis — normal and boosted computed independently. */
  profileGlobalMax = computed(() => {
    const allShips = this.data.ships();
    return this.profileFields.map(f =>
      Math.max(...allShips.map(s => (s as any)[f] ?? 0), 1)
    );
  });

  profileGlobalMaxBoosted = computed(() => {
    const allShips = this.data.ships();
    return this.profileFieldsBoosted.map(f =>
      Math.max(...allShips.map(s => (s as any)[f] ?? 0), 1)
    );
  });

  private buildProfilePoly(fields: (keyof Ship)[], maxVals: number[], ship: Ship, color: string) {
    const values = fields.map(f => (ship as any)[f] ?? 0);
    const pcts = values.map((v, j) => maxVals[j] > 0 ? v / maxVals[j] : 0);
    const vertices = pcts.map((p, j) => this.profilePoint(j, Math.max(0.03, p)));
    const points = vertices.map(p => `${p.x},${p.y}`).join(' ');
    return { points, color, values, vertices, pcts };
  }

  /** Normal (solid) lines — scaled against boosted max so they sit inside the dashed lines. */
  profilePolygons = computed(() => {
    const maxVals = this.profileGlobalMaxBoosted();
    return this.accelSlots().map((ship, i) =>
      ship ? this.buildProfilePoly(this.profileFields, maxVals, ship, SLOT_COLORS[i]) : null
    );
  });

  /** Boosted (dashed) lines — same scale, fills to outer ring. */
  profileBoostedPolygons = computed(() => {
    const maxVals = this.profileGlobalMaxBoosted();
    return this.accelSlots().map((ship, i) =>
      ship ? this.buildProfilePoly(this.profileFieldsBoosted, maxVals, ship, SLOT_COLORS[i]) : null
    );
  });

  // ── Fleet average (ghost) ───────────────────────────────

  private buildAvgPoly(fields: (keyof Ship)[], maxVals: number[], ships: Ship[], color: string) {
    if (ships.length === 0) return null;
    const n = ships.length;
    const values = fields.map(f => ships.reduce((sum, s) => sum + (Number((s as any)[f]) || 0), 0) / n);
    const pcts = values.map((v, j) => maxVals[j] > 0 ? v / maxVals[j] : 0);
    const vertices = pcts.map((p, j) => this.profilePoint(j, Math.max(0.03, p)));
    const points = vertices.map(p => `${p.x},${p.y}`).join(' ');
    return { points, color, values, vertices, pcts };
  }

  fleetAvgNormal = computed(() => {
    const ships = this.shipsWithAccel();
    const maxVals = this.profileGlobalMaxBoosted();
    return this.buildAvgPoly(this.profileFields, maxVals, ships, '#888');
  });

  fleetAvgBoosted = computed(() => {
    const ships = this.shipsWithAccel();
    const maxVals = this.profileGlobalMaxBoosted();
    return this.buildAvgPoly(this.profileFieldsBoosted, maxVals, ships, '#888');
  });

  // ── Ship pickers ───────────────────────────────────────

  setAccelSlot(index: number, className: string): void {
    const ship = this.data.ships().find(s => s.className === className) ?? null;
    this.accelSlots.update(s => { const n = [...s]; n[index] = ship; return n; });
  }
}
