import { Component, signal, computed } from '@angular/core';
import { UpperCasePipe } from '@angular/common';
import { DataService } from '../../services/data.service';
import { Item, Ship } from '../../models/db.models';

interface FinderResult {
  ship: Ship;
  slotId: string;
}

/** Item types surfaced in the finder's search — interchangeable equipment
 *  players actually care about. Excludes mount points (WeaponMount,
 *  Turret, TurretBase), salvage sub-components, and DCB templates whose
 *  display names collide (e.g. 100+ bespoke per-ship "Remote Turret"
 *  records). */
const FINDER_SEARCH_TYPES = new Set([
  'WeaponGun', 'WeaponTachyon',
  'Shield', 'PowerPlant', 'Cooler', 'QuantumDrive', 'Radar',
  'Missile', 'MissileLauncher',
  'TractorBeam', 'WeaponMining', 'Module',
]);

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
      .filter(i => FINDER_SEARCH_TYPES.has(i.type) &&
                   (i.name.toLowerCase().includes(q) ||
                    i.className.toLowerCase().includes(q)))
      .slice(0, 50);
  });

  /** Currently selected item to find. */
  selectedItem = signal<Item | null>(null);

  /** Active type+size filter (e.g. {type:'Shield', size:3}), mutually exclusive with selectedItem. */
  typeFilter = signal<{ type: string; size: number; label: string } | null>(null);

  /** Quick-filter presets for finding ships by component type + size. */
  readonly quickFilters = [
    { type: 'Shield', size: 1, label: 'S1 Shield' },
    { type: 'Shield', size: 3, label: 'S3 Shield' },
    { type: 'WeaponGun', size: 4, label: 'S4 Guns' },
    { type: 'WeaponGun', size: 5, label: 'S5 Guns' },
    { type: 'Missile', size: 3, label: 'S3 Missiles' },
    { type: 'QuantumDrive', size: 2, label: 'S2 Quantum' },
  ];

  /** Ships that have the selected item in their default loadout. */
  results = computed<FinderResult[]>(() => {
    const item = this.selectedItem();
    const filter = this.typeFilter();
    if (!item && !filter) return [];

    const itemsByClass = new Map(this.data.items().map(i => [i.className.toLowerCase(), i]));
    const results: FinderResult[] = [];

    for (const ship of this.data.ships()) {
      const lo = ship.defaultLoadout;
      if (!lo) continue;
      for (const [slotId, itemCls] of Object.entries(lo)) {
        if (item) {
          if (itemCls.toLowerCase() === item.className.toLowerCase()) {
            results.push({ ship, slotId });
          }
        } else if (filter) {
          const equipped = itemsByClass.get(itemCls.toLowerCase());
          if (equipped && equipped.type === filter.type && equipped.size === filter.size) {
            results.push({ ship, slotId });
          }
        }
      }
    }
    return results;
  });

  /** Unique ships (deduped — a ship may have multiple slots with the same item). */
  uniqueShips = computed(() => {
    const seen = new Set<string>();
    const out: Ship[] = [];
    for (const r of this.results()) {
      if (seen.has(r.ship.className)) continue;
      seen.add(r.ship.className);
      out.push(r.ship);
    }
    return out;
  });

  uniqueShipCount = computed(() => this.uniqueShips().length);

  constructor(public data: DataService) {}

  selectItem(item: Item): void {
    this.selectedItem.set(item);
    this.typeFilter.set(null);
  }

  selectQuickFilter(filter: { type: string; size: number; label: string }): void {
    this.typeFilter.set(filter);
    this.selectedItem.set(null);
    this.searchQuery.set('');
  }

  clearSelection(): void {
    this.selectedItem.set(null);
    this.typeFilter.set(null);
    this.searchQuery.set('');
  }

  fmtSlot(slotId: string): string {
    // Clean up slot IDs: "hardpoint_shield_generator_left" -> "Shield Generator Left"
    return slotId
      .replace(/^hardpoint_/, '')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  }
}
