import { Component, inject, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AdminService, type CoolingObservation } from '../admin.service';
import { DataService } from '../../../services/data.service';
import type { Ship } from '../../../models/db.models';

@Component({
  selector: 'app-cooling-observations',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './cooling-observations.html',
  styleUrl: './cooling-observations.scss',
})
export class CoolingObservationsComponent {
  private admin = inject(AdminService);
  private data = inject(DataService);

  // ─── Observations list ───
  observations = signal<CoolingObservation[]>([]);
  loading = signal(false);
  error = signal<string | null>(null);

  // ─── Form state ───
  shipSearch = signal('');
  selectedShip = signal<Ship | null>(null);
  buildVersion = signal('4.0.2');
  reportedCoolingPct = signal<number | null>(null);
  loadoutNote = signal('');
  notes = signal('');
  submitting = signal(false);
  submitResult = signal<string | null>(null);

  // Power block pip allocation — individual slots where pips vary
  readonly pipGroups = [
    { key: 'Weapons', label: 'Weapons' },
    { key: 'Thrusters', label: 'Thrusters' },
    { key: 'Shields', label: 'Shields' },
    { key: 'QuantumDrive', label: 'Quantum Drive' },
    { key: 'Radar', label: 'Radar' },
    { key: 'LifeSupport', label: 'Life Support' },
    { key: 'Cooler1', label: 'Cooler 1' },
    { key: 'Cooler2', label: 'Cooler 2', optional: true },
  ];
  pipValues = signal<Record<string, number | string | null>>({});

  ships = computed(() => {
    const db = this.data.db();
    return db?.ships ?? [];
  });

  filteredShips = computed(() => {
    const q = this.shipSearch().toLowerCase();
    if (!q || q.length < 2) return [];
    return this.ships()
      .filter(s => s.name?.toLowerCase().includes(q) || s.className?.toLowerCase().includes(q))
      .slice(0, 10);
  });

  constructor() {
    this.refresh();
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const obs = await this.admin.listCoolingObservations();
      this.observations.set(obs);
    } catch (err: any) {
      this.error.set(err?.error?.error || err?.message || 'Failed to load');
    } finally {
      this.loading.set(false);
    }
  }

  pickShip(ship: Ship): void {
    this.selectedShip.set(ship);
    this.shipSearch.set(ship.name || ship.className);
  }

  setPip(group: string, value: number | string | null): void {
    this.pipValues.update(v => ({ ...v, [group]: value }));
  }

  setNA(group: string, isNA: boolean): void {
    this.pipValues.update(v => ({ ...v, [group]: isNA ? 'NA' : null }));
  }

  isNA(group: string): boolean {
    return this.pipValues()[group] === 'NA';
  }

  clearShip(): void {
    this.selectedShip.set(null);
    this.shipSearch.set('');
  }

  async submit(): Promise<void> {
    const ship = this.selectedShip();
    if (!ship || this.reportedCoolingPct() === null) return;

    this.submitting.set(true);
    this.submitResult.set(null);
    // Build pip allocation from form values (include numbers and 'NA')
    const rawPips = this.pipValues();
    const pipAllocation: Record<string, number | string> = {};
    for (const [k, v] of Object.entries(rawPips)) {
      if (v === 'NA') pipAllocation[k] = 'NA';
      else if (v != null && typeof v === 'number' && v >= 0) pipAllocation[k] = v;
    }

    try {
      await this.admin.createCoolingObservation({
        shipClassName: ship.className,
        shipName: ship.name || ship.className,
        buildVersion: this.buildVersion(),
        pipAllocation: Object.keys(pipAllocation).length ? pipAllocation : undefined,
        reportedCoolingPct: this.reportedCoolingPct()!,
        loadoutNote: this.loadoutNote() || undefined,
        notes: this.notes() || undefined,
      });
      this.submitResult.set(`Saved observation for ${ship.name}`);
      // Reset form
      this.reportedCoolingPct.set(null);
      this.loadoutNote.set('');
      this.notes.set('');
      this.pipValues.set({});
      await this.refresh();
    } catch (err: any) {
      this.submitResult.set('Error: ' + (err?.error?.error || err?.message || 'Save failed'));
    } finally {
      this.submitting.set(false);
    }
  }

  async deleteObs(id: number): Promise<void> {
    if (!confirm('Delete this observation?')) return;
    try {
      await this.admin.deleteCoolingObservation(id);
      await this.refresh();
    } catch (err: any) {
      this.error.set('Delete failed: ' + (err?.error?.error || err?.message));
    }
  }

  fmtDate(iso: string): string {
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  }

  residual(obs: CoolingObservation): string {
    if (obs.predicted_cooling_pct == null) return '—';
    const diff = obs.reported_cooling_pct - obs.predicted_cooling_pct;
    return (diff > 0 ? '+' : '') + diff + '%';
  }
}
