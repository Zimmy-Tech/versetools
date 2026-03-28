import { Component, output, input, signal, computed, HostListener, ElementRef } from '@angular/core';
import { DataService } from '../../services/data.service';
import { Ship, Item } from '../../models/db.models';

export type TabName = 'loadout' | 'components' | 'compare' | 'finder' | 'cart' | 'missions' | 'blueprints' | 'crafting' | 'rankings' | 'armor' | 'mining' | 'submit' | 'formulas' | 'updates' | 'changelog';

interface StoredLoadout {
  name: string;
  shipClassName: string;
  shipName: string;
  /** Maps slotId → item className */
  items: Record<string, string>;
  powerAlloc: Record<string, number>;
  weaponsPower: number;
  thrusterPower: number;
  timestamp: number;
  peakDps?: number;
  totalAlpha?: number;
}

const STORAGE_KEY = 'versedb_loadouts';

@Component({
  selector: 'app-header',
  standalone: true,
  templateUrl: './header.html',
  styleUrl: './header.scss',
})
export class HeaderComponent {
  activeTab = input.required<TabName>();
  tabChange = output<TabName>();

  readonly shipToolsTabs: { id: TabName; label: string }[] = [
    { id: 'rankings', label: 'Flight Performance' },
    { id: 'armor', label: 'Armor Damage' },
    { id: 'compare', label: 'Weapon Performance' },
    { id: 'finder', label: 'Default Loadout Finder' },
  ];

  readonly missionsTabs: { id: TabName; label: string }[] = [
    { id: 'missions', label: 'Contracts' },
    { id: 'blueprints', label: 'Blueprint Finder' },
  ];

  readonly industryToolsTabs: { id: TabName; label: string }[] = [
    { id: 'mining', label: 'Mining' },
    { id: 'crafting', label: 'Crafting' },
  ];

  shipToolsOpen = signal(false);
  missionsOpen = signal(false);
  industryToolsOpen = signal(false);

  isShipToolActive = computed(() => this.shipToolsTabs.some(t => t.id === this.activeTab()));
  isMissionsActive = computed(() => this.missionsTabs.some(t => t.id === this.activeTab()));
  isIndustryToolActive = computed(() => this.industryToolsTabs.some(t => t.id === this.activeTab()));

  private closeAllGroups(): void {
    this.shipToolsOpen.set(false);
    this.missionsOpen.set(false);
    this.industryToolsOpen.set(false);
  }
  toggleShipTools(): void {
    const open = !this.shipToolsOpen();
    this.closeAllGroups();
    this.shipToolsOpen.set(open);
  }
  toggleMissions(): void {
    const open = !this.missionsOpen();
    this.closeAllGroups();
    this.missionsOpen.set(open);
  }
  toggleIndustryTools(): void {
    const open = !this.industryToolsOpen();
    this.closeAllGroups();
    this.industryToolsOpen.set(open);
  }
  selectGroupTab(id: TabName): void {
    this.tabChange.emit(id);
    this.closeAllGroups();
  }

  @HostListener('document:click', ['$event'])
  onDocClick(e: MouseEvent): void {
    // Close dropdowns when clicking outside nav-group elements
    const target = e.target as HTMLElement;
    if (!target.closest('.nav-group')) {
      this.closeAllGroups();
    }
  }

  searchQuery  = signal('');
  showDropdown = signal(false);

  // ── Loadout storage ──────────────────────────────────────
  storedLoadouts = signal<StoredLoadout[]>(this.readStorage());
  loadoutDropdownOpen = signal(false);

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

  // ── Loadout storage methods ──────────────────────────────

  private readStorage(): StoredLoadout[] {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    } catch {
      return [];
    }
  }

  private writeStorage(loadouts: StoredLoadout[]): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(loadouts));
    this.storedLoadouts.set(loadouts);
  }

  storeLoadout(): void {
    const ship = this.data.selectedShip();
    if (!ship) return;
    const loadout = this.data.loadout();
    const items: Record<string, string> = {};
    for (const [slotId, item] of Object.entries(loadout)) {
      if (item) items[slotId] = item.className;
    }
    // Compute peak DPS and total alpha from all guns in loadout
    let peakDps = 0;
    let totalAlpha = 0;
    for (const item of Object.values(loadout)) {
      if (item && (item.type === 'WeaponGun' || item.type === 'WeaponTachyon')) {
        peakDps += item.dps ?? 0;
        totalAlpha += item.alphaDamage ?? 0;
      }
    }

    const existing = this.readStorage();
    const name = `${ship.name} #${existing.filter(l => l.shipClassName === ship.className).length + 1}`;
    existing.push({
      name,
      shipClassName: ship.className,
      shipName: ship.name,
      items,
      powerAlloc: { ...this.data.powerAlloc() },
      weaponsPower: this.data.weaponsPower(),
      thrusterPower: this.data.thrusterPower(),
      timestamp: Date.now(),
      peakDps: Math.round(peakDps),
      totalAlpha: Math.round(totalAlpha * 10) / 10,
    });
    this.writeStorage(existing);
  }

  loadStoredLoadout(index: number): void {
    const stored = this.storedLoadouts()[index];
    if (!stored) return;
    const ship = this.data.ships().find(s => s.className === stored.shipClassName);
    if (!ship) return;
    // Select ship first (resets loadout to defaults)
    this.data.selectShip(ship);
    // Rebuild loadout from stored classNames
    const allItems = this.data.items();
    const rebuilt: Record<string, Item> = {};
    for (const [slotId, cls] of Object.entries(stored.items)) {
      const item = allItems.find(i => i.className === cls);
      if (item) rebuilt[slotId] = item;
    }
    this.data.loadout.set(rebuilt);
    this.data.powerAlloc.set(stored.powerAlloc);
    this.data.weaponsPower.set(stored.weaponsPower);
    this.data.thrusterPower.set(stored.thrusterPower);
    this.loadoutDropdownOpen.set(false);
  }

  deleteStoredLoadout(index: number, event: Event): void {
    event.stopPropagation();
    const existing = this.readStorage();
    existing.splice(index, 1);
    this.writeStorage(existing);
  }

  clearStoredLoadouts(): void {
    this.writeStorage([]);
    this.loadoutDropdownOpen.set(false);
  }

  toggleLoadoutDropdown(): void {
    this.storedLoadouts.set(this.readStorage());
    this.loadoutDropdownOpen.set(!this.loadoutDropdownOpen());
  }

  closeLoadoutDropdown(): void {
    setTimeout(() => this.loadoutDropdownOpen.set(false), 150);
  }
}
