import { Component, signal, computed } from '@angular/core';
import { HttpClient } from '@angular/common/http';

interface ArmorPiece {
  className: string;
  name: string;
  baseName: string;
  setName: string;
  manufacturer: string;
  weight: string;
  slot: string;
  damageReduction: number | null;
  tempMin: number | null;
  tempMax: number | null;
  radiationProtection: number | null;
  radiationScrub: number | null;
  carryingCapacity: number | null;
  variants: string[];
}

@Component({
  selector: 'app-fps-armor',
  standalone: true,
  templateUrl: './fps-armor.html',
  styleUrl: './fps-armor.scss',
})
export class FpsArmorComponent {
  allPieces = signal<ArmorPiece[]>([]);
  loaded = signal(false);

  expandedPiece = signal<string | null>(null);
  weightFilter = signal('');
  slotFilter = signal('');
  setFilter = signal('ADP');

  /** Multi-word set roots that should stay together */
  private readonly COMPOUND_ROOTS = new Set([
    'Star Kitten', 'Dust Devil', 'Geist Armor', 'Carnifex Armor', 'Ace Interceptor',
    'Sol-III', 'Zeus Exploration', 'Field Recon', 'Microid Battle', 'Murray Cup',
    'Mirai Racing', 'Origin Racing', 'Fortuna Racing', 'One Light', 'Second Life',
    'Deep-Space', 'TEST STRING',
  ]);

  private getSetRoot(setName: string): string {
    for (const compound of this.COMPOUND_ROOTS) {
      if (setName.startsWith(compound)) return compound;
    }
    // Use first word as root, but keep hyphenated names together (ADP-mk4 → ADP-mk4)
    return setName.split(/\s+/)[0];
  }

  setRoots = computed(() => {
    const roots = new Set(this.allPieces().map(p => this.getSetRoot(p.setName)));
    return ['', ...Array.from(roots).sort()];
  });
  searchQuery = signal('');
  sortBy = signal<'name' | 'damageReduction' | 'weight' | 'slot'>('name');
  sortDir = signal<'asc' | 'desc'>('asc');

  filtered = computed(() => {
    let list = this.allPieces();
    const weight = this.weightFilter();
    const slot = this.slotFilter();
    const setName = this.setFilter();
    const q = this.searchQuery().toLowerCase();
    const sort = this.sortBy();
    const dir = this.sortDir();

    if (weight) list = list.filter(p => p.weight === weight);
    if (slot) list = list.filter(p => p.slot === slot);
    if (setName) list = list.filter(p => this.getSetRoot(p.setName) === setName);
    if (q) list = list.filter(p => p.name.toLowerCase().includes(q) || p.setName.toLowerCase().includes(q) || p.manufacturer.toLowerCase().includes(q));

    list = [...list].sort((a, b) => {
      switch (sort) {
        case 'name': return dir === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
        case 'damageReduction': return dir === 'asc' ? (a.damageReduction ?? 0) - (b.damageReduction ?? 0) : (b.damageReduction ?? 0) - (a.damageReduction ?? 0);
        case 'weight': {
          const wo: Record<string, number> = { undersuit: 0, light: 1, medium: 2, heavy: 3 };
          return dir === 'asc' ? (wo[a.weight] ?? 0) - (wo[b.weight] ?? 0) : (wo[b.weight] ?? 0) - (wo[a.weight] ?? 0);
        }
        case 'slot': return dir === 'asc' ? a.slot.localeCompare(b.slot) : b.slot.localeCompare(a.slot);
        default: return 0;
      }
    });

    return list;
  });

  constructor(private http: HttpClient) {
    this.http.get<{ armor: ArmorPiece[] }>('live/versedb_fps_armor.json').subscribe(data => {
      this.allPieces.set(data.armor);
      this.loaded.set(true);
    });
  }

  toggleExpand(className: string): void {
    this.expandedPiece.set(this.expandedPiece() === className ? null : className);
  }

  toggleSort(col: 'name' | 'damageReduction' | 'weight' | 'slot'): void {
    if (this.sortBy() === col) {
      this.sortDir.set(this.sortDir() === 'desc' ? 'asc' : 'desc');
    } else {
      this.sortBy.set(col);
      this.sortDir.set(col === 'name' ? 'asc' : 'desc');
    }
  }

  sortIndicator(col: string): string {
    if (this.sortBy() !== col) return '';
    return this.sortDir() === 'desc' ? ' \u25BE' : ' \u25B4';
  }

  weightLabel(w: string): string {
    return w.charAt(0).toUpperCase() + w.slice(1);
  }
}
