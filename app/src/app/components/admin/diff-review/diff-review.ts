// Diff review — upload a freshly-extracted build payload and pick which
// changes to apply to the database. Curated rows default to "rejected"
// so re-extraction never silently clobbers hand-curated values.
//
// Handles five streams through one component: ships + items (from
// versedb_data.json) and the FPS triplet (fpsItems / fpsGear / fpsArmor
// from versedb_fps*.json). All five commit atomically — the backend
// wraps every stream's changes in a single Postgres transaction.

import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  AdminService,
  DIFF_STREAMS,
  type DiffApply,
  type DiffEntity,
  type DiffResult,
  type DiffStreamKind,
} from '../admin.service';

interface SelectionMap {
  // entityKey "kind:className" → set of selected field names (or '*'),
  // where kind is one of DIFF_STREAMS[].kind (ship / item / fpsItem / …).
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

  readonly streams = DIFF_STREAMS;

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
  filterEntityType = signal<'all' | DiffStreamKind>('all');
  searchQuery = signal('');

  // Apply state
  applying = signal(false);
  applyResult = signal<string | null>(null);

  // ─── Derived ──────────────────────────────────────────────────────

  /** Per-stream visible change list. Keyed by stream.kind so the
   *  template can pull the right list for each section in one lookup. */
  visibleByStream = computed<Record<DiffStreamKind, DiffEntity[]>>(() => {
    const d = this.diff();
    const out: any = {};
    for (const s of this.streams) {
      out[s.kind] = this.applyFilters(s.kind, d ? (d as any)[s.payloadKey] ?? [] : []);
    }
    return out;
  });

  /** True when the current entity-type filter hides a stream. The template
   *  uses this to skip rendering the section entirely when irrelevant. */
  showStream(kind: DiffStreamKind): boolean {
    const f = this.filterEntityType();
    return f === 'all' || f === kind;
  }

  /** Per-stream change count from the stats blob. Server emits keys of
   *  the form <payloadKey>Changes (e.g. fpsItemsChanges) from the loop,
   *  plus legacy singular aliases shipChanges / itemChanges. */
  countForStream(kind: DiffStreamKind): number {
    const d = this.diff();
    if (!d) return 0;
    const stats = d.stats as Record<string, number | undefined>;
    const stream = this.streams.find((s) => s.kind === kind);
    if (!stream) return 0;
    return stats[`${stream.payloadKey}Changes`] ?? 0;
  }

  totalSelected = computed(() => {
    const sel = this.selection();
    let n = 0;
    for (const k of Object.keys(sel)) n += sel[k].size > 0 ? 1 : 0;
    return n;
  });

  /** Total visible changes across every stream — drives the empty state. */
  totalVisible = computed(() => {
    const vs = this.visibleByStream();
    let n = 0;
    for (const s of this.streams) n += (vs as any)[s.kind].length;
    return n;
  });

  private applyFilters(kind: DiffStreamKind, entities: DiffEntity[]): DiffEntity[] {
    const fa = this.filterAction();
    const fs = this.filterSource();
    const fe = this.filterEntityType();
    const q = this.searchQuery().toLowerCase().trim();
    if (fe !== 'all' && fe !== kind) return [];
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
      for (const s of this.streams) {
        for (const e of (result as any)[s.payloadKey] ?? []) {
          this.preselect(sel, s.kind, e);
        }
      }
      this.selection.set(sel);
    } catch (err: any) {
      this.error.set(err?.error?.error || err?.message || 'Diff failed');
    } finally {
      this.busy.set(false);
    }
  }

  private preselect(sel: SelectionMap, kind: DiffStreamKind, e: DiffEntity): void {
    if (e.currentSource === 'curated') return; // require explicit opt-in
    if (e.action === 'delete') return;         // require explicit opt-in
    const key = `${kind}:${e.className}`;
    sel[key] = new Set(e.action === 'create' ? ['*'] : e.changes.map((c) => c.field));
  }

  // ─── Selection handling ──────────────────────────────────────────

  isFieldSelected(kind: DiffStreamKind, className: string, field: string): boolean {
    const sel = this.selection()[`${kind}:${className}`];
    if (!sel) return false;
    return sel.has(field) || sel.has('*');
  }

  toggleField(kind: DiffStreamKind, className: string, field: string): void {
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

  isEntitySelected(kind: DiffStreamKind, className: string): 'all' | 'some' | 'none' {
    const sel = this.selection()[`${kind}:${className}`];
    if (!sel || sel.size === 0) return 'none';
    return 'all'; // partial-selection distinction not exposed in v1
  }

  toggleEntityAll(kind: DiffStreamKind, e: DiffEntity): void {
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
      const vs = this.visibleByStream();
      for (const s of this.streams) {
        for (const e of (vs as any)[s.kind]) {
          next[`${s.kind}:${e.className}`] = new Set(
            e.action === 'create' || e.action === 'delete' ? ['*'] : e.changes.map((c: any) => c.field)
          );
        }
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
    const nothingSelected = this.totalSelected() === 0;

    const confirmMsg = nothingSelected
      ? 'No entity changes selected. Record this build in the changelog and update the version metadata without modifying any rows?'
      : `Apply ${this.totalSelected()} entity changes to the database?\n\n` +
        'Every stream (ships, items, FPS triplet) commits atomically inside a single transaction. ' +
        'Modifications and creates are persisted directly. Deletes remove the row. ' +
        'Every change is recorded in the audit log.';
    const ok = window.confirm(confirmMsg);
    if (!ok) return;

    // Build the payload by walking the stream registry. Each stream
    // pulls its change list from the diff, maps to DiffApply shape,
    // and attaches the full uploaded array under `full*` so the
    // changelog recorder gets build-accurate totals.
    const payload: any = {};
    const uploaded = this.uploadedJson();
    if (uploaded?.meta) payload.meta = uploaded.meta;
    // Missions reference data (factions, ladders, givers, etc.) rides
    // alongside as a singleton blob — same wholesale-overwrite semantics
    // as `meta`. Only sent when the caller supplied it.
    if (uploaded?.missionRefs) payload.missionRefs = uploaded.missionRefs;

    for (const s of this.streams) {
      const uploadedArr = (uploaded?.[s.payloadKey] ?? []) as any[];
      const byCls = new Map(uploadedArr.map((x) => [x.className, x]));
      const changes: DiffApply[] = [];
      for (const e of (diff as any)[s.payloadKey] ?? []) {
        const change = this.buildChange(s.kind, e, byCls.get(e.className), sel);
        if (change) changes.push(change);
      }
      payload[s.payloadKey] = changes;
      if (Array.isArray(uploadedArr) && uploadedArr.length > 0) {
        payload[s.fullKey] = uploadedArr;
      }
    }

    this.applying.set(true);
    this.error.set(null);
    this.applyResult.set(null);
    try {
      const result = await this.admin.applyDiff(payload);
      const app = result.applied;
      const parts: string[] = [];
      if (app.ships)    parts.push(`${app.ships} ship${app.ships === 1 ? '' : 's'}`);
      if (app.items)    parts.push(`${app.items} item${app.items === 1 ? '' : 's'}`);
      if (app.fpsItems) parts.push(`${app.fpsItems} FPS item${app.fpsItems === 1 ? '' : 's'}`);
      if (app.fpsGear)  parts.push(`${app.fpsGear} FPS gear`);
      if (app.fpsArmor) parts.push(`${app.fpsArmor} FPS armor`);
      if (app.missions) parts.push(`${app.missions} mission${app.missions === 1 ? '' : 's'}`);
      if (app.missionRefs) parts.push('mission refs updated');
      this.applyResult.set(
        parts.length > 0
          ? `Applied: ${parts.join(', ')}. Reload the public site to see updates.`
          : 'Build recorded with no entity changes.'
      );
      // Re-diff so the user sees the residual unselected changes
      await this.runDiff();
    } catch (err: any) {
      this.error.set(err?.error?.error || err?.message || 'Apply failed');
    } finally {
      this.applying.set(false);
    }
  }

  private buildChange(kind: DiffStreamKind, e: DiffEntity, uploadedItem: any, sel: SelectionMap): DiffApply | null {
    const fieldsSel = sel[`${kind}:${e.className}`];
    if (!fieldsSel || fieldsSel.size === 0) return null;
    if (e.action === 'create') {
      return { className: e.className, action: 'create', data: uploadedItem };
    }
    if (e.action === 'delete') {
      return { className: e.className, action: 'delete' };
    }
    return {
      className: e.className,
      action: 'modify',
      fields: fieldsSel.has('*') ? '*' : Array.from(fieldsSel),
      data: uploadedItem,
    };
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
