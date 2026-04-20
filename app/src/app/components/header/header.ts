import { Component, signal, computed, HostListener, OnInit, OnDestroy, inject } from '@angular/core';
import { Router, NavigationEnd } from '@angular/router';
import { Subscription } from 'rxjs';
import { filter } from 'rxjs/operators';
import { DataService } from '../../services/data.service';
import { Ship, Item } from '../../models/db.models';
import { LoadoutCompareComponent, StoredLoadout as StoredLoadoutExport } from '../loadout-compare/loadout-compare';
import { AdminService } from '../admin/admin.service';

export type TabName = 'loadout' | 'components' | 'compare' | 'shipCompare' | 'finder' | 'fpsWeapons' | 'fpsArmor' | 'fpsTtk' | 'cart' | 'missions' | 'repBuilder' | 'blueprints' | 'crafting' | 'rankings' | 'qtRange' | 'armor' | 'mining' | 'miningSignatures' | 'miningLasers' | 'miningModules' | 'compact' | 'submit' | 'formulas' | 'updates' | 'changelog' | 'eveStyle' | 'shipShields' | 'shipCoolers' | 'shipWeaponsDb' | 'shipPowerPlants' | 'shipQuantumDrives' | 'shipExplorer';

// Map tab IDs to route paths
const TAB_ROUTES: Record<string, string> = {
  repBuilder: 'rep-builder',
  miningSignatures: 'mining-signatures',
  miningLasers: 'mining-lasers',
  miningModules: 'mining-modules',
  shipExplorer: 'ship-explorer',
  shipCompare: 'ship-compare',
  fpsWeapons: 'fps-weapons',
  fpsArmor: 'fps-armor',
  fpsTtk: 'fps-ttk',
  eveStyle: 'eve-style',
  qtRange: 'qt-range',
  shipShields: 'ship-shields',
  shipCoolers: 'ship-coolers',
  shipWeaponsDb: 'ship-weapons-db',
  shipPowerPlants: 'ship-power-plants',
  shipQuantumDrives: 'ship-quantum-drives',
};

function tabToRoute(id: string): string {
  return TAB_ROUTES[id] ?? id;
}

interface StoredLoadout {
  name: string;
  shipClassName: string;
  shipName: string;
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
  imports: [LoadoutCompareComponent],
  templateUrl: './header.html',
  styleUrl: './header.scss',
})
export class HeaderComponent implements OnInit, OnDestroy {
  private routerSub?: Subscription;
  private _router = inject(Router);
  admin = inject(AdminService);
  currentUrl = signal(this._router.url);
  isMobile = signal(window.innerWidth < 768);
  hamburgerOpen = signal(false);

  /** True when compact route + narrow viewport */
  isMobileCompact = computed(() => this.data.compactMode() && this.isMobile());

  @HostListener('window:resize')
  onResize(): void {
    this.isMobile.set(window.innerWidth < 768);
  }

  ngOnInit(): void {
    this.routerSub = this._router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd)
    ).subscribe(e => {
      this.currentUrl.set(e.urlAfterRedirects);
      this.hamburgerOpen.set(false);
    });
  }

  ngOnDestroy(): void {
    this.routerSub?.unsubscribe();
  }

  readonly shipToolsTabs: { id: TabName; label: string }[] = [
    { id: 'shipExplorer', label: 'Ship Explorer' },
    { id: 'shipCompare', label: 'Ship Comparator' },
    { id: 'rankings', label: 'Flight Performance' },
    { id: 'qtRange', label: 'Quantum Travel Range' },
    { id: 'armor', label: 'Armor Damage' },
    { id: 'compare', label: 'Weapon Performance' },
    { id: 'finder', label: 'Default Loadout Finder' },
    { id: 'shipWeaponsDb', label: 'Ship Weapons' },
    { id: 'shipShields', label: 'Shields' },
    { id: 'shipCoolers', label: 'Coolers' },
    { id: 'shipPowerPlants', label: 'Power Plants' },
    { id: 'shipQuantumDrives', label: 'Quantum Drives' },
    // { id: 'eveStyle', label: 'Eve Style (Pilot)' },  // hidden until ready
  ];

  readonly missionsTabs: { id: TabName; label: string }[] = [
    { id: 'missions', label: 'Contracts' },
    { id: 'repBuilder', label: 'Rep Builder' },
    { id: 'blueprints', label: 'Blueprint Finder' },
  ];

  readonly industryToolsTabs: { id: TabName; label: string }[] = [
    { id: 'mining', label: 'Mining Ore Locations' },
    { id: 'miningSignatures', label: 'Mining Signatures' },
    { id: 'miningLasers', label: 'Mining Lasers' },
    { id: 'miningModules', label: 'Mining Modules' },
    { id: 'crafting', label: 'Crafting' },
  ];

  readonly fpsGearTabs: { id: TabName; label: string }[] = [
    { id: 'fpsWeapons', label: 'FPS Weapons' },
    { id: 'fpsArmor', label: 'FPS Armor' },
    { id: 'fpsTtk', label: 'TTK Calculator' },
  ];

  shipToolsOpen = signal(false);
  missionsOpen = signal(false);
  industryToolsOpen = signal(false);
  fpsGearOpen = signal(false);

  isTabActive(id: string): boolean {
    const path = this.currentUrl().split('?')[0].split('#')[0];
    return path === '/' + tabToRoute(id);
  }

  isShipToolActive = computed(() => { this.currentUrl(); return this.shipToolsTabs.some(t => this.isTabActive(t.id)); });
  isMissionsActive = computed(() => { this.currentUrl(); return this.missionsTabs.some(t => this.isTabActive(t.id)); });
  isIndustryToolActive = computed(() => { this.currentUrl(); return this.industryToolsTabs.some(t => this.isTabActive(t.id)); });
  isFpsGearActive = computed(() => { this.currentUrl(); return this.fpsGearTabs.some(t => this.isTabActive(t.id)); });

  isOnLoadout(): boolean {
    const path = this.currentUrl().split('?')[0].split('#')[0];
    return path === '/' || path === '/loadout';
  }

  // Messages to display based on equipped items in the current loadout
  private readonly ITEM_MESSAGES: Record<string, string> = {};

  loadoutMessages = computed(() => {
    const loadout = this.data.loadout();
    const seen = new Set<string>();
    const messages: string[] = [];
    for (const item of Object.values(loadout)) {
      if (!item) continue;
      const cls = item.className.toLowerCase();
      const msg = this.ITEM_MESSAGES[cls];
      if (msg && !seen.has(cls)) {
        seen.add(cls);
        messages.push(msg);
      }
    }
    return messages;
  });

  private closeAllGroups(): void {
    this.shipToolsOpen.set(false);
    this.missionsOpen.set(false);
    this.industryToolsOpen.set(false);
    this.fpsGearOpen.set(false);
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
  toggleFpsGear(): void {
    const open = !this.fpsGearOpen();
    this.closeAllGroups();
    this.fpsGearOpen.set(open);
  }
  navigateTo(id: string): void {
    this._router.navigate(['/' + tabToRoute(id)]);
    this.closeAllGroups();
    this.hamburgerOpen.set(false);
  }

  /** Logo click — navigate to loadout page. If already there, reset the
   *  loadout state to its initial fresh-load condition (Gladius + defaults). */
  onLogoClick(): void {
    if (this.isOnLoadout()) {
      const gladius = this.data.ships().find(s => s.className === 'aegs_gladius');
      if (gladius) this.data.selectShip(gladius);
    } else {
      this.navigateTo('loadout');
    }
  }

  @HostListener('document:click', ['$event'])
  onDocClick(e: MouseEvent): void {
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
  showCompare = signal(false);

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

  openDropdown(): void  {
    this.showDropdown.set(true);
    // Scroll to the currently selected ship after the dropdown renders
    setTimeout(() => {
      const active = document.querySelector('.ship-picker-dropdown .active') as HTMLElement;
      if (active) active.scrollIntoView({ block: 'center' });
    });
  }
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
    this.data.selectShip(ship);
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

  openCompare(event: Event): void {
    event.stopPropagation();
    this.showCompare.set(true);
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
