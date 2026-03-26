import { Component, output, input, signal, computed } from '@angular/core';
import { DataService } from '../../services/data.service';
import { Ship } from '../../models/db.models';

export type TabName = 'loadout' | 'components' | 'compare' | 'finder' | 'cart' | 'missions' | 'crafting' | 'rankings' | 'armor' | 'submit' | 'changelog';

@Component({
  selector: 'app-header',
  standalone: true,
  templateUrl: './header.html',
  styleUrl: './header.scss',
})
export class HeaderComponent {
  activeTab = input.required<TabName>();
  tabChange = output<TabName>();

  readonly tabs: { id: TabName; label: string }[] = [
    { id: 'loadout', label: 'Loadout' },
    { id: 'cart', label: 'Cart' },
    { id: 'components', label: 'Components' },
    { id: 'compare', label: 'Compare' },
    { id: 'finder', label: 'Default Finder' },
    { id: 'missions', label: 'Missions' },
    { id: 'crafting', label: 'Crafting' },
    { id: 'rankings', label: 'Flight Performance' },
    { id: 'armor', label: 'Armor Damage' },
    { id: 'submit', label: 'Submit Data' },
    { id: 'changelog', label: 'Changelog' },
  ];

  // All tabs except 'loadout' — rendered after the ship picker
  readonly nonLoadoutTabs = this.tabs.filter(t => t.id !== 'loadout');

  searchQuery  = signal('');
  showDropdown = signal(false);

  filteredShips = computed(() => {
    const q = this.searchQuery().toLowerCase();
    const ships = this.data.ships();
    const filtered = q
      ? ships.filter(s => s.name.toLowerCase().includes(q) || s.manufacturer.toLowerCase().includes(q))
      : ships;
    return [...filtered].sort((a, b) => a.name.localeCompare(b.name));
  });

  constructor(public data: DataService) {}

  selectShip(ship: Ship): void {
    this.data.selectShip(ship);
    this.searchQuery.set('');
    this.showDropdown.set(false);
  }

  onSearch(value: string): void {
    this.searchQuery.set(value);
    this.showDropdown.set(true);
  }

  openDropdown(): void  { this.showDropdown.set(true); }
  closeDropdown(): void { setTimeout(() => this.showDropdown.set(false), 150); }

  toggleDataMode(): void {
    this.data.switchMode(this.data.dataMode() === 'live' ? 'ptu' : 'live');
  }
}
