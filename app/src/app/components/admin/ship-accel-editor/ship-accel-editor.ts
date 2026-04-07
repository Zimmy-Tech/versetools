import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DataService } from '../../../services/data.service';
import { AdminService } from '../admin.service';
import type { Ship } from '../../../models/db.models';

interface AccelFields {
  accelFwd: number | null;
  accelAbFwd: number | null;
  accelRetro: number | null;
  accelAbRetro: number | null;
  accelStrafe: number | null;
  accelAbStrafe: number | null;
  accelUp: number | null;
  accelAbUp: number | null;
  accelDown: number | null;
  accelAbDown: number | null;
  accelTestedDate: string;
  accelCheckedBy: string;
}

const ACCEL_KEYS: (keyof AccelFields)[] = [
  'accelFwd', 'accelAbFwd',
  'accelRetro', 'accelAbRetro',
  'accelStrafe', 'accelAbStrafe',
  'accelUp', 'accelAbUp',
  'accelDown', 'accelAbDown',
  'accelTestedDate', 'accelCheckedBy',
];

const NUM_KEYS = ACCEL_KEYS.filter(
  (k) => k !== 'accelTestedDate' && k !== 'accelCheckedBy'
) as (keyof AccelFields)[];

function emptyForm(): AccelFields {
  return {
    accelFwd: null, accelAbFwd: null,
    accelRetro: null, accelAbRetro: null,
    accelStrafe: null, accelAbStrafe: null,
    accelUp: null, accelAbUp: null,
    accelDown: null, accelAbDown: null,
    accelTestedDate: '',
    accelCheckedBy: '',
  };
}

@Component({
  selector: 'app-ship-accel-editor',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './ship-accel-editor.html',
  styleUrl: './ship-accel-editor.scss',
})
export class ShipAccelEditorComponent {
  private data = inject(DataService);
  private admin = inject(AdminService);

  // All ships from the database, sorted by name for the picker
  ships = computed(() => {
    const all = this.data.db()?.ships ?? [];
    return [...all].sort((a, b) =>
      (a.name || a.className).localeCompare(b.name || b.className)
    );
  });

  search = signal('');
  filteredShips = computed(() => {
    const q = this.search().toLowerCase().trim();
    if (!q) return this.ships();
    return this.ships().filter(
      (s) =>
        (s.name || '').toLowerCase().includes(q) ||
        s.className.toLowerCase().includes(q) ||
        (s.manufacturer || '').toLowerCase().includes(q)
    );
  });

  selectedClassName = signal<string | null>(null);
  selectedShip = computed<Ship | null>(() => {
    const cls = this.selectedClassName();
    if (!cls) return null;
    return this.ships().find((s) => s.className === cls) ?? null;
  });

  form = signal<AccelFields>(emptyForm());
  status = signal<{ kind: 'idle' | 'saving' | 'success' | 'error'; message?: string }>({
    kind: 'idle',
  });

  constructor() {
    // When a ship is selected, populate the form from its current values
    effect(() => {
      const ship = this.selectedShip();
      if (!ship) {
        this.form.set(emptyForm());
        return;
      }
      const next = emptyForm();
      for (const k of ACCEL_KEYS) {
        const v = (ship as any)[k];
        if (v != null) (next as any)[k] = v;
      }
      this.form.set(next);
      this.status.set({ kind: 'idle' });
    });
  }

  selectShip(className: string): void {
    this.selectedClassName.set(className);
  }

  updateField<K extends keyof AccelFields>(key: K, value: AccelFields[K]): void {
    this.form.update((f) => ({ ...f, [key]: value }));
  }

  async save(): Promise<void> {
    const ship = this.selectedShip();
    if (!ship) return;

    // Build the patch — only include fields that have values
    const patch: Record<string, unknown> = {};
    const f = this.form();
    for (const k of NUM_KEYS) {
      const v = f[k];
      if (v != null && !Number.isNaN(Number(v))) {
        patch[k] = Number(v);
      }
    }
    if (f.accelTestedDate.trim()) patch['accelTestedDate'] = f.accelTestedDate.trim();
    if (f.accelCheckedBy.trim()) patch['accelCheckedBy'] = f.accelCheckedBy.trim();

    if (Object.keys(patch).length === 0) {
      this.status.set({ kind: 'error', message: 'No fields to save.' });
      return;
    }

    this.status.set({ kind: 'saving' });
    try {
      await this.admin.patchShip(ship.className, patch);
      this.status.set({
        kind: 'success',
        message: `Saved ${Object.keys(patch).length} fields. Reload the site to see updates.`,
      });
    } catch (err: any) {
      const msg = err?.error?.error || err?.message || 'Save failed';
      this.status.set({ kind: 'error', message: msg });
    }
  }
}
