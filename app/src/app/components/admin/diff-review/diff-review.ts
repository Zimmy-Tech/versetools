// Diff review — upload a freshly-extracted versedb_data.json and pick
// which changes to apply to the database. Curated edits are flagged
// and default to "rejected" so re-extraction never silently clobbers
// hand-curated values.

import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  AdminService,
  type DiffApply,
  type DiffEntity,
  type DiffResult,
} from '../admin.service';

interface SelectionMap {
  // entityKey "ship:className" → set of selected field names (or '*')
  [entityKey: string]: Set<string>;
}

@Component({
  selector: 'app-diff-review',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './diff-review.html',
  styleUrl: './diff-review.scss',
})
export class DiffReviewComponent {
  private admin = inject(AdminService);

  // Upload state
  uploadedFileName = signal<string | null>(null);
  uploadedJson = signal<any>(null);
  busy = signal(false);
  error = signal<string | null>(null);

  // Diff state
  diff = signal<DiffResult | null>(null);
  selection = signal<SelectionMap>({});

  // Filters
  filterAction = signal<'all' | 'create' | 'modify' | 'delete'>('all');
  filterSource = signal<'all' | 'extracted' | 'curated' | 'new'>('all');
  filterEntityType = signal<'all' | 'ships' | 'items'>('all');
  searchQuery = signal('');

  // Apply state
  applying = signal(false);
  applyResult = signal<string | null>(null);

  // ─── Derived ──────────────────────────────────────────────────────

  visibleShipChanges = computed(() => this.applyFilters(this.diff()?.ships ?? []));
  visibleItemChanges = computed(() => this.applyFilters(this.diff()?.items ?? []));

  totalSelected = computed(() => {
    const sel = this.selection();
    let n = 0;
    for (const k of Object.keys(sel)) n += sel[k].size > 0 ? 1 : 0;
    return n;
  });

  private applyFilters(entities: DiffEntity[]): DiffEntity[] {
    const fa = this.filterAction();
    const fs = this.filterSource();
    const fe = this.filterEntityType();
    const q = this.searchQuery().toLowerCase().trim();
    return entities.filter((e) => {
      if (fa !== 'all' && e.action !== fa) return false;
      if (fs === 'curated' && e.currentSource !== 'curated') return false;
      if (fs === 'extracted' && e.currentSource !== 'extracted') return false;
      if (fs === 'new' && e.action !== 'create') return false;
      if (q && !e.className.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  // ─── Upload + diff ────────────────────────────────────────────────

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.error.set(null);
    this.applyResult.set(null);
    this.uploadedFileName.set(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const json = JSON.parse(reader.result as string);
        this.uploadedJson.set(json);
      } catch (err: any) {
        this.error.set(`Failed to parse JSON: ${err.message}`);
        this.uploadedJson.set(null);
      }
    };
    reader.onerror = () => this.error.set('Failed to read file');
    reader.readAsText(file);
  }

  async runDiff(): Promise<void> {
    const json = this.uploadedJson();
    if (!json) {
      this.error.set('Upload a JSON file first');
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.diff.set(null);
    this.selection.set({});
    try {
      const result = await this.admin.previewDiff(json);
      this.diff.set(result);
      // Pre-select all non-curated modifications + creates by default.
      // Curated rows stay unselected so the admin has to opt in.
      const sel: SelectionMap = {};
      for (const e of result.ships) this.preselect(sel, 'ship', e);
      for (const e of result.items) this.preselect(sel, 'item', e);
      this.selection.set(sel);
    } catch (err: any) {
      this.error.set(err?.error?.error || err?.message || 'Diff failed');
    } finally {
      this.busy.set(false);
    }
  }

  private preselect(sel: SelectionMap, kind: 'ship' | 'item', e: DiffEntity): void {
    if (e.currentSource === 'curated') return; // require explicit opt-in
    if (e.action === 'delete') return; // require explicit opt-in
    const key = `${kind}:${e.className}`;
    sel[key] = new Set(e.action === 'create' ? ['*'] : e.changes.map((c) => c.field));
  }

  // ─── Selection handling ──────────────────────────────────────────

  isFieldSelected(kind: 'ship' | 'item', className: string, field: string): boolean {
    const sel = this.selection()[`${kind}:${className}`];
    if (!sel) return false;
    return sel.has(field) || sel.has('*');
  }

  toggleField(kind: 'ship' | 'item', className: string, field: string): void {
    const key = `${kind}:${className}`;
    this.selection.update((sel) => {
      const next: SelectionMap = { ...sel };
      const cur = next[key] ? new Set(next[key]) : new Set<string>();
      if (cur.has(field)) cur.delete(field);
      else cur.add(field);
      if (cur.size === 0) delete next[key];
      else next[key] = cur;
      return next;
    });
  }

  isEntitySelected(kind: 'ship' | 'item', className: string): 'all' | 'some' | 'none' {
    const sel = this.selection()[`${kind}:${className}`];
    if (!sel || sel.size === 0) return 'none';
    return 'all'; // we don't distinguish partial here for the V1
  }

  toggleEntityAll(kind: 'ship' | 'item', e: DiffEntity): void {
    const key = `${kind}:${e.className}`;
    const cur = this.selection()[key];
    const fields = e.action === 'create' || e.action === 'delete' ? ['*'] : e.changes.map((c) => c.field);
    this.selection.update((sel) => {
      const next: SelectionMap = { ...sel };
      if (cur && cur.size > 0) {
        delete next[key];
      } else {
        next[key] = new Set(fields);
      }
      return next;
    });
  }

  selectAllVisible(): void {
    this.selection.update((sel) => {
      const next: SelectionMap = { ...sel };
      for (const e of this.visibleShipChanges()) {
        next[`ship:${e.className}`] = new Set(
          e.action === 'create' || e.action === 'delete' ? ['*'] : e.changes.map((c) => c.field)
        );
      }
      for (const e of this.visibleItemChanges()) {
        next[`item:${e.className}`] = new Set(
          e.action === 'create' || e.action === 'delete' ? ['*'] : e.changes.map((c) => c.field)
        );
      }
      return next;
    });
  }

  clearAllSelection(): void {
    this.selection.set({});
  }

  // ─── Apply ────────────────────────────────────────────────────────

  async apply(): Promise<void> {
    const diff = this.diff();
    if (!diff) return;
    const sel = this.selection();
    if (Object.keys(sel).length === 0) {
      this.error.set('Nothing selected');
      return;
    }

    const ok = window.confirm(
      `Apply ${this.totalSelected()} entity changes to the database?\n\n` +
        'Modifications and creates are persisted directly. Deletes remove the row. ' +
        'Every change is recorded in the audit log.'
    );
    if (!ok) return;

    const payload: { ships: DiffApply[]; items: DiffApply[]; meta?: any } = { ships: [], items: [] };
    // Always send the uploaded meta blob — extraction metadata (version,
    // counts, etc.) has no curation review, so the API just overwrites it.
    if (this.uploadedJson()?.meta) {
      payload.meta = this.uploadedJson().meta;
    }

    const buildChange = (kind: 'ship' | 'item', e: DiffEntity, uploadedItem: any): DiffApply | null => {
      const fieldsSel = sel[`${kind}:${e.className}`];
      if (!fieldsSel || fieldsSel.size === 0) return null;
      if (e.action === 'create') {
        return { className: e.className, action: 'create', data: uploadedItem };
      }
      if (e.action === 'delete') {
        return { className: e.className, action: 'delete' };
      }
      // modify
      return {
        className: e.className,
        action: 'modify',
        fields: fieldsSel.has('*') ? '*' : Array.from(fieldsSel),
        data: uploadedItem,
      };
    };

    const uploadedShips = (this.uploadedJson()?.ships ?? []) as any[];
    const uploadedItems = (this.uploadedJson()?.items ?? []) as any[];
    const shipsByCls = new Map(uploadedShips.map((s) => [s.className, s]));
    const itemsByCls = new Map(uploadedItems.map((i) => [i.className, i]));

    for (const e of diff.ships) {
      const change = buildChange('ship', e, shipsByCls.get(e.className));
      if (change) payload.ships.push(change);
    }
    for (const e of diff.items) {
      const change = buildChange('item', e, itemsByCls.get(e.className));
      if (change) payload.items.push(change);
    }

    this.applying.set(true);
    this.error.set(null);
    this.applyResult.set(null);
    try {
      const result = await this.admin.applyDiff(payload);
      this.applyResult.set(
        `Applied ${result.applied.ships} ship changes and ${result.applied.items} item changes. Reload the public site to see updates.`
      );
      // Re-diff so the user sees the residual unselected changes
      await this.runDiff();
    } catch (err: any) {
      this.error.set(err?.error?.error || err?.message || 'Apply failed');
    } finally {
      this.applying.set(false);
    }
  }

  // ─── Display helpers ─────────────────────────────────────────────

  formatValue(v: unknown): string {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'object') {
      const s = JSON.stringify(v);
      return s.length > 80 ? s.slice(0, 77) + '…' : s;
    }
    return String(v);
  }
}
