import { Component, signal, computed } from '@angular/core';
import { DataService } from '../../services/data.service';
import { Item, Hardpoint } from '../../models/db.models';

type CategoryId = 'weapons' | 'shields' | 'power' | 'cooling' | 'quantum' | 'avionics' | 'missiles';

interface BrowserCategory {
  id: CategoryId;
  name: string;
  icon: string;
  types: string[];  // Item types to filter
  expanded: boolean;
}

@Component({
  selector: 'app-eve-style',
  standalone: true,
  templateUrl: './eve-style.html',
  styleUrl: './eve-style.scss',
})
export class EveStyleComponent {
  constructor(public data: DataService) {}

  selectedCategory = signal<CategoryId>('weapons');
  selectedPickerItem = signal<Item | null>(null);
  browserTab = signal<'browse' | 'buy'>('browse');
  pickerSearch = signal('');
  pickerSort = signal<'name' | 'dps' | 'size'>('name');

  categories: BrowserCategory[] = [
    { id: 'weapons', name: 'Weapons', icon: '⚔', types: ['WeaponGun', 'WeaponTachyon'], expanded: true },
    { id: 'missiles', name: 'Missiles', icon: '◆', types: ['Missile'], expanded: false },
    { id: 'shields', name: 'Shields', icon: '◈', types: ['Shield'], expanded: false },
    { id: 'power', name: 'Power Plants', icon: '⚡', types: ['PowerPlant'], expanded: false },
    { id: 'cooling', name: 'Coolers', icon: '❄', types: ['Cooler'], expanded: false },
    { id: 'quantum', name: 'Quantum Drives', icon: '◉', types: ['QuantumDrive'], expanded: false },
    { id: 'avionics', name: 'Avionics', icon: '◎', types: ['Radar', 'LifeSupportGenerator'], expanded: false },
  ];

  // Count items per category from live data
  categoryCount(cat: BrowserCategory): number {
    return this.data.items().filter(i => cat.types.includes(i.type)).length;
  }

  // Picker: items filtered by selected category, search, and sorted
  pickerItems = computed(() => {
    const cat = this.categories.find(c => c.id === this.selectedCategory());
    if (!cat) return [];
    const q = this.pickerSearch().toLowerCase();
    const sort = this.pickerSort();

    let items = this.data.items().filter(i => cat.types.includes(i.type));
    if (q) {
      items = items.filter(i =>
        (i.name ?? '').toLowerCase().includes(q) ||
        (i.manufacturer ?? '').toLowerCase().includes(q)
      );
    }

    items.sort((a, b) => {
      if (sort === 'dps') return (b.dps ?? 0) - (a.dps ?? 0);
      if (sort === 'size') return (b.size ?? 0) - (a.size ?? 0);
      return (a.name ?? '').localeCompare(b.name ?? '');
    });

    return items;
  });

  // Equipped items from the current loadout, grouped by category
  equippedItems = computed(() => {
    const loadout = this.data.loadout();
    const entries: { slotId: string; slotLabel: string; item: Item; category: string }[] = [];

    for (const [slotId, item] of Object.entries(loadout)) {
      if (!item) continue;
      let category = 'Other';
      if (item.type === 'WeaponGun' || item.type === 'WeaponTachyon') category = 'Weapons';
      else if (item.type === 'Missile') category = 'Missiles';
      else if (item.type === 'Shield') category = 'Shields';
      else if (item.type === 'PowerPlant') category = 'Power';
      else if (item.type === 'Cooler') category = 'Cooling';
      else if (item.type === 'QuantumDrive') category = 'Quantum';
      else if (item.type === 'Radar' || item.type === 'LifeSupportGenerator') category = 'Avionics';

      // Clean up slot label
      const label = slotId.split('.').pop()?.replace(/hardpoint_/g, '').replace(/_/g, ' ') ?? slotId;

      entries.push({ slotId, slotLabel: label, item, category });
    }

    // Sort: weapons first, then by category, then by slot
    const catOrder = ['Weapons', 'Missiles', 'Shields', 'Power', 'Cooling', 'Quantum', 'Avionics', 'Other'];
    entries.sort((a, b) => catOrder.indexOf(a.category) - catOrder.indexOf(b.category));

    return entries;
  });

  // Stats computed from equipped items
  totalDps = computed(() => {
    return this.equippedItems()
      .filter(e => e.category === 'Weapons')
      .reduce((sum, e) => sum + (e.item.dps ?? 0), 0);
  });

  totalAlpha = computed(() => {
    return this.equippedItems()
      .filter(e => e.category === 'Weapons')
      .reduce((sum, e) => sum + (e.item.alphaDamage ?? 0), 0);
  });

  totalShieldHp = computed(() => {
    return this.equippedItems()
      .filter(e => e.category === 'Shields')
      .reduce((sum, e) => sum + (e.item.hp ?? 0), 0);
  });

  totalShieldRegen = computed(() => {
    return this.equippedItems()
      .filter(e => e.category === 'Shields')
      .reduce((sum, e) => sum + (e.item.regenRate ?? 0), 0);
  });

  totalPowerOutput = computed(() => {
    return this.equippedItems()
      .filter(e => e.category === 'Power')
      .reduce((sum, e) => sum + (e.item.powerOutput ?? 0), 0);
  });

  totalPowerDraw = computed(() => {
    return this.equippedItems()
      .filter(e => e.category !== 'Power')
      .reduce((sum, e) => sum + (e.item.powerDraw ?? 0), 0);
  });

  totalCooling = computed(() => {
    return this.equippedItems()
      .filter(e => e.category === 'Cooling')
      .reduce((sum, e) => sum + (e.item.coolingRate ?? 0), 0);
  });

  missileCount = computed(() => {
    return this.equippedItems().filter(e => e.category === 'Missiles').length;
  });

  // Get the primary stat for a picker item (depends on category)
  primaryStat(item: Item): string {
    if (item.dps) return Math.round(item.dps).toString();
    if (item.hp) return item.hp.toLocaleString();
    if (item.powerOutput) return item.powerOutput.toLocaleString();
    if (item.coolingRate) return Math.round(item.coolingRate).toString();
    if (item.speed) return Math.round(item.speed).toLocaleString() + ' m/s';
    return '—';
  }

  primaryStatLabel(): string {
    const cat = this.selectedCategory();
    if (cat === 'weapons') return 'DPS';
    if (cat === 'missiles') return 'DMG';
    if (cat === 'shields') return 'HP';
    if (cat === 'power') return 'Output';
    if (cat === 'cooling') return 'Rate';
    if (cat === 'quantum') return 'Speed';
    return 'Stat';
  }

  secondaryStat(item: Item): string {
    if (item.fireRate) return Math.round(item.fireRate) + ' RPM';
    if (item.regenRate) return Math.round(item.regenRate) + '/s';
    if (item.range) return Math.round(item.range * 10) / 10 + ' Gm';
    return '—';
  }

  // Equip: double-click an item in the picker to add it to a matching slot
  equipItem(item: Item): void {
    const ship = this.data.selectedShip();
    if (!ship) return;

    // Find a matching hardpoint for this item type
    for (const hp of ship.hardpoints) {
      if (item.size && item.size >= (hp.minSize ?? 0) && item.size <= (hp.maxSize ?? 99)) {
        const options = this.data.getOptionsForSlot(hp);
        if (options.some(o => o.className === item.className)) {
          this.data.setLoadoutItem(hp.id, item);
          return;
        }
      }
    }
  }

  selectPicker(item: Item): void {
    this.selectedPickerItem.set(item);
  }

  toggleCategory(cat: BrowserCategory): void {
    cat.expanded = !cat.expanded;
  }

  selectCategory(id: CategoryId): void {
    this.selectedCategory.set(id);
    this.pickerSearch.set('');
  }

  fmt(n: number | undefined, digits = 0): string {
    if (n == null) return '—';
    return n.toLocaleString('en-US', { maximumFractionDigits: digits });
  }

  shops = [
    { name: 'Centermass', location: 'Area 18', price: '12,400 UEC' },
    { name: 'Centermass', location: 'New Babbage', price: '12,400 UEC' },
    { name: 'Dumper\'s Depot', location: 'Port Olisar', price: '11,800 UEC' },
    { name: 'Platinum Bay', location: 'Grim HEX', price: '13,100 UEC' },
    { name: 'Omega Pro', location: 'Lorville', price: '12,200 UEC' },
    { name: 'Cousin Crow\'s', location: 'Orison', price: '12,600 UEC' },
  ];
}
