// Hardpoint editor — edit a ship's hardpoint definitions and the
// default loadout map. Hardpoints are a flat array of objects; the
// loadout is a flat map of dotted keys → item className. Sub-slots
// (e.g. "hardpoint_pilot.radar_helper") show up only in the loadout
// map, not in the hardpoints array, and come from items' subPorts.
//
// V1 scope:
//   - Edit existing hardpoint fields (label, type, sizes, flags, etc.)
//   - Change the equipped item on any loadout slot via a typeahead
//   - Save the entire hardpoints array + loadout via PATCH
//
// Out of scope for V1 (follow-up):
//   - Add / delete hardpoints
//   - Drag-drop reorder
//   - Recursive sub-port expansion when changing the parent item

import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DataService } from '../../../services/data.service';
import { AdminService } from '../admin.service';
import type { Item, Ship } from '../../../models/db.models';

interface Hardpoint {
  id: string;
  label?: string;
  type?: string;
  subtypes?: string;
  minSize?: number;
  maxSize?: number;
  flags?: string;
  controllerTag?: string;
  portTags?: string;
  allTypes?: { type: string; subtypes?: string }[];
}

interface LoadoutSlot {
  /** Full dotted loadout key */
  key: string;
  /** True if this is a top-level hardpoint (matches a hardpoint id) */
  isPrimary: boolean;
  /** Parent hardpoint id (the part before the first dot) */
  parentId: string;
  /** Currently equipped item className, or null */
  itemClassName: string | null;
}

@Component({
  selector: 'app-hardpoint-editor',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './hardpoint-editor.html',
  styleUrl: './hardpoint-editor.scss',
})
export class HardpointEditorComponent {
  private data = inject(DataService);
  private admin = inject(AdminService);

  // ─── Ship picker state ────────────────────────────────────────────

  ships = computed(() => {
    const all = this.data.db()?.ships ?? [];
    return [...all].sort((a, b) =>
      (a.name || a.className).localeCompare(b.name || b.className)
    );
  });

  shipSearch = signal('');
  filteredShips = computed(() => {
    const q = this.shipSearch().toLowerCase().trim();
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

  // ─── Working copy of hardpoints + loadout ────────────────────────

  /** Mutable working copy. Pristine until first edit. */
  workingHardpoints = signal<Hardpoint[]>([]);
  workingLoadout = signal<Record<string, string>>({});

  /** Original snapshot used to compute dirty state and reset. */
  originalHardpoints = signal<Hardpoint[]>([]);
  originalLoadout = signal<Record<string, string>>({});

  /** Which hardpoint cards are expanded for editing. */
  expandedIds = signal<Set<string>>(new Set());

  /** Which loadout slots have an open item picker. */
  pickerOpenForKey = signal<string | null>(null);
  pickerSearch = signal('');

  status = signal<{ kind: 'idle' | 'saving' | 'success' | 'error'; message?: string }>({
    kind: 'idle',
  });

  isDirty = computed(() => {
    return (
      JSON.stringify(this.workingHardpoints()) !== JSON.stringify(this.originalHardpoints()) ||
      JSON.stringify(this.workingLoadout()) !== JSON.stringify(this.originalLoadout())
    );
  });

  constructor() {
    effect(() => {
      const ship = this.selectedShip();
      if (!ship) {
        this.workingHardpoints.set([]);
        this.workingLoadout.set({});
        this.originalHardpoints.set([]);
        this.originalLoadout.set({});
        this.expandedIds.set(new Set());
        return;
      }
      const hp = JSON.parse(JSON.stringify(ship.hardpoints ?? [])) as Hardpoint[];
      const lo = JSON.parse(JSON.stringify(ship.defaultLoadout ?? {})) as Record<string, string>;
      this.workingHardpoints.set(hp);
      this.workingLoadout.set(lo);
      this.originalHardpoints.set(JSON.parse(JSON.stringify(hp)));
      this.originalLoadout.set(JSON.parse(JSON.stringify(lo)));
      this.expandedIds.set(new Set());
      this.pickerOpenForKey.set(null);
      this.status.set({ kind: 'idle' });
    });
  }

  // ─── Loadout slot grouping ──────────────────────────────────────

  /** Returns the loadout slots grouped under each top-level hardpoint id. */
  slotsForHardpoint(hpId: string): LoadoutSlot[] {
    const lo = this.workingLoadout();
    const out: LoadoutSlot[] = [];
    for (const key of Object.keys(lo)) {
      if (key === hpId || key.startsWith(hpId + '.')) {
        out.push({
          key,
          isPrimary: key === hpId,
          parentId: hpId,
          itemClassName: lo[key] ?? null,
        });
      }
    }
    // Primary first, then sub-slots alphabetical
    out.sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      return a.key.localeCompare(b.key);
    });
    return out;
  }

  /** Slots that don't belong to any top-level hardpoint id (orphans/standalone). */
  orphanSlots = computed<LoadoutSlot[]>(() => {
    const hpIds = new Set(this.workingHardpoints().map((h) => h.id));
    const lo = this.workingLoadout();
    const out: LoadoutSlot[] = [];
    for (const key of Object.keys(lo)) {
      const parentId = key.split('.')[0];
      if (!hpIds.has(parentId)) {
        out.push({
          key,
          isPrimary: !key.includes('.'),
          parentId,
          itemClassName: lo[key] ?? null,
        });
      }
    }
    out.sort((a, b) => a.key.localeCompare(b.key));
    return out;
  });

  // ─── Hardpoint editing ──────────────────────────────────────────

  toggleExpanded(id: string): void {
    this.expandedIds.update((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  isExpanded(id: string): boolean {
    return this.expandedIds().has(id);
  }

  expandAll(): void {
    this.expandedIds.set(new Set(this.workingHardpoints().map((h) => h.id)));
  }

  collapseAll(): void {
    this.expandedIds.set(new Set());
  }

  updateHardpointField(idx: number, key: keyof Hardpoint, value: any): void {
    this.workingHardpoints.update((arr) => {
      const next = [...arr];
      next[idx] = { ...next[idx], [key]: value };
      return next;
    });
  }

  /** Template helper: coerce text input to number-or-null. */
  toNum(value: any): number | null {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isNaN(n) ? null : n;
  }

  // ─── Add / remove hardpoints (working copy only — Save persists) ──

  addHardpoint(): void {
    const id = window.prompt(
      'New hardpoint ID (used as the unique key, e.g. "hardpoint_weapon_nose")'
    );
    if (!id) return;
    const trimmed = id.trim();
    if (!trimmed) return;
    if (this.workingHardpoints().some((h) => h.id === trimmed)) {
      window.alert(`Hardpoint "${trimmed}" already exists.`);
      return;
    }
    const newHp: Hardpoint = {
      id: trimmed,
      label: '',
      type: '',
      subtypes: '',
      minSize: 1,
      maxSize: 1,
      flags: '',
      controllerTag: '',
      portTags: '',
      allTypes: [],
    };
    this.workingHardpoints.update((arr) => [...arr, newHp]);
    this.expandedIds.update((s) => {
      const next = new Set(s);
      next.add(trimmed);
      return next;
    });
  }

  removeHardpoint(idx: number, $event: MouseEvent): void {
    $event.stopPropagation();
    const hp = this.workingHardpoints()[idx];
    if (!hp) return;
    const ok = window.confirm(
      `Remove hardpoint "${hp.id}" from this ship?\n\n` +
        `Any loadout entries that reference it will also be cleared. ` +
        `Nothing is saved to the database until you click Save Changes.`
    );
    if (!ok) return;

    this.workingHardpoints.update((arr) => arr.filter((_, i) => i !== idx));
    this.workingLoadout.update((lo) => {
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(lo)) {
        if (k !== hp.id && !k.startsWith(hp.id + '.')) {
          next[k] = v;
        }
      }
      return next;
    });
    this.expandedIds.update((s) => {
      const next = new Set(s);
      next.delete(hp.id);
      return next;
    });
  }

  isHardpointDirty(idx: number): boolean {
    const orig = this.originalHardpoints()[idx];
    const cur = this.workingHardpoints()[idx];
    if (!orig || !cur) return false;
    return JSON.stringify(orig) !== JSON.stringify(cur);
  }

  // ─── Loadout editing ────────────────────────────────────────────

  openPicker(key: string): void {
    this.pickerOpenForKey.set(key);
    this.pickerSearch.set('');
  }

  closePicker(): void {
    this.pickerOpenForKey.set(null);
  }

  selectItemForSlot(key: string, itemClassName: string): void {
    this.workingLoadout.update((lo) => ({ ...lo, [key]: itemClassName }));
    this.closePicker();
  }

  clearSlot(key: string): void {
    this.workingLoadout.update((lo) => {
      const next = { ...lo };
      delete next[key];
      return next;
    });
  }

  isSlotDirty(key: string): boolean {
    return (this.originalLoadout()[key] ?? null) !== (this.workingLoadout()[key] ?? null);
  }

  /** Returns items compatible with the given hardpoint, or all items if no hardpoint. */
  compatibleItems(hardpointId: string | null): Item[] {
    const all = this.data.db()?.items ?? [];
    const q = this.pickerSearch().toLowerCase().trim();

    let filtered = all;
    if (hardpointId) {
      const hp = this.workingHardpoints().find((h) => h.id === hardpointId);
      if (hp) {
        const types = new Set<string>();
        if (hp.type) types.add(hp.type.toLowerCase());
        if (hp.allTypes) hp.allTypes.forEach((t) => t.type && types.add(t.type.toLowerCase()));
        if (types.size > 0) {
          filtered = filtered.filter((i) => i.type && types.has(i.type.toLowerCase()));
        }
        if (hp.minSize != null && hp.maxSize != null) {
          filtered = filtered.filter(
            (i) => i.size != null && i.size >= hp.minSize! && i.size <= hp.maxSize!
          );
        }
      }
    }

    if (q) {
      filtered = filtered.filter(
        (i) =>
          (i.name || '').toLowerCase().includes(q) ||
          i.className.toLowerCase().includes(q) ||
          (i.manufacturer || '').toLowerCase().includes(q)
      );
    }

    return filtered.slice(0, 200); // cap to keep DOM small
  }

  /** Item lookup by className for displaying current equip. */
  getItemByClassName(cls: string | null): Item | null {
    if (!cls) return null;
    return (this.data.db()?.items ?? []).find((i) => i.className === cls) ?? null;
  }

  // ─── Save / reset ───────────────────────────────────────────────

  reset(): void {
    this.workingHardpoints.set(JSON.parse(JSON.stringify(this.originalHardpoints())));
    this.workingLoadout.set(JSON.parse(JSON.stringify(this.originalLoadout())));
    this.status.set({ kind: 'idle' });
  }

  async save(): Promise<void> {
    const ship = this.selectedShip();
    if (!ship) return;

    if (!this.isDirty()) {
      this.status.set({ kind: 'error', message: 'No changes to save.' });
      return;
    }

    const patch: Record<string, unknown> = {};
    if (
      JSON.stringify(this.workingHardpoints()) !== JSON.stringify(this.originalHardpoints())
    ) {
      patch['hardpoints'] = this.workingHardpoints();
    }
    if (
      JSON.stringify(this.workingLoadout()) !== JSON.stringify(this.originalLoadout())
    ) {
      patch['defaultLoadout'] = this.workingLoadout();
    }

    this.status.set({ kind: 'saving' });
    try {
      await this.admin.patchShip(ship.className, patch);
      this.originalHardpoints.set(JSON.parse(JSON.stringify(this.workingHardpoints())));
      this.originalLoadout.set(JSON.parse(JSON.stringify(this.workingLoadout())));
      this.status.set({
        kind: 'success',
        message: 'Saved. Reload the public site to see updates.',
      });
    } catch (err: any) {
      const msg = err?.error?.error || err?.message || 'Save failed';
      this.status.set({ kind: 'error', message: msg });
    }
  }
}
