import { Component, signal, computed } from '@angular/core';
import { HttpClient } from '@angular/common/http';

interface ArmorPiece {
  className: string;
  name: string;
  setName: string;
  manufacturer: string;
  weight: string;
  slot: string;
  damageReduction: number | null;
  tempMin: number | null;
  tempMax: number | null;
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

  weightFilter = signal('');
  slotFilter = signal('');
  searchQuery = signal('');
  sortBy = signal<'name' | 'damageReduction' | 'weight' | 'slot'>('damageReduction');
  sortDir = signal<'asc' | 'desc'>('desc');

  weights = ['', 'light', 'medium', 'heavy'];
  slots = ['', 'helmet', 'core', 'arms', 'legs', 'backpack', 'undersuit'];

  filtered = computed(() => {
    let list = this.allPieces().filter(p => p.damageReduction != null);
    const weight = this.weightFilter();
    const slot = this.slotFilter();
    const q = this.searchQuery().toLowerCase();
    const sort = this.sortBy();
    const dir = this.sortDir();

    if (weight) list = list.filter(p => p.weight === weight);
    if (slot) list = list.filter(p => p.slot === slot);
    if (q) list = list.filter(p => p.name.toLowerCase().includes(q) || p.setName.toLowerCase().includes(q) || p.manufacturer.toLowerCase().includes(q));

    list = [...list].sort((a, b) => {
      switch (sort) {
        case 'name': return dir === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
        case 'damageReduction': return dir === 'asc' ? (a.damageReduction ?? 0) - (b.damageReduction ?? 0) : (b.damageReduction ?? 0) - (a.damageReduction ?? 0);
        case 'weight': {
          const wo = { light: 0, medium: 1, heavy: 2, undersuit: -1 };
          return dir === 'asc' ? (wo[a.weight as keyof typeof wo] ?? 0) - (wo[b.weight as keyof typeof wo] ?? 0) : (wo[b.weight as keyof typeof wo] ?? 0) - (wo[a.weight as keyof typeof wo] ?? 0);
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

  toggleSort(col: 'name' | 'damageReduction' | 'weight' | 'slot'): void {
    if (this.sortBy() === col) {
      this.sortDir.set(this.sortDir() === 'desc' ? 'asc' : 'desc');
    } else {
      this.sortBy.set(col);
      this.sortDir.set('desc');
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
