import { Component, signal, computed } from '@angular/core';
import { DataService } from '../../services/data.service';
import { Item } from '../../models/db.models';

@Component({
  selector: 'app-components-view',
  standalone: true,
  templateUrl: './components-view.html',
  styleUrl: './components-view.scss',
})
export class ComponentsViewComponent {
  typeFilter  = signal('');
  sizeFilter  = signal('');
  searchQuery = signal('');

  filteredItems = computed(() => {
    const type   = this.typeFilter();
    const size   = this.sizeFilter();
    const search = this.searchQuery().toLowerCase();

    return this.data.items()
      .filter(i => {
        if (type && i.type !== type) return false;
        if (size && String(i.size) !== size) return false;
        if (search && !i.name.toLowerCase().includes(search) &&
            !i.manufacturer?.toLowerCase().includes(search)) return false;
        if (i.type === 'WeaponGun' && !type && (i.alphaDamage ?? 0) === 0) return false;
        return true;
      })
      .slice(0, 200);
  });

  readonly typeOptions = [
    { value: '', label: 'All' },
    { value: 'WeaponGun', label: 'Weapons' },
    { value: 'Shield', label: 'Shields' },
    { value: 'PowerPlant', label: 'Power Plants' },
    { value: 'Cooler', label: 'Coolers' },
    { value: 'QuantumDrive', label: 'Quantum Drives' },
  ];

  readonly sizeOptions = ['', '1', '2', '3', '4', '5', '6'];

  constructor(public data: DataService) {}

  typeLabel(type: string): string {
    return ({
      WeaponGun: 'WEAPON', WeaponTachyon: 'TACHYON', WeaponMining: 'MINING',
      Shield: 'SHIELD', PowerPlant: 'POWER', Cooler: 'COOLER', QuantumDrive: 'Q-DRIVE',
    } as Record<string, string>)[type] ?? type;
  }

  primaryDmgColor(item: Item): string {
    const dmg = item.damage ?? {};
    const entry = Object.entries(dmg).find(([, v]) => v > 0);
    if (!entry) return 'var(--text)';
    return ({ physical: 'var(--phys)', energy: 'var(--enrg)', distortion: 'var(--dist)', thermal: 'var(--therm)' } as Record<string, string>)[entry[0]] ?? 'var(--text)';
  }

  trackByClass(_: number, item: Item): string { return item.className; }
}
