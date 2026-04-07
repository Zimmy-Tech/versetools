// Full ship editor — section-based form covering all flat ship fields.
// Hardpoints and default loadout will get their own dedicated editor
// in a later step because they are arrays-of-objects, not scalars.

import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DataService } from '../../../services/data.service';
import { AdminService } from '../admin.service';
import type { Ship } from '../../../models/db.models';

type FieldKind = 'number' | 'text' | 'date';

interface FieldDef {
  key: keyof Ship | string;
  label: string;
  kind: FieldKind;
  step?: number;
}

interface SectionDef {
  id: string;
  title: string;
  fields: FieldDef[];
}

const SECTIONS: SectionDef[] = [
  {
    id: 'identity',
    title: 'Identity',
    fields: [
      { key: 'name', label: 'Name', kind: 'text' },
      { key: 'manufacturer', label: 'Manufacturer', kind: 'text' },
      { key: 'size', label: 'Size', kind: 'text' },
      { key: 'role', label: 'Role', kind: 'text' },
      { key: 'career', label: 'Career', kind: 'text' },
      { key: 'crew', label: 'Crew', kind: 'number', step: 1 },
      { key: 'mass', label: 'Mass (kg)', kind: 'number', step: 1 },
    ],
  },
  {
    id: 'flight',
    title: 'Flight & Maneuvering',
    fields: [
      { key: 'scmSpeed', label: 'SCM Speed', kind: 'number', step: 1 },
      { key: 'navSpeed', label: 'NAV Speed', kind: 'number', step: 1 },
      { key: 'boostSpeedFwd', label: 'Boost Fwd', kind: 'number', step: 1 },
      { key: 'boostSpeedBwd', label: 'Boost Bwd', kind: 'number', step: 1 },
      { key: 'boostRampUp', label: 'Boost Ramp Up', kind: 'number', step: 0.01 },
      { key: 'boostRampDown', label: 'Boost Ramp Down', kind: 'number', step: 0.01 },
      { key: 'pitch', label: 'Pitch', kind: 'number', step: 0.1 },
      { key: 'yaw', label: 'Yaw', kind: 'number', step: 0.1 },
      { key: 'roll', label: 'Roll', kind: 'number', step: 0.1 },
      { key: 'pitchBoosted', label: 'Pitch (Boost)', kind: 'number', step: 0.1 },
      { key: 'yawBoosted', label: 'Yaw (Boost)', kind: 'number', step: 0.1 },
      { key: 'rollBoosted', label: 'Roll (Boost)', kind: 'number', step: 0.1 },
    ],
  },
  {
    id: 'accel',
    title: 'Acceleration',
    fields: [
      { key: 'accelFwd', label: 'Fwd', kind: 'number', step: 0.01 },
      { key: 'accelAbFwd', label: 'Fwd Boost', kind: 'number', step: 0.01 },
      { key: 'accelRetro', label: 'Retro', kind: 'number', step: 0.01 },
      { key: 'accelAbRetro', label: 'Retro Boost', kind: 'number', step: 0.01 },
      { key: 'accelStrafe', label: 'Strafe', kind: 'number', step: 0.01 },
      { key: 'accelAbStrafe', label: 'Strafe Boost', kind: 'number', step: 0.01 },
      { key: 'accelUp', label: 'Up', kind: 'number', step: 0.01 },
      { key: 'accelAbUp', label: 'Up Boost', kind: 'number', step: 0.01 },
      { key: 'accelDown', label: 'Down', kind: 'number', step: 0.01 },
      { key: 'accelAbDown', label: 'Down Boost', kind: 'number', step: 0.01 },
      { key: 'accelTestedDate', label: 'Tested Date', kind: 'date' },
      { key: 'accelCheckedBy', label: 'Checked By', kind: 'text' },
    ],
  },
  {
    id: 'hull',
    title: 'Hull & Armor',
    fields: [
      { key: 'totalHp', label: 'Total HP', kind: 'number', step: 1 },
      { key: 'bodyHp', label: 'Body HP', kind: 'number', step: 1 },
      { key: 'armorHp', label: 'Armor HP', kind: 'number', step: 1 },
      { key: 'armorDeflectPhys', label: 'Deflect (Phys)', kind: 'number', step: 0.1 },
      { key: 'armorDeflectEnrg', label: 'Deflect (Enrg)', kind: 'number', step: 0.1 },
      { key: 'hullDmgPhys', label: 'Hull Dmg (Phys)', kind: 'number', step: 0.01 },
      { key: 'hullDmgEnrg', label: 'Hull Dmg (Enrg)', kind: 'number', step: 0.01 },
      { key: 'hullDmgDist', label: 'Hull Dmg (Dist)', kind: 'number', step: 0.01 },
      { key: 'durabilityPhys', label: 'Durability (Phys)', kind: 'number', step: 0.01 },
      { key: 'durabilityEnrg', label: 'Durability (Enrg)', kind: 'number', step: 0.01 },
      { key: 'durabilityDist', label: 'Durability (Dist)', kind: 'number', step: 0.01 },
    ],
  },
  {
    id: 'power',
    title: 'Power & Capacity',
    fields: [
      { key: 'weaponPowerPoolSize', label: 'Weapon Power Pool', kind: 'number', step: 1 },
      { key: 'thrusterPowerBars', label: 'Thruster Power Bars', kind: 'number', step: 1 },
      { key: 'cargoCapacity', label: 'Cargo (SCU)', kind: 'number', step: 1 },
      { key: 'oreCapacity', label: 'Ore (SCU)', kind: 'number', step: 1 },
      { key: 'hydrogenFuelCapacity', label: 'Hydrogen Fuel', kind: 'number', step: 1 },
      { key: 'quantumFuelCapacity', label: 'Quantum Fuel', kind: 'number', step: 1 },
      { key: 'cmDecoys', label: 'CM Decoys', kind: 'number', step: 1 },
      { key: 'cmNoise', label: 'CM Noise', kind: 'number', step: 1 },
    ],
  },
  {
    id: 'signatures',
    title: 'Signatures',
    fields: [
      { key: 'signalEM', label: 'EM', kind: 'number', step: 0.01 },
      { key: 'signalCrossSection', label: 'Cross Section', kind: 'number', step: 0.01 },
      { key: 'signalIR', label: 'IR', kind: 'number', step: 0.01 },
    ],
  },
  {
    id: 'dimensions',
    title: 'Dimensions',
    fields: [
      { key: 'dimWidth', label: 'Width (m)', kind: 'number', step: 0.1 },
      { key: 'dimLength', label: 'Length (m)', kind: 'number', step: 0.1 },
      { key: 'dimHeight', label: 'Height (m)', kind: 'number', step: 0.1 },
    ],
  },
  {
    id: 'insurance',
    title: 'Insurance',
    fields: [
      { key: 'insuranceStandardMinutes', label: 'Standard (min)', kind: 'number', step: 1 },
      { key: 'insuranceExpediteMinutes', label: 'Expedite (min)', kind: 'number', step: 1 },
      { key: 'insuranceExpediteCost', label: 'Expedite Cost', kind: 'number', step: 1 },
    ],
  },
];

@Component({
  selector: 'app-ship-editor',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './ship-editor.html',
  styleUrl: './ship-editor.scss',
})
export class ShipEditorComponent {
  private data = inject(DataService);
  private admin = inject(AdminService);

  readonly sections = SECTIONS;

  ships = computed(() => {
    const all = this.data.db()?.ships ?? [];
    return [...all].sort((a, b) =>
      (a.name || a.className).localeCompare(b.name || b.className)
    );
  });

  // Create-new state
  createOpen = signal(false);
  createClassName = signal('');
  createName = signal('');
  createBusy = signal(false);
  createError = signal<string | null>(null);

  // Delete state
  deleteBusy = signal(false);
  deleteError = signal<string | null>(null);

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

  // The current form values, keyed by field name. Starts empty and is
  // populated whenever a ship is loaded.
  form = signal<Record<string, any>>({});

  // The original loaded values, used to compute which fields are dirty.
  original = signal<Record<string, any>>({});

  // Which sections are currently expanded
  expanded = signal<Set<string>>(new Set(['identity']));

  status = signal<{ kind: 'idle' | 'saving' | 'success' | 'error'; message?: string }>({
    kind: 'idle',
  });

  // Fields that have been edited (different from their original values)
  dirtyKeys = computed(() => {
    const f = this.form();
    const o = this.original();
    const dirty: string[] = [];
    for (const k of Object.keys(f)) {
      const a = f[k];
      const b = o[k];
      if ((a ?? '') !== (b ?? '')) dirty.push(k);
    }
    return dirty;
  });

  dirtyCount = computed(() => this.dirtyKeys().length);

  constructor() {
    effect(() => {
      const ship = this.selectedShip();
      if (!ship) {
        this.form.set({});
        this.original.set({});
        return;
      }
      const next: Record<string, any> = {};
      for (const section of SECTIONS) {
        for (const field of section.fields) {
          const v = (ship as any)[field.key];
          next[field.key as string] = v ?? (field.kind === 'number' ? null : '');
        }
      }
      this.form.set({ ...next });
      this.original.set({ ...next });
      this.status.set({ kind: 'idle' });
    });
  }

  selectShip(className: string): void {
    this.selectedClassName.set(className);
  }

  toggleSection(id: string): void {
    this.expanded.update((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  isExpanded(id: string): boolean {
    return this.expanded().has(id);
  }

  /** Returns true if any field in this section is dirty. */
  sectionDirty(section: SectionDef): boolean {
    const dirty = new Set(this.dirtyKeys());
    return section.fields.some((f) => dirty.has(f.key as string));
  }

  updateField(key: string, value: any): void {
    this.form.update((f) => ({ ...f, [key]: value }));
  }

  expandAll(): void {
    this.expanded.set(new Set(SECTIONS.map((s) => s.id)));
  }

  collapseAll(): void {
    this.expanded.set(new Set());
  }

  reset(): void {
    this.form.set({ ...this.original() });
    this.status.set({ kind: 'idle' });
  }

  async save(): Promise<void> {
    const ship = this.selectedShip();
    if (!ship) return;

    const dirty = this.dirtyKeys();
    if (dirty.length === 0) {
      this.status.set({ kind: 'error', message: 'No changes to save.' });
      return;
    }

    // Build the patch with proper types
    const patch: Record<string, unknown> = {};
    const f = this.form();
    for (const key of dirty) {
      const fieldDef = this.findField(key);
      const v = f[key];
      if (fieldDef?.kind === 'number') {
        if (v === null || v === '' || Number.isNaN(Number(v))) {
          patch[key] = null;
        } else {
          patch[key] = Number(v);
        }
      } else {
        patch[key] = v;
      }
    }

    this.status.set({ kind: 'saving' });
    try {
      await this.admin.patchShip(ship.className, patch);
      // Success — refresh the original snapshot so dirty count goes to 0
      this.original.set({ ...this.form() });
      this.status.set({
        kind: 'success',
        message: `Saved ${dirty.length} field${dirty.length === 1 ? '' : 's'}. Reload the public site to see updates.`,
      });
    } catch (err: any) {
      const msg = err?.error?.error || err?.message || 'Save failed';
      this.status.set({ kind: 'error', message: msg });
    }
  }

  private findField(key: string): FieldDef | undefined {
    for (const s of SECTIONS) {
      const f = s.fields.find((x) => x.key === key);
      if (f) return f;
    }
    return undefined;
  }

  // ─── Create new ship ─────────────────────────────────────────────

  toggleCreate(): void {
    this.createOpen.update((v) => !v);
    if (this.createOpen()) {
      this.createClassName.set('');
      this.createName.set('');
      this.createError.set(null);
    }
  }

  async submitCreate(): Promise<void> {
    const cls = this.createClassName().trim();
    const name = this.createName().trim();
    if (!cls) {
      this.createError.set('className is required');
      return;
    }
    this.createBusy.set(true);
    this.createError.set(null);
    try {
      await this.admin.createShip({ className: cls, name: name || cls });
      await this.data.refreshDb();
      this.selectedClassName.set(cls);
      this.createOpen.set(false);
    } catch (err: any) {
      const status = err?.status;
      const msg = err?.error?.error || err?.message || 'Create failed';
      this.createError.set(status === 409 ? 'A ship with that className already exists' : msg);
    } finally {
      this.createBusy.set(false);
    }
  }

  // ─── Delete current ship ─────────────────────────────────────────

  async deleteSelectedShip(): Promise<void> {
    const ship = this.selectedShip();
    if (!ship) return;
    const ok = window.confirm(
      `Delete ${ship.name || ship.className}?\n\nThis cannot be undone from the UI, but the full pre-delete data is recorded in the audit log if you need to recover it manually.`
    );
    if (!ok) return;

    this.deleteBusy.set(true);
    this.deleteError.set(null);
    try {
      await this.admin.deleteShip(ship.className);
      this.selectedClassName.set(null);
      await this.data.refreshDb();
    } catch (err: any) {
      const msg = err?.error?.error || err?.message || 'Delete failed';
      this.deleteError.set(msg);
    } finally {
      this.deleteBusy.set(false);
    }
  }
}
