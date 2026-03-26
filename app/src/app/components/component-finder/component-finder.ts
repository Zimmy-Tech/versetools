import { Component, signal, computed } from '@angular/core';
import { UpperCasePipe } from '@angular/common';
import { DataService } from '../../services/data.service';
import { Item, Ship } from '../../models/db.models';

interface FinderResult {
  ship: Ship;
  slotId: string;
}

@Component({
  selector: 'app-component-finder',
  standalone: true,
  imports: [UpperCasePipe],
  templateUrl: './component-finder.html',
  styleUrl: './component-finder.scss',
})
export class ComponentFinderComponent {
  searchQuery = signal('');

  /** All items that match the search query. */
  matchedItems = computed(() => {
    const q = this.searchQuery().toLowerCase().trim();
    if (q.length < 2) return [];
    return this.data.items()
      .filter(i => i.name.toLowerCase().includes(q) ||
                   i.className.toLowerCase().includes(q))
      .slice(0, 50);
  });

  /** Currently selected item to find. */
  selectedItem = signal<Item | null>(null);

  /** Ships that have the selected item in their default loadout. */
  results = computed<FinderResult[]>(() => {
    const item = this.selectedItem();
    if (!item) return [];
    const cls = item.className.toLowerCase();
    const results: FinderResult[] = [];
    for (const ship of this.data.ships()) {
      const lo = ship.defaultLoadout;
      if (!lo) continue;
      for (const [slotId, itemCls] of Object.entries(lo)) {
        if (itemCls.toLowerCase() === cls) {
          results.push({ ship, slotId });
        }
      }
    }
    return results;
  });

  /** Unique ships count (a ship may have multiple slots with the same item). */
  uniqueShipCount = computed(() => {
    return new Set(this.results().map(r => r.ship.className)).size;
  });

  constructor(public data: DataService) {}

  selectItem(item: Item): void {
    this.selectedItem.set(item);
  }

  fmtSlot(slotId: string): string {
    // Clean up slot IDs: "hardpoint_shield_generator_left" -> "Shield Generator Left"
    return slotId
      .replace(/^hardpoint_/, '')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  }
}
