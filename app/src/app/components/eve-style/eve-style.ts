import { Component, signal } from '@angular/core';

interface SlotCategory {
  name: string;
  icon: string;
  items: { name: string; size: number; count?: number }[];
  expanded?: boolean;
}

interface PickerItem {
  name: string;
  manufacturer: string;
  size: number;
  grade: string;
  dps?: number;
  shieldHp?: number;
  power?: number;
  cooling?: number;
  stat1?: { label: string; value: string };
  stat2?: { label: string; value: string };
}

interface EquippedItem {
  slot: string;
  name: string;
  size: number;
  category: string;
  dps?: number;
  hp?: number;
  power?: number;
}

@Component({
  selector: 'app-eve-style',
  standalone: true,
  templateUrl: './eve-style.html',
  styleUrl: './eve-style.scss',
})
export class EveStyleComponent {
  selectedCategory = signal('Weapons');
  selectedEquipped = signal<EquippedItem | null>(null);
  browserTab = signal<'browse' | 'buy'>('browse');

  shops = [
    { name: 'Centermass', location: 'Area 18', price: '12,400 UEC' },
    { name: 'Centermass', location: 'New Babbage', price: '12,400 UEC' },
    { name: 'Dumper\'s Depot', location: 'Port Olisar', price: '11,800 UEC' },
    { name: 'Platinum Bay', location: 'Grim HEX', price: '13,100 UEC' },
    { name: 'Omega Pro', location: 'Lorville', price: '12,200 UEC' },
    { name: 'Cousin Crow\'s', location: 'Orison', price: '12,600 UEC' },
  ];

  categories: SlotCategory[] = [
    {
      name: 'Weapons', icon: '⚔', expanded: true,
      items: [
        { name: 'WeaponGun', size: 3, count: 38 },
        { name: 'WeaponTachyon', size: 3, count: 4 },
        { name: 'Missiles', size: 2, count: 12 },
      ]
    },
    {
      name: 'Shields', icon: '◈',
      items: [
        { name: 'Shield Generator', size: 1, count: 72 },
      ]
    },
    {
      name: 'Power', icon: '⚡',
      items: [
        { name: 'Power Plant', size: 1, count: 82 },
      ]
    },
    {
      name: 'Cooling', icon: '❄',
      items: [
        { name: 'Cooler', size: 1, count: 34 },
      ]
    },
    {
      name: 'Quantum', icon: '◉',
      items: [
        { name: 'Quantum Drive', size: 1, count: 28 },
      ]
    },
    {
      name: 'Avionics', icon: '◎',
      items: [
        { name: 'Radar', size: 1, count: 8 },
        { name: 'Life Support', size: 1, count: 6 },
      ]
    },
  ];

  pickerItems: PickerItem[] = [
    { name: 'CF-337 Panther', manufacturer: 'Behring', size: 3, grade: 'A', dps: 264, stat1: { label: 'RPM', value: '700' }, stat2: { label: 'Range', value: '4,200m' } },
    { name: 'CF-227 Badger', manufacturer: 'Behring', size: 2, grade: 'A', dps: 176, stat1: { label: 'RPM', value: '700' }, stat2: { label: 'Range', value: '3,800m' } },
    { name: 'M5A Laser', manufacturer: 'Behring', size: 3, grade: 'A', dps: 248, stat1: { label: 'RPM', value: '260' }, stat2: { label: 'Range', value: '4,800m' } },
    { name: 'Revenant Gatling', manufacturer: 'Behring', size: 3, grade: 'A', dps: 312, stat1: { label: 'RPM', value: '1400' }, stat2: { label: 'Range', value: '3,200m' } },
    { name: 'NN-13 Neutron', manufacturer: 'Amon & Reese', size: 3, grade: 'B', dps: 289, stat1: { label: 'RPM', value: '280' }, stat2: { label: 'Range', value: '3,600m' } },
    { name: 'SW16BR2 Sawbuck', manufacturer: 'Behring', size: 2, grade: 'A', dps: 198, stat1: { label: 'RPM', value: '550' }, stat2: { label: 'Range', value: '3,400m' } },
    { name: 'Mantis GT-220', manufacturer: 'Gallenson', size: 2, grade: 'A', dps: 221, stat1: { label: 'RPM', value: '1200' }, stat2: { label: 'Range', value: '2,800m' } },
    { name: 'Attrition-3', manufacturer: 'Hurston', size: 3, grade: 'B', dps: 256, stat1: { label: 'RPM', value: '500' }, stat2: { label: 'Range', value: '4,000m' } },
  ];

  equipped: EquippedItem[] = [
    { slot: 'Weapon 1', name: 'CF-337 Panther', size: 3, category: 'Weapons', dps: 264 },
    { slot: 'Weapon 2', name: 'CF-337 Panther', size: 3, category: 'Weapons', dps: 264 },
    { slot: 'Weapon 3', name: 'CF-337 Panther', size: 3, category: 'Weapons', dps: 264 },
    { slot: 'Shield', name: 'FR-66 Shield', size: 1, category: 'Shields', hp: 4200 },
    { slot: 'Shield 2', name: 'FR-66 Shield', size: 1, category: 'Shields', hp: 4200 },
    { slot: 'Power Plant', name: 'Torus', size: 1, category: 'Power', power: 4500 },
    { slot: 'Cooler 1', name: 'Bracer', size: 1, category: 'Cooling' },
    { slot: 'Cooler 2', name: 'Bracer', size: 1, category: 'Cooling' },
    { slot: 'QD', name: 'VK-00', size: 1, category: 'Quantum' },
    { slot: 'Radar', name: 'Beacon', size: 1, category: 'Avionics' },
  ];

  toggleCategory(cat: SlotCategory): void {
    cat.expanded = !cat.expanded;
  }

  selectCategory(name: string): void {
    this.selectedCategory.set(name);
  }

  selectEquipped(item: EquippedItem): void {
    this.selectedEquipped.set(item);
  }
}
