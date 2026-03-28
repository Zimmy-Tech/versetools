import { Component, signal, computed } from '@angular/core';
import { DataService } from '../../services/data.service';
import { Ship, Item } from '../../models/db.models';

type DmgType = 'physical' | 'energy';
type ShipSize = '' | 'small' | 'medium' | 'large' | 'capital';

interface ShipRow {
  ship: Ship;
  deflect: number;
  deflected: boolean;
}

@Component({
  selector: 'app-armor-view',
  standalone: true,
  templateUrl: './armor-view.html',
  styleUrl: './armor-view.scss',
})
export class ArmorViewComponent {
  dmgType = signal<DmgType>('physical');
  selectedWeapon = signal('');
  shipSize = signal<ShipSize>('');
  readonly shipSizeOptions: { value: ShipSize; label: string }[] = [
    { value: '', label: 'Alpha Range' },
    { value: 'small', label: 'Small' },
    { value: 'medium', label: 'Medium' },
    { value: 'large', label: 'Large' },
    { value: 'capital', label: 'Capital' },
  ];

  constructor(public data: DataService) {}

  weapons = computed(() =>
    this.data.items()
      .filter(i => i.type === 'WeaponGun' && i.damage && (i.damage[this.dmgType()] ?? 0) >= 1 && !i.name.includes('PLACEHOLDER'))
      .sort((a, b) => (a.size ?? 0) - (b.size ?? 0) || (a.damage![this.dmgType()] ?? 0) - (b.damage![this.dmgType()] ?? 0))
  );

  activeWeapon = computed(() => {
    const cls = this.selectedWeapon();
    return cls ? this.data.items().find(i => i.className === cls) ?? null : null;
  });

  nearbyShips = computed<ShipRow[]>(() => {
    const weapon = this.activeWeapon();
    if (!weapon?.damage) return [];
    const dt = this.dmgType();
    const alpha = weapon.damage[dt] ?? 0;
    const deflectKey = dt === 'physical' ? 'armorDeflectPhys' : 'armorDeflectEnrg';

    const sizeFilter = this.shipSize();
    const ships = this.data.ships()
      .filter(s => ((s as any)[deflectKey] ?? 0) > 0)
      .filter(s => !sizeFilter || s.size === sizeFilter)
      .map(s => {
        const deflect = (s as any)[deflectKey] as number;
        return { ship: s, deflect, deflected: alpha <= deflect, dist: Math.abs(alpha - deflect) };
      });

    const sizeActive = this.shipSize();
    if (sizeActive) {
      // Show all ships in the size class, sorted by deflect descending
      return ships
        .sort((a, b) => b.deflect - a.deflect)
        .map(s => ({ ship: s.ship, deflect: s.deflect, deflected: s.deflected }));
    }

    // No size filter: show 3 closest above and 3 closest below
    const above = ships
      .filter(s => s.deflected)
      .sort((a, b) => a.deflect - b.deflect)
      .slice(0, 3);

    const below = ships
      .filter(s => !s.deflected)
      .sort((a, b) => b.deflect - a.deflect)
      .slice(0, 3);

    return [
      ...below.map(s => ({ ship: s.ship, deflect: s.deflect, deflected: false })),
      ...above.map(s => ({ ship: s.ship, deflect: s.deflect, deflected: true })),
    ];
  });
}
