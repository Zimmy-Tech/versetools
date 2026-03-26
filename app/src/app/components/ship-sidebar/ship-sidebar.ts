import { Component, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DataService } from '../../services/data.service';
import { Ship } from '../../models/db.models';

@Component({
  selector: 'app-ship-sidebar',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './ship-sidebar.html',
  styleUrl: './ship-sidebar.scss',
})
export class ShipSidebarComponent {
  searchQuery = signal('');
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

  select(ship: Ship): void {
    this.data.selectShip(ship);
    this.searchQuery.set('');
    this.showDropdown.set(false);
  }

  onSearch(value: string): void {
    this.searchQuery.set(value);
    this.showDropdown.set(true);
  }

  open(): void { this.showDropdown.set(true); }

  close(): void {
    // Delay so mousedown on an option fires before blur hides the dropdown
    setTimeout(() => this.showDropdown.set(false), 150);
  }
}
