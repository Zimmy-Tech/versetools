import { Component, signal, computed } from '@angular/core';
import { DataService } from '../../services/data.service';
import { Item, Hardpoint } from '../../models/db.models';

type CategoryId = 'weapons' | 'shields' | 'power' | 'cooling' | 'quantum' | 'avionics' | 'missiles';

interface SlotEntry {
  hardpoint: Hardpoint;
  slotId: string;
  item: Item | null;
  category: CategoryId;
  label: string;
}

const HP_TYPE_TO_CAT: Record<string, CategoryId> = {
  WeaponGun: 'weapons', WeaponTachyon: 'weapons', Turret: 'weapons', TurretBase: 'weapons',
  Missile: 'missiles', MissileLauncher: 'missiles',
  Shield: 'shields',
  PowerPlant: 'power',
  Cooler: 'cooling',
  QuantumDrive: 'quantum',
  Radar: 'avionics', LifeSupportGenerator: 'avionics',
};

interface BrowserCategory {
  id: CategoryId;
  name: string;
  icon: string;
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

  selectedSlotId = signal<string | null>(null);
  selectedPickerItem = signal<Item | null>(null);
  browserTab = signal<'browse' | 'buy'>('browse');
  pickerSearch = signal('');
  pickerSort = signal<'name' | 'dps' | 'size'>('name');

  categories: BrowserCategory[] = [
    { id: 'weapons', name: 'Weapons', icon: '⚔', expanded: true },
    { id: 'missiles', name: 'Missiles', icon: '◆', expanded: false },
    { id: 'shields', name: 'Shields', icon: '◈', expanded: false },
    { id: 'power', name: 'Power Plants', icon: '⚡', expanded: false },
    { id: 'cooling', name: 'Coolers', icon: '❄', expanded: false },
    { id: 'quantum', name: 'Quantum Drives', icon: '◉', expanded: false },
    { id: 'avionics', name: 'Avionics', icon: '◎', expanded: false },
  ];

  // Map ship hardpoints to categorized slot entries
  slots = computed<SlotEntry[]>(() => {
    const ship = this.data.selectedShip();
    if (!ship) return [];
    const loadout = this.data.loadout();
    const entries: SlotEntry[] = [];

    for (const hp of ship.hardpoints) {
      const cat = HP_TYPE_TO_CAT[hp.type];
      if (!cat) continue;

      // Check if this slot has an equipped item
      const item = loadout[hp.id] ?? null;

      // Clean label
      const label = hp.id.replace(/hardpoint_/g, '').replace(/_/g, ' ');

      entries.push({ hardpoint: hp, slotId: hp.id, item, category: cat, label });
    }

    return entries;
  });

  // Slots filtered by category for the tree browser
  slotsForCategory(catId: CategoryId): SlotEntry[] {
    return this.slots().filter(s => s.category === catId);
  }

  // The currently selected slot entry
  selectedSlot = computed<SlotEntry | null>(() => {
    const id = this.selectedSlotId();
    if (!id) return null;
    return this.slots().find(s => s.slotId === id) ?? null;
  });

  // Picker: items that fit the selected slot
  pickerItems = computed(() => {
    const slot = this.selectedSlot();
    if (!slot) return [];
    const q = this.pickerSearch().toLowerCase();
    const sort = this.pickerSort();

    let items = this.data.getOptionsForSlot(slot.hardpoint);
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

      const label = slotId.split('.').pop()?.replace(/hardpoint_/g, '').replace(/_/g, ' ') ?? slotId;
      entries.push({ slotId, slotLabel: label, item, category });
    }

    const catOrder = ['Weapons', 'Missiles', 'Shields', 'Power', 'Cooling', 'Quantum', 'Avionics', 'Other'];
    entries.sort((a, b) => catOrder.indexOf(a.category) - catOrder.indexOf(b.category));
    return entries;
  });

  // Stats
  totalDps = computed(() => this.equippedItems().filter(e => e.category === 'Weapons').reduce((s, e) => s + (e.item.dps ?? 0), 0));
  totalAlpha = computed(() => this.equippedItems().filter(e => e.category === 'Weapons').reduce((s, e) => s + (e.item.alphaDamage ?? 0), 0));
  totalShieldHp = computed(() => this.equippedItems().filter(e => e.category === 'Shields').reduce((s, e) => s + (e.item.hp ?? 0), 0));
  totalShieldRegen = computed(() => this.equippedItems().filter(e => e.category === 'Shields').reduce((s, e) => s + (e.item.regenRate ?? 0), 0));
  totalPowerOutput = computed(() => this.equippedItems().filter(e => e.category === 'Power').reduce((s, e) => s + (e.item.powerOutput ?? 0), 0));
  totalPowerDraw = computed(() => this.equippedItems().filter(e => e.category !== 'Power').reduce((s, e) => s + (e.item.powerDraw ?? 0), 0));
  totalCooling = computed(() => this.equippedItems().filter(e => e.category === 'Cooling').reduce((s, e) => s + (e.item.coolingRate ?? 0), 0));
  missileCount = computed(() => this.equippedItems().filter(e => e.category === 'Missiles').length);

  // Actions
  selectSlot(slotId: string): void {
    this.selectedSlotId.set(slotId);
    this.pickerSearch.set('');
    this.selectedPickerItem.set(null);
  }

  equipToSlot(item: Item): void {
    const slot = this.selectedSlot();
    if (!slot) return;
    this.data.setLoadoutItem(slot.slotId, item);
  }

  selectPicker(item: Item): void {
    this.selectedPickerItem.set(item);
  }

  toggleCategory(cat: BrowserCategory): void {
    cat.expanded = !cat.expanded;
  }

  primaryStat(item: Item): string {
    if (item.dps) return Math.round(item.dps).toString();
    if (item.hp) return item.hp.toLocaleString();
    if (item.powerOutput) return item.powerOutput.toLocaleString();
    if (item.coolingRate) return Math.round(item.coolingRate).toString();
    if (item.speed) return Math.round(item.speed).toLocaleString() + ' m/s';
    if (item.alphaDamage) return Math.round(item.alphaDamage).toString();
    return '—';
  }

  primaryStatLabel(): string {
    const slot = this.selectedSlot();
    if (!slot) return 'Stat';
    if (slot.category === 'weapons') return 'DPS';
    if (slot.category === 'missiles') return 'DMG';
    if (slot.category === 'shields') return 'HP';
    if (slot.category === 'power') return 'Output';
    if (slot.category === 'cooling') return 'Rate';
    if (slot.category === 'quantum') return 'Speed';
    return 'Stat';
  }

  secondaryStat(item: Item): string {
    if (item.fireRate) return Math.round(item.fireRate) + ' RPM';
    if (item.regenRate) return Math.round(item.regenRate) + '/s';
    if (item.range) return Math.round(item.range * 10) / 10 + ' Gm';
    return '—';
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
