import { Component, signal, computed, effect } from '@angular/core';
import { DataService } from '../../services/data.service';
import { Ship, Item } from '../../models/db.models';

type DmgType = 'physical' | 'energy';
type ShipSize = '' | 'small' | 'medium' | 'large' | 'capital';

interface ShipRow {
  ship: Ship;
  deflect: number;
  alpha: number;            // raw weapon alpha (constant per row, kept for the table)
  shieldedAlpha: number;    // alpha × size-class avg bleed (rounded for display)
  armorPenetrates: boolean; // raw alpha > deflect
  shieldPenetrates: boolean;// shieldedAlpha > deflect
}

// Display labels for ship size classes — game uses "small/medium/large/capital"
// internally but the players think in S1/S2/S3/S4 shorthand.
const SHIP_SIZE_LABELS: Record<string, string> = {
  small:   'S1',
  medium:  'S2',
  large:   'S3',
  capital: 'S4',
};

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

  /** Average shield bleedthrough per ship size class.
   *
   *  For each size class (small/medium/large/capital), walks every ship in
   *  that class, looks up its default-loadout shields, and averages the
   *  physical/energy absorption rates across all those shields. Returns
   *  bleedthrough = 1 − absorption.
   *
   *  The result is one approximate "typical shield" per size class, used
   *  by the armor view's shielded penetration check so we don't have to
   *  show per-ship shield variation in the threat table. */
  shieldBleedByClass = computed(() => {
    const items = this.data.items();
    const itemByCls = new Map(items.map(i => [i.className.toLowerCase(), i]));
    const totals: Record<string, { phys: number; enrg: number; shields: number }> = {
      small:   { phys: 0, enrg: 0, shields: 0 },
      medium:  { phys: 0, enrg: 0, shields: 0 },
      large:   { phys: 0, enrg: 0, shields: 0 },
      capital: { phys: 0, enrg: 0, shields: 0 },
    };
    for (const ship of this.data.ships()) {
      if (!ship.size || !ship.defaultLoadout || !totals[ship.size]) continue;
      for (const [slot, cls] of Object.entries(ship.defaultLoadout)) {
        if (!slot.toLowerCase().includes('shield_generator')) continue;
        const item = itemByCls.get((cls ?? '').toLowerCase());
        if (item?.type !== 'Shield') continue;
        totals[ship.size].phys += (item as any).absPhysMax ?? 0;
        totals[ship.size].enrg += (item as any).absEnrgMax ?? 0;
        totals[ship.size].shields += 1;
      }
    }
    const result: Record<string, { physBleed: number; enrgBleed: number; shields: number }> = {};
    for (const [k, v] of Object.entries(totals)) {
      result[k] = {
        physBleed: v.shields > 0 ? 1 - (v.phys / v.shields) : 1,
        enrgBleed: v.shields > 0 ? 1 - (v.enrg / v.shields) : 1,
        shields: v.shields,
      };
    }
    return result;
  });

  nearbyShips = computed<ShipRow[]>(() => {
    const weapon = this.activeWeapon();
    if (!weapon?.damage) return [];
    const dt = this.dmgType();
    const rawAlpha = weapon.damage[dt] ?? 0;
    const deflectKey = dt === 'physical' ? 'armorDeflectPhys' : 'armorDeflectEnrg';
    const bleeds = this.shieldBleedByClass();

    const sizeFilter = this.shipSize();
    const candidates = this.data.ships()
      .filter(s => ((s as any)[deflectKey] ?? 0) > 0)
      .filter(s => !sizeFilter || s.size === sizeFilter);

    const buildRow = (s: Ship): ShipRow => {
      const deflect = (s as any)[deflectKey] as number;
      const classBleed = (s.size && bleeds[s.size])
        ? (dt === 'physical' ? bleeds[s.size].physBleed : bleeds[s.size].enrgBleed)
        : 1;
      const shieldedAlpha = rawAlpha * classBleed;
      return {
        ship: s,
        deflect,
        alpha: rawAlpha,
        shieldedAlpha,
        armorPenetrates: rawAlpha > deflect,
        shieldPenetrates: shieldedAlpha > deflect,
      };
    };

    if (sizeFilter) {
      // Size filter active — show all ships in that class, sorted high→low
      return candidates
        .map(buildRow)
        .sort((a, b) => b.deflect - a.deflect);
    }

    // No filter — pick the 3 closest ships above and 3 closest below the
    // weapon's alpha, then merge into a single list sorted high→low so the
    // result reads as one continuous threshold ladder.
    const sorted = candidates
      .map(buildRow)
      .sort((a, b) => Math.abs(a.deflect - rawAlpha) - Math.abs(b.deflect - rawAlpha));

    const picked: ShipRow[] = [];
    let aboveCount = 0;
    let belowCount = 0;
    for (const r of sorted) {
      if (r.armorPenetrates && belowCount < 3) { picked.push(r); belowCount++; }
      else if (!r.armorPenetrates && aboveCount < 3) { picked.push(r); aboveCount++; }
      if (aboveCount >= 3 && belowCount >= 3) break;
    }
    return picked.sort((a, b) => b.deflect - a.deflect);
  });

  shipSizeLabel(size: string | undefined): string {
    return size ? (SHIP_SIZE_LABELS[size] ?? size) : '';
  }
}
