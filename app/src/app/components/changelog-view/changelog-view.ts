import { Component, signal, computed, effect } from '@angular/core';
import { HttpClient } from '@angular/common/http';

interface FieldDiff {
  field: string;
  old: number | string | null;
  new: number | string | null;
  pct?: number;
}

interface ChangeEntry {
  category: string;
  className: string;
  name: string;
  fields: FieldDiff[];
}

interface AddRemoveEntry {
  category: string;
  className: string;
  name: string;
}

interface ChangelogEntry {
  channel?: string;
  fromVersion: string;
  toVersion: string;
  date: string;
  changes: ChangeEntry[];
  added: AddRemoveEntry[];
  removed: AddRemoveEntry[];
}

interface ChangelogData {
  meta: { generatedAt: string; entries: number };
  changelog: ChangelogEntry[];
}

const CATEGORY_ORDER = [
  'ship',
  'weapon', 'turret', 'weapon_mount',
  'shield', 'powerplant', 'cooler', 'quantumdrive',
  'radar', 'flight_controller', 'jumpdrive', 'life_support',
  'qig', 'emp', 'module',
  'missile', 'missilelauncher',
  'tractor',
  'mining_laser', 'mining_modifier',
  'salvage', 'salvage_modifier', 'tool',
  'fps_weapon', 'fps_magazine', 'fps_attachment', 'fps_gear', 'fps_armor',
  'mission', 'mission_refs',
  'metadata',
];
const CATEGORY_LABELS: Record<string, string> = {
  ship: 'Ships',
  weapon: 'Ship Weapons',
  turret: 'Turrets',
  weapon_mount: 'Weapon Mounts',
  shield: 'Shields',
  powerplant: 'Power Plants',
  cooler: 'Coolers',
  quantumdrive: 'Quantum Drives',
  radar: 'Radar',
  flight_controller: 'Flight Controllers',
  jumpdrive: 'Jump Drives',
  life_support: 'Life Support',
  qig: 'QED Generators',
  emp: 'EMPs',
  module: 'Modules',
  missile: 'Missiles',
  missilelauncher: 'Missile Racks',
  tractor: 'Tractor Beams',
  mining_laser: 'Mining Lasers',
  mining_modifier: 'Mining Modules',
  salvage: 'Salvage Heads',
  salvage_modifier: 'Salvage Modules',
  tool: 'Tools',
  fps_weapon: 'FPS Weapons',
  fps_magazine: 'FPS Magazines',
  fps_attachment: 'FPS Attachments',
  fps_gear: 'FPS Gear',
  fps_armor: 'FPS Armor',
  mission: 'Missions',
  mission_refs: 'Mission Reference Data',
  metadata: 'Extractor Notes',
};

@Component({
  selector: 'app-changelog-view',
  standalone: true,
  templateUrl: './changelog-view.html',
  styleUrl: './changelog-view.scss',
})
export class ChangelogViewComponent {
  entries = signal<ChangelogEntry[]>([]);
  loaded = signal(false);

  /** Indices of entries that are currently expanded. The newest entry
   *  (index 0) is expanded by default. */
  expanded = signal<Set<number>>(new Set([0]));

  toggleExpand(idx: number): void {
    this.expanded.update((s) => {
      const next = new Set(s);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  isExpanded(idx: number): boolean {
    return this.expanded().has(idx);
  }

  expandAll(): void {
    this.expanded.set(new Set(this.entries().map((_, i) => i)));
  }

  collapseAll(): void {
    this.expanded.set(new Set());
  }

  groupedChangesFor(entry: ChangelogEntry): { category: string; label: string; items: ChangeEntry[] }[] {
    const groups: Record<string, ChangeEntry[]> = {};
    for (const c of entry.changes || []) {
      (groups[c.category] ??= []).push(c);
    }
    return CATEGORY_ORDER
      .filter(cat => groups[cat]?.length)
      .map(cat => ({ category: cat, label: CATEGORY_LABELS[cat] ?? cat, items: groups[cat] }));
  }

  groupedAddedFor(entry: ChangelogEntry): { label: string; items: AddRemoveEntry[] }[] {
    if (!entry?.added?.length) return [];
    const groups: Record<string, AddRemoveEntry[]> = {};
    for (const a of entry.added) (groups[a.category] ??= []).push(a);
    return CATEGORY_ORDER
      .filter(cat => groups[cat]?.length)
      .map(cat => ({ label: CATEGORY_LABELS[cat] ?? cat, items: groups[cat] }));
  }

  groupedRemovedFor(entry: ChangelogEntry): { label: string; items: AddRemoveEntry[] }[] {
    if (!entry?.removed?.length) return [];
    const groups: Record<string, AddRemoveEntry[]> = {};
    for (const r of entry.removed) (groups[r.category] ??= []).push(r);
    return CATEGORY_ORDER
      .filter(cat => groups[cat]?.length)
      .map(cat => ({ label: CATEGORY_LABELS[cat] ?? cat, items: groups[cat] }));
  }

  totalChangesFor(entry: ChangelogEntry): number {
    return (entry.changes?.length ?? 0) + (entry.added?.length ?? 0) + (entry.removed?.length ?? 0);
  }

  channelLabel(c: string | undefined): string {
    if (!c) return '';
    return c.toUpperCase();
  }

  fmtDate(d: string): string {
    if (!d) return '';
    try {
      return new Date(d).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return d;
    }
  }

  constructor(private http: HttpClient) {
    // Single unified changelog file at the public root — not per-mode.
    // The Changelog tab is global; toggling LIVE/PTU does not change
    // its content. Each entry carries a `channel` field which is
    // surfaced as a pill in the header.
    this.http.get<ChangelogData>('versedb_changelog.json').subscribe({
      next: (d) => { this.entries.set(d.changelog ?? []); this.loaded.set(true); },
      error: () => this.loaded.set(true),
    });
  }

  fmtVal(v: number | string | null | undefined): string {
    if (v == null) return '—';
    if (typeof v === 'number') return v % 1 === 0 ? v.toString() : v.toFixed(2);
    return v;
  }

  fmtPct(p: number | undefined): string {
    if (p == null) return '';
    const sign = p > 0 ? '+' : '';
    return `${sign}${p.toFixed(p % 1 === 0 ? 0 : 1)}%`;
  }

  isNerfed(d: FieldDiff): boolean {
    if (d.old == null || d.new == null) return false;
    if (typeof d.old === 'number' && typeof d.new === 'number') return d.new < d.old;
    return false;
  }

  isBuffed(d: FieldDiff): boolean {
    if (d.old == null || d.new == null) return false;
    if (typeof d.old === 'number' && typeof d.new === 'number') return d.new > d.old;
    return false;
  }

  fmtField(field: string): string {
    return field
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, s => s.toUpperCase())
      .replace('Dps', 'DPS')
      .replace('Hp', 'HP')
      .replace('Em ', 'EM ')
      .replace('Ir ', 'IR ')
      .replace('Cs ', 'CS ')
      .replace('Qd ', 'QD ')
      .replace('Scm', 'SCM')
      .trim();
  }
}
