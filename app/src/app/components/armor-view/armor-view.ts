import { Component, signal, computed, effect } from '@angular/core';
import { DataService } from '../../services/data.service';
import { Ship, Item } from '../../models/db.models';

type DmgType = 'physical' | 'energy';
type ShipSize = '' | 'small' | 'medium' | 'large' | 'capital';

interface ShipRow {
  ship: Ship;
  deflect: number;
  deflected: boolean;
  effectiveAlpha?: number;
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
  shieldsUp = signal(false);
  wpSearch = signal('');
  wpOpen = signal(false);
  readonly shipSizeOptions: { value: ShipSize; label: string }[] = [
    { value: '', label: 'Alpha Range' },
    { value: 'small', label: 'Small' },
    { value: 'medium', label: 'Medium' },
    { value: 'large', label: 'Large' },
    { value: 'capital', label: 'Capital' },
  ];

  constructor(public data: DataService) {
    // Auto-select a default weapon once data loads
    effect(() => {
      const wpns = this.weapons();
      if (wpns.length > 0 && !this.selectedWeapon()) {
        // Pick an S3 weapon as a good default, or first available
        const s3 = wpns.find(w => (w.size ?? 0) === 3);
        this.selectedWeapon.set((s3 ?? wpns[0]).className);
      }
    });
  }

  weapons = computed(() =>
    this.data.items()
      .filter(i => i.type === 'WeaponGun' && i.damage && (i.damage[this.dmgType()] ?? 0) >= 1 && !i.name.includes('PLACEHOLDER'))
      .sort((a, b) => (a.size ?? 0) - (b.size ?? 0) || (a.damage![this.dmgType()] ?? 0) - (b.damage![this.dmgType()] ?? 0))
  );

  filteredWeapons = computed(() => {
    const q = this.wpSearch().toLowerCase();
    const wpns = this.weapons();
    if (!q) return wpns;
    return wpns.filter(w =>
      (w.name ?? '').toLowerCase().includes(q) ||
      (w.manufacturer ?? '').toLowerCase().includes(q)
    );
  });

  selectWeapon(className: string): void {
    this.selectedWeapon.set(className);
    this.wpSearch.set('');
    this.wpOpen.set(false);
  }

  wpClose(): void {
    setTimeout(() => this.wpOpen.set(false), 150);
  }

  activeWeapon = computed(() => {
    const cls = this.selectedWeapon();
    return cls ? this.data.items().find(i => i.className === cls) ?? null : null;
  });

  /** Get the default shield absorption for a ship (max power, averaged across shields). */
  private getShieldAbsorption(ship: Ship, dmgType: DmgType): number {
    const dl = ship.defaultLoadout;
    if (!dl) return 0;
    const items = this.data.items();
    const absKey = dmgType === 'physical' ? 'absPhysMax' : 'absEnrgMax';
    let totalAbs = 0;
    let count = 0;
    for (const [slot, cls] of Object.entries(dl)) {
      if (!slot.toLowerCase().includes('shield_generator')) continue;
      const item = items.find(i => i.className.toLowerCase() === cls.toLowerCase());
      if (item && item.type === 'Shield') {
        totalAbs += (item as any)[absKey] ?? 0;
        count++;
      }
    }
    return count > 0 ? totalAbs / count : 0;
  }

  nearbyShips = computed<ShipRow[]>(() => {
    const weapon = this.activeWeapon();
    if (!weapon?.damage) return [];
    const dt = this.dmgType();
    const rawAlpha = weapon.damage[dt] ?? 0;
    const deflectKey = dt === 'physical' ? 'armorDeflectPhys' : 'armorDeflectEnrg';
    const withShields = this.shieldsUp();

    const sizeFilter = this.shipSize();
    const ships = this.data.ships()
      .filter(s => ((s as any)[deflectKey] ?? 0) > 0)
      .filter(s => !sizeFilter || s.size === sizeFilter)
      .map(s => {
        const deflect = (s as any)[deflectKey] as number;
        // With shields up, effective alpha is reduced by shield absorption
        const absorption = withShields ? this.getShieldAbsorption(s, dt) : 0;
        const effectiveAlpha = rawAlpha * (1 - absorption);
        return { ship: s, deflect, deflected: effectiveAlpha <= deflect, dist: Math.abs(effectiveAlpha - deflect), effectiveAlpha };
      });

    const sizeActive = this.shipSize();
    if (sizeActive) {
      return ships
        .sort((a, b) => b.deflect - a.deflect)
        .map(s => ({ ship: s.ship, deflect: s.deflect, deflected: s.deflected, effectiveAlpha: s.effectiveAlpha }));
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
      ...below.map(s => ({ ship: s.ship, deflect: s.deflect, deflected: false, effectiveAlpha: s.effectiveAlpha })),
      ...above.map(s => ({ ship: s.ship, deflect: s.deflect, deflected: true, effectiveAlpha: s.effectiveAlpha })),
    ];
  });

  penetrateCount = computed(() => this.nearbyShips().filter(s => !s.deflected).length);
  deflectCount = computed(() => this.nearbyShips().filter(s => s.deflected).length);
}
