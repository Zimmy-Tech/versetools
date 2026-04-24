import { Component, computed, effect, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { DataService } from '../../services/data.service';

/** Minimal mission shape we need — only the fields used for pool
 *  derivation. Matches the Mission interface in missions-view.ts but
 *  kept local to avoid a cross-component import. */
interface MissionLite {
  className: string;
  blueprintRewards?: string[];
}

interface PoolGroup {
  key: string;          // stable sorted-join of blueprint names
  blueprints: string[]; // alphabetical order
  missionCount: number; // how many missions award this pool (UI flavor)
}

/** localStorage key for the acquired-blueprint set. Same convention as
 *  other versetools_* keys in the app (saved loadouts, craft search,
 *  etc.). */
const STORAGE_KEY = 'versetools_bp_checklist';

@Component({
  selector: 'app-bp-checklist',
  standalone: true,
  templateUrl: './bp-checklist.html',
  styleUrl: './bp-checklist.scss',
})
export class BpChecklistComponent {
  loaded = signal(false);
  allMissions = signal<MissionLite[]>([]);
  searchQuery = signal('');

  /** Acquired-blueprint set. Mutated via toggleOwned/setAllOwned and
   *  mirrored to localStorage inside writeStorage() so refreshes,
   *  new tabs, and browser restarts preserve the checklist. */
  owned = signal<ReadonlySet<string>>(this.readStorage());

  constructor(private http: HttpClient, private data: DataService) {
    // DB-first hydration (prod path) mirrors missions-view / blueprint-finder.
    effect(() => {
      const db = this.data.db();
      const contracts = db?.missions as MissionLite[] | undefined;
      if (contracts?.length) {
        this.allMissions.set(contracts);
        this.loaded.set(true);
      }
    });
    // JSON fallback for preview / static host.
    effect(() => {
      const prefix = this.data.dataPrefix();
      this.data.modeVersion(); // track mode changes
      if (this.loaded()) return;
      this.http.get<any>(`${prefix}versedb_missions.json`).subscribe({
        next: (d) => {
          if (this.loaded()) return;
          this.allMissions.set((d.contracts ?? d.missions ?? []) as MissionLite[]);
          this.loaded.set(true);
        },
        error: () => this.loaded.set(true),
      });
    });
  }

  // ── Pool derivation ───────────────────────────────────────────────
  // Group missions by their sorted blueprintRewards tuple. Pools with
  // new blueprints (or entirely new pools) surface automatically on the
  // next data refresh — nothing is hardcoded.
  readonly pools = computed<PoolGroup[]>(() => {
    const groups = new Map<string, { missions: number; blueprints: string[] }>();
    for (const m of this.allMissions()) {
      const bps = m.blueprintRewards ?? [];
      if (!bps.length) continue;
      const key = [...bps].sort().join('|');
      const g = groups.get(key);
      if (g) g.missions++;
      else groups.set(key, { missions: 1, blueprints: [...bps].sort() });
    }
    const out: PoolGroup[] = [];
    for (const [key, g] of groups) {
      out.push({ key, blueprints: g.blueprints, missionCount: g.missions });
    }
    // Bigger pools first (most content), ties broken by first blueprint
    // name. Keeps visual ordering stable across data updates.
    out.sort((a, b) => b.blueprints.length - a.blueprints.length
      || a.blueprints[0].localeCompare(b.blueprints[0]));
    return out;
  });

  /** Pools filtered by the search query — matches ANY blueprint name in
   *  the pool (case-insensitive substring). Empty query → all pools. */
  readonly filteredPools = computed(() => {
    const q = this.searchQuery().trim().toLowerCase();
    const all = this.pools();
    if (!q) return all;
    return all.filter(p => p.blueprints.some(bp => bp.toLowerCase().includes(q)));
  });

  /** Flat set of every unique blueprint across every pool. Used for the
   *  overall progress counter; also the authoritative membership check
   *  if we ever need to prune owned entries that CIG removed. */
  readonly allBlueprints = computed<string[]>(() => {
    const seen = new Set<string>();
    for (const p of this.pools()) for (const bp of p.blueprints) seen.add(bp);
    return [...seen].sort();
  });

  readonly totalOwned = computed(() => {
    // Only count blueprints that still exist in the current data set —
    // so a CIG-removed blueprint lingering in localStorage doesn't
    // inflate the total.
    const active = new Set(this.allBlueprints());
    return [...this.owned()].filter(bp => active.has(bp)).length;
  });

  readonly totalAll = computed(() => this.allBlueprints().length);

  readonly percentOwned = computed(() => {
    const total = this.totalAll();
    return total === 0 ? 0 : Math.round((this.totalOwned() / total) * 100);
  });

  // Per-pool owned count (used on the pool card header).
  ownedInPool(p: PoolGroup): number {
    const o = this.owned();
    let n = 0;
    for (const bp of p.blueprints) if (o.has(bp)) n++;
    return n;
  }

  // ── Mutations ─────────────────────────────────────────────────────
  toggleOwned(bp: string): void {
    const next = new Set(this.owned());
    if (next.has(bp)) next.delete(bp);
    else next.add(bp);
    this.owned.set(next);
    this.writeStorage(next);
  }

  setPoolOwned(p: PoolGroup, checked: boolean): void {
    const next = new Set(this.owned());
    for (const bp of p.blueprints) {
      if (checked) next.add(bp);
      else next.delete(bp);
    }
    this.owned.set(next);
    this.writeStorage(next);
  }

  clearAll(): void {
    if (!confirm('Clear every checked blueprint? This cannot be undone.')) return;
    this.owned.set(new Set());
    this.writeStorage(new Set());
  }

  bpMatches(bp: string): boolean {
    const q = this.searchQuery().trim().toLowerCase();
    return q.length > 0 && bp.toLowerCase().includes(q);
  }

  // ── Export ────────────────────────────────────────────────────────
  // Two formats: Markdown (best for Discord / forum sharing — renders
  // as a live checklist with pool headers) and CSV (best for
  // spreadsheet tracking). Both are generated entirely client-side
  // from current state; nothing leaves the browser unless the user
  // saves the downloaded file.
  exportMenuOpen = signal(false);

  toggleExportMenu(): void { this.exportMenuOpen.set(!this.exportMenuOpen()); }

  private todayStr(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  private poolLabel(p: PoolGroup): string {
    const first = p.blueprints[0];
    const extra = p.blueprints.length - 1;
    return extra > 0 ? `${first} +${extra}` : first;
  }

  private triggerDownload(filename: string, content: string, mime: string): void {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    this.exportMenuOpen.set(false);
  }

  exportMarkdown(): void {
    const o = this.owned();
    const lines: string[] = [];
    lines.push('# VerseTools Blueprint Checklist');
    lines.push(`Generated: ${this.todayStr()}`);
    lines.push(`Progress: ${this.totalOwned()} / ${this.totalAll()} (${this.percentOwned()}%)`);
    lines.push('');
    for (const p of this.pools()) {
      const n = this.ownedInPool(p);
      lines.push(`## ${this.poolLabel(p)}  (${n} / ${p.blueprints.length} acquired)`);
      for (const bp of p.blueprints) {
        lines.push(`- [${o.has(bp) ? 'x' : ' '}] ${bp}`);
      }
      lines.push('');
    }
    this.triggerDownload(
      `versetools-blueprint-checklist-${this.todayStr()}.md`,
      lines.join('\n'),
      'text/markdown'
    );
  }

  exportCsv(): void {
    const o = this.owned();
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const lines: string[] = ['Pool,Blueprint,Acquired'];
    for (const p of this.pools()) {
      const label = this.poolLabel(p);
      for (const bp of p.blueprints) {
        lines.push(`${esc(label)},${esc(bp)},${o.has(bp) ? 'Yes' : 'No'}`);
      }
    }
    this.triggerDownload(
      `versetools-blueprint-checklist-${this.todayStr()}.csv`,
      lines.join('\n'),
      'text/csv'
    );
  }

  // ── Import ────────────────────────────────────────────────────────
  // Safety posture: whitelist-filtered against allBlueprints() so only
  // names the current data knows about are ever applied. Anything else
  // is silently discarded — makes the import surface effectively
  // tamper-proof (malicious content can't become state because the
  // matcher won't let it). 500 KB size cap prevents storage-quota
  // griefing. Preview modal shows exactly what will change before
  // anything touches localStorage.
  private readonly MAX_IMPORT_SIZE = 500 * 1024; // 500 KB

  /** Parsed-and-filtered staging area. The preview counts derive from
   *  this + current mode, so flipping Replace/Merge updates live. */
  importStaged = signal<{ checked: Set<string>; unmatched: number; filename: string } | null>(null);
  importMergeMode = signal<'replace' | 'merge'>('replace');

  readonly importPreview = computed(() => {
    const staged = this.importStaged();
    if (!staged) return null;
    const current = this.owned();
    const mode = this.importMergeMode();
    const incoming = staged.checked;
    const added = [...incoming].filter(bp => !current.has(bp)).sort();
    const removed = mode === 'replace'
      ? [...current].filter(bp => !incoming.has(bp)).sort()
      : [];
    return { added, removed, unmatched: staged.unmatched, filename: staged.filename };
  });

  onImportFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > this.MAX_IMPORT_SIZE) {
      alert(`File too large (${Math.round(file.size / 1024)} KB). Max is ${Math.round(this.MAX_IMPORT_SIZE / 1024)} KB.`);
      input.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      this.stageImport(text, file.name);
      input.value = ''; // allow re-import of same file
    };
    reader.onerror = () => {
      alert('Failed to read file.');
      input.value = '';
    };
    reader.readAsText(file);
  }

  private stageImport(text: string, filename: string): void {
    const isCsv = /\.csv$/i.test(filename);
    const parsed = isCsv ? this.parseCsvChecked(text) : this.parseMarkdownChecked(text);
    const known = new Set(this.allBlueprints());
    const valid = new Set(parsed.filter(bp => known.has(bp)));
    const unmatched = parsed.length - valid.size;
    this.importStaged.set({ checked: valid, unmatched, filename });
  }

  applyImport(): void {
    const preview = this.importPreview();
    if (!preview) return;
    const next = new Set(this.owned());
    for (const bp of preview.added) next.add(bp);
    for (const bp of preview.removed) next.delete(bp);
    this.owned.set(next);
    this.writeStorage(next);
    this.importStaged.set(null);
  }

  cancelImport(): void { this.importStaged.set(null); }

  setMergeMode(mode: 'replace' | 'merge'): void { this.importMergeMode.set(mode); }

  /** Pull `- [x] Name` lines out of a Markdown file. Unchecked rows
   *  (`- [ ]`) are intentionally ignored — only names marked acquired
   *  are returned. */
  private parseMarkdownChecked(text: string): string[] {
    const out: string[] = [];
    const re = /^\s*-\s*\[([xX\s])\]\s+(.+?)\s*$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const checked = m[1].toLowerCase() === 'x';
      const name = m[2].trim();
      if (checked && name) out.push(name);
    }
    return out;
  }

  /** Parse a CSV with columns including `Blueprint` and `Acquired`
   *  (case-insensitive). Acquired accepts Yes/Y/True/1/X as checked,
   *  everything else as unchecked. Column order doesn't matter. */
  private parseCsvChecked(text: string): string[] {
    const rows = this.csvRows(text);
    if (rows.length < 2) return [];
    const header = rows[0].map(h => h.toLowerCase().trim());
    const bpIdx = header.indexOf('blueprint');
    const acqIdx = header.indexOf('acquired');
    if (bpIdx < 0 || acqIdx < 0) return [];
    const truthy = new Set(['yes', 'y', 'true', '1', 'x']);
    const out: string[] = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const name = (r[bpIdx] ?? '').trim();
      const acq = (r[acqIdx] ?? '').toLowerCase().trim();
      if (truthy.has(acq) && name) out.push(name);
    }
    return out;
  }

  /** Minimal CSV row splitter handling double-quoted fields with `""`
   *  escape. Not a full RFC 4180 parser, but covers what Excel /
   *  Sheets / our own exporter emit. */
  private csvRows(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else {
          field += c;
        }
      } else {
        if (c === '"') inQuotes = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
        else if (c === '\r') { /* skip CR */ }
        else field += c;
      }
    }
    if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
    return rows;
  }

  // ── localStorage plumbing ─────────────────────────────────────────
  private readStorage(): ReadonlySet<string> {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return new Set();
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return new Set();
      return new Set(arr.filter((x): x is string => typeof x === 'string'));
    } catch {
      return new Set();
    }
  }

  private writeStorage(s: ReadonlySet<string>): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...s]));
    } catch (e) {
      // Quota exceeded or storage disabled (incognito in some browsers).
      // Nothing actionable from here — the in-memory signal is still
      // authoritative for the current session.
      console.warn('[bp-checklist] localStorage write failed:', e);
    }
  }
}
