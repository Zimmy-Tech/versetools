// Item editor — full flat-field editor for any item in the database.
// Items have ~80 possible fields across many sub-types (weapons, shields,
// coolers, power plants, quantum drives, etc.). This editor exposes all
// of them in collapsible sections; only fields that already have a value
// on the selected item are highlighted, but everything is editable so
// missing fields can be filled in.

import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DataService } from '../../../services/data.service';
import { AdminService } from '../admin.service';
import type { Item } from '../../../models/db.models';

type FieldKind = 'number' | 'text' | 'boolean';

interface FieldDef {
  key: keyof Item | string;
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
      { key: 'type', label: 'Type', kind: 'text' },
      { key: 'subType', label: 'Sub Type', kind: 'text' },
      { key: 'size', label: 'Size', kind: 'number', step: 1 },
      { key: 'grade', label: 'Grade', kind: 'text' },
      { key: 'itemClass', label: 'Item Class', kind: 'text' },
    ],
  },
  {
    id: 'power',
    title: 'Power',
    fields: [
      { key: 'powerDraw', label: 'Power Draw', kind: 'number', step: 0.01 },
      { key: 'powerOutput', label: 'Power Output', kind: 'number', step: 1 },
      { key: 'powerMin', label: 'Power Min', kind: 'number', step: 0.01 },
      { key: 'powerMax', label: 'Power Max', kind: 'number', step: 0.01 },
      { key: 'minConsumptionFraction', label: 'Min Cons. Fraction', kind: 'number', step: 0.01 },
      { key: 'emSignature', label: 'EM Signature', kind: 'number', step: 0.01 },
    ],
  },
  {
    id: 'weapon-core',
    title: 'Weapon — Core Stats',
    fields: [
      { key: 'isBallistic', label: 'Ballistic?', kind: 'boolean' },
      { key: 'dps', label: 'DPS', kind: 'number', step: 0.1 },
      { key: 'alphaDamage', label: 'Alpha Damage', kind: 'number', step: 0.1 },
      { key: 'fireRate', label: 'Fire Rate (RPM)', kind: 'number', step: 1 },
      { key: 'range', label: 'Range', kind: 'number', step: 1 },
      { key: 'projectileSpeed', label: 'Projectile Speed', kind: 'number', step: 1 },
      { key: 'heatPerShot', label: 'Heat Per Shot', kind: 'number', step: 0.01 },
    ],
  },
  {
    id: 'weapon-ammo',
    title: 'Weapon — Ammo & Restock',
    fields: [
      { key: 'ammoCount', label: 'Ammo Count', kind: 'number', step: 1 },
      { key: 'maxAmmoLoad', label: 'Max Ammo Load', kind: 'number', step: 1 },
      { key: 'requestedAmmoLoad', label: 'Req. Ammo Load', kind: 'number', step: 1 },
      { key: 'maxRegenPerSec', label: 'Max Regen / sec', kind: 'number', step: 0.1 },
      { key: 'regenCooldown', label: 'Regen Cooldown', kind: 'number', step: 0.1 },
      { key: 'maxRestockCount', label: 'Max Restock', kind: 'number', step: 1 },
      { key: 'costPerBullet', label: 'Cost per Bullet', kind: 'number', step: 0.01 },
    ],
  },
  {
    id: 'weapon-pen',
    title: 'Weapon — Penetration / Detonation',
    fields: [
      { key: 'penetrationDistance', label: 'Pen. Distance', kind: 'number', step: 0.01 },
      { key: 'penetrationMinRadius', label: 'Pen. Min Radius', kind: 'number', step: 0.01 },
      { key: 'penetrationMaxRadius', label: 'Pen. Max Radius', kind: 'number', step: 0.01 },
      { key: 'detonationMinRadius', label: 'Detonation Min', kind: 'number', step: 0.01 },
      { key: 'detonationMaxRadius', label: 'Detonation Max', kind: 'number', step: 0.01 },
      { key: 'explosionMinRadius', label: 'Explosion Min', kind: 'number', step: 0.01 },
      { key: 'explosionMaxRadius', label: 'Explosion Max', kind: 'number', step: 0.01 },
    ],
  },
  {
    id: 'shield-pool',
    title: 'Shield — Pool & Regen',
    fields: [
      { key: 'hp', label: 'HP', kind: 'number', step: 1 },
      { key: 'regenRate', label: 'Regen Rate', kind: 'number', step: 0.1 },
      { key: 'damagedRegenDelay', label: 'Damaged Delay (s)', kind: 'number', step: 0.01 },
      { key: 'downedRegenDelay', label: 'Downed Delay (s)', kind: 'number', step: 0.01 },
    ],
  },
  {
    id: 'shield-resist',
    title: 'Shield — Resist & Absorb',
    fields: [
      { key: 'resistPhysMin', label: 'Resist Phys Min', kind: 'number', step: 0.01 },
      { key: 'resistPhysMax', label: 'Resist Phys Max', kind: 'number', step: 0.01 },
      { key: 'resistEnrgMin', label: 'Resist Enrg Min', kind: 'number', step: 0.01 },
      { key: 'resistEnrgMax', label: 'Resist Enrg Max', kind: 'number', step: 0.01 },
      { key: 'resistDistMin', label: 'Resist Dist Min', kind: 'number', step: 0.01 },
      { key: 'resistDistMax', label: 'Resist Dist Max', kind: 'number', step: 0.01 },
      { key: 'absPhysMin', label: 'Absorb Phys Min', kind: 'number', step: 0.01 },
      { key: 'absPhysMax', label: 'Absorb Phys Max', kind: 'number', step: 0.01 },
      { key: 'absEnrgMin', label: 'Absorb Enrg Min', kind: 'number', step: 0.01 },
      { key: 'absEnrgMax', label: 'Absorb Enrg Max', kind: 'number', step: 0.01 },
      { key: 'absDistMin', label: 'Absorb Dist Min', kind: 'number', step: 0.01 },
      { key: 'absDistMax', label: 'Absorb Dist Max', kind: 'number', step: 0.01 },
    ],
  },
  {
    id: 'component',
    title: 'Component HP & Distortion',
    fields: [
      { key: 'componentHp', label: 'Component HP', kind: 'number', step: 1 },
      { key: 'selfRepairTime', label: 'Self Repair Time', kind: 'number', step: 0.1 },
      { key: 'selfRepairRatio', label: 'Self Repair Ratio', kind: 'number', step: 0.01 },
      { key: 'distortionMax', label: 'Distortion Max', kind: 'number', step: 0.1 },
      { key: 'distortionDecayDelay', label: 'Distortion Decay Delay', kind: 'number', step: 0.1 },
      { key: 'distortionDecayRate', label: 'Distortion Decay Rate', kind: 'number', step: 0.1 },
      { key: 'emMax', label: 'EM Max', kind: 'number', step: 0.1 },
      { key: 'emDecayRate', label: 'EM Decay Rate', kind: 'number', step: 0.1 },
    ],
  },
  {
    id: 'cooler',
    title: 'Cooler',
    fields: [
      { key: 'coolingRate', label: 'Cooling Rate', kind: 'number', step: 0.1 },
      { key: 'irSignature', label: 'IR Signature', kind: 'number', step: 0.1 },
    ],
  },
  {
    id: 'qd',
    title: 'Quantum Drive',
    fields: [
      { key: 'speed', label: 'Speed (Gm/s)', kind: 'number', step: 0.01 },
      { key: 'splineSpeed', label: 'Spline Speed', kind: 'number', step: 0.01 },
      { key: 'fuelRate', label: 'Fuel Rate', kind: 'number', step: 0.01 },
      { key: 'spoolTime', label: 'Spool Time', kind: 'number', step: 0.1 },
      { key: 'calTime', label: 'Cal Time', kind: 'number', step: 0.1 },
      { key: 'calDelay', label: 'Cal Delay', kind: 'number', step: 0.1 },
      { key: 'cooldownTime', label: 'Cooldown Time', kind: 'number', step: 0.1 },
      { key: 'stageOneAccel', label: 'Stage 1 Accel', kind: 'number', step: 0.01 },
      { key: 'stageTwoAccel', label: 'Stage 2 Accel', kind: 'number', step: 0.01 },
      { key: 'interdictionTime', label: 'Interdiction Time', kind: 'number', step: 0.01 },
    ],
  },
  {
    id: 'radar',
    title: 'Radar',
    fields: [
      { key: 'aimMin', label: 'Aim Min', kind: 'number', step: 1 },
      { key: 'aimMax', label: 'Aim Max', kind: 'number', step: 1 },
      { key: 'aimBuffer', label: 'Aim Buffer', kind: 'number', step: 0.01 },
      { key: 'irSensitivity', label: 'IR Sensitivity', kind: 'number', step: 0.01 },
      { key: 'emSensitivity', label: 'EM Sensitivity', kind: 'number', step: 0.01 },
      { key: 'csSensitivity', label: 'CS Sensitivity', kind: 'number', step: 0.01 },
      { key: 'rsSensitivity', label: 'RS Sensitivity', kind: 'number', step: 0.01 },
    ],
  },
  {
    id: 'mining',
    title: 'Mining Laser / Module',
    fields: [
      { key: 'optimalRange', label: 'Optimal Range', kind: 'number', step: 0.1 },
      { key: 'maxRange', label: 'Max Range', kind: 'number', step: 0.1 },
      { key: 'throttleMin', label: 'Throttle Min', kind: 'number', step: 0.01 },
      { key: 'miningMinPower', label: 'Mining Min Power', kind: 'number', step: 0.01 },
      { key: 'miningMaxPower', label: 'Mining Max Power', kind: 'number', step: 0.01 },
      { key: 'miningInstability', label: 'Instability', kind: 'number', step: 0.01 },
      { key: 'miningOptimalWindow', label: 'Optimal Window', kind: 'number', step: 0.01 },
      { key: 'miningResistance', label: 'Resistance', kind: 'number', step: 0.01 },
      { key: 'miningOptimalRate', label: 'Optimal Rate', kind: 'number', step: 0.01 },
      { key: 'miningShatterDamage', label: 'Shatter Damage', kind: 'number', step: 0.01 },
      { key: 'miningInertMaterials', label: 'Inert Materials', kind: 'number', step: 0.01 },
      { key: 'miningOvercharge', label: 'Overcharge', kind: 'number', step: 0.01 },
      { key: 'miningPowerMult', label: 'Power Mult', kind: 'number', step: 0.01 },
      { key: 'charges', label: 'Charges', kind: 'number', step: 1 },
    ],
  },
  {
    id: 'salvage',
    title: 'Salvage',
    fields: [
      { key: 'salvageSpeed', label: 'Salvage Speed', kind: 'number', step: 0.01 },
      { key: 'salvageRadius', label: 'Salvage Radius', kind: 'number', step: 0.01 },
      { key: 'salvageEfficiency', label: 'Efficiency', kind: 'number', step: 0.01 },
      { key: 'maxHeat', label: 'Max Heat', kind: 'number', step: 0.01 },
      { key: 'coolingDelay', label: 'Cooling Delay', kind: 'number', step: 0.01 },
      { key: 'overheatCooldown', label: 'Overheat Cooldown', kind: 'number', step: 0.01 },
    ],
  },
  {
    id: 'missile',
    title: 'Missile / Launcher',
    fields: [
      { key: 'capacity', label: 'Capacity', kind: 'number', step: 1 },
      { key: 'missileSize', label: 'Missile Size', kind: 'number', step: 1 },
      { key: 'armTime', label: 'Arm Time', kind: 'number', step: 0.01 },
      { key: 'igniteTime', label: 'Ignite Time', kind: 'number', step: 0.01 },
      { key: 'lockTime', label: 'Lock Time', kind: 'number', step: 0.01 },
      { key: 'lockAngle', label: 'Lock Angle', kind: 'number', step: 0.1 },
      { key: 'lockRangeMin', label: 'Lock Range Min', kind: 'number', step: 1 },
      { key: 'lockRangeMax', label: 'Lock Range Max', kind: 'number', step: 1 },
      { key: 'acquisition', label: 'Acquisition', kind: 'text' },
    ],
  },
  {
    id: 'flight-controller',
    title: 'Flight Controller (Blade)',
    fields: [
      { key: 'scmSpeed', label: 'SCM Speed', kind: 'number', step: 1 },
      { key: 'navSpeed', label: 'NAV Speed', kind: 'number', step: 1 },
      { key: 'boostSpeedFwd', label: 'Boost Fwd', kind: 'number', step: 1 },
      { key: 'boostSpeedBwd', label: 'Boost Bwd', kind: 'number', step: 1 },
      { key: 'pitch', label: 'Pitch', kind: 'number', step: 0.1 },
      { key: 'yaw', label: 'Yaw', kind: 'number', step: 0.1 },
      { key: 'roll', label: 'Roll', kind: 'number', step: 0.1 },
      { key: 'pitchBoosted', label: 'Pitch (Boost)', kind: 'number', step: 0.1 },
      { key: 'yawBoosted', label: 'Yaw (Boost)', kind: 'number', step: 0.1 },
      { key: 'rollBoosted', label: 'Roll (Boost)', kind: 'number', step: 0.1 },
    ],
  },
];

@Component({
  selector: 'app-item-editor',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './item-editor.html',
  styleUrl: './item-editor.scss',
})
export class ItemEditorComponent {
  private data = inject(DataService);
  private admin = inject(AdminService);

  readonly sections = SECTIONS;
  readonly itemTypes = computed(() => {
    const all = this.data.db()?.items ?? [];
    return Array.from(new Set(all.map((i) => i.type).filter(Boolean))).sort();
  });

  search = signal('');
  typeFilter = signal<string>('');

  items = computed(() => {
    const all = this.data.db()?.items ?? [];
    return [...all].sort((a, b) =>
      (a.name || a.className).localeCompare(b.name || b.className)
    );
  });

  filteredItems = computed(() => {
    const q = this.search().toLowerCase().trim();
    const type = this.typeFilter();
    return this.items().filter((i) => {
      if (type && i.type !== type) return false;
      if (!q) return true;
      return (
        (i.name || '').toLowerCase().includes(q) ||
        i.className.toLowerCase().includes(q) ||
        (i.manufacturer || '').toLowerCase().includes(q)
      );
    });
  });

  selectedClassName = signal<string | null>(null);
  selectedItem = computed<Item | null>(() => {
    const cls = this.selectedClassName();
    if (!cls) return null;
    return this.items().find((i) => i.className === cls) ?? null;
  });

  form = signal<Record<string, any>>({});
  original = signal<Record<string, any>>({});
  expanded = signal<Set<string>>(new Set(['identity']));

  status = signal<{ kind: 'idle' | 'saving' | 'success' | 'error'; message?: string }>({
    kind: 'idle',
  });

  dirtyKeys = computed(() => {
    const f = this.form();
    const o = this.original();
    const dirty: string[] = [];
    for (const k of Object.keys(f)) {
      if ((f[k] ?? '') !== (o[k] ?? '')) dirty.push(k);
    }
    return dirty;
  });

  dirtyCount = computed(() => this.dirtyKeys().length);

  /** Returns the sections that have at least one populated field on the
   * currently-selected item — used to highlight relevant sections. */
  relevantSectionIds = computed(() => {
    const item = this.selectedItem();
    if (!item) return new Set<string>();
    const ids = new Set<string>();
    for (const section of SECTIONS) {
      if (section.fields.some((f) => (item as any)[f.key] != null)) {
        ids.add(section.id);
      }
    }
    return ids;
  });

  constructor() {
    effect(() => {
      const item = this.selectedItem();
      if (!item) {
        this.form.set({});
        this.original.set({});
        return;
      }
      const next: Record<string, any> = {};
      for (const section of SECTIONS) {
        for (const field of section.fields) {
          const v = (item as any)[field.key];
          if (field.kind === 'boolean') next[field.key as string] = !!v;
          else if (field.kind === 'number') next[field.key as string] = v ?? null;
          else next[field.key as string] = v ?? '';
        }
      }
      this.form.set({ ...next });
      this.original.set({ ...next });
      this.status.set({ kind: 'idle' });
      // Auto-expand sections that have data on this item
      this.expanded.set(new Set(['identity', ...this.relevantSectionIds()]));
    });
  }

  selectItem(className: string): void {
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

  isRelevantSection(id: string): boolean {
    return this.relevantSectionIds().has(id);
  }

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
    const item = this.selectedItem();
    if (!item) return;

    const dirty = this.dirtyKeys();
    if (dirty.length === 0) {
      this.status.set({ kind: 'error', message: 'No changes to save.' });
      return;
    }

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
      } else if (fieldDef?.kind === 'boolean') {
        patch[key] = !!v;
      } else {
        patch[key] = v;
      }
    }

    this.status.set({ kind: 'saving' });
    try {
      await this.admin.patchItem(item.className, patch);
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
}
