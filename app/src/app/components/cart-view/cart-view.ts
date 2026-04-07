import { Component, computed } from '@angular/core';
import { DataService } from '../../services/data.service';
import { CartEntry, ShopPrice } from '../../models/db.models';

@Component({
  selector: 'app-cart-view',
  standalone: true,
  templateUrl: './cart-view.html',
  styleUrl: './cart-view.scss',
})
export class CartViewComponent {
  constructor(public data: DataService) {}

  entries = computed<CartEntry[]>(() => {
    return [...this.data.cart().values()]
      .sort((a, b) => a.item.type.localeCompare(b.item.type) || a.item.name.localeCompare(b.item.name));
  });

  cheapestTotal = computed(() => {
    let total = 0;
    for (const entry of this.entries()) {
      const prices = entry.item.shopPrices;
      if (prices?.length) {
        const cheapest = Math.min(...prices.map(p => p.price));
        total += cheapest * entry.quantity;
      }
    }
    return total;
  });

  fmtPrice(n: number): string {
    return n.toLocaleString('en-US');
  }

  typeLabel(type: string): string {
    return ({
      WeaponGun: 'Weapon', WeaponTachyon: 'Weapon', WeaponMining: 'Mining Laser',
      Shield: 'Shield', PowerPlant: 'Power Plant', Cooler: 'Cooler',
      QuantumDrive: 'Quantum Drive', Radar: 'Radar', Missile: 'Missile',
      MiningModifier: 'Mining Module', SalvageHead: 'Salvage Head',
      SalvageModifier: 'Salvage Tool', LifeSupportGenerator: 'Life Support',
    } as Record<string, string>)[type] ?? type;
  }

  /** Sort an item's shop prices cheapest-first. Pure function so the
   *  template can call it inside the @for without re-sorting state. */
  sortedShops(prices: ShopPrice[] | undefined): ShopPrice[] {
    if (!prices?.length) return [];
    return [...prices].sort((a, b) => a.price - b.price);
  }

  /** Primary shop label. Prefers the operator company (e.g. "New Deal",
   *  "Ship Weapons") over UEX's terminal nickname, which is often a
   *  mash-up of the company and a location word. Falls back to the
   *  legacy shop string when no company is recorded (manual entries
   *  or older data). */
  shopLabel(sp: ShopPrice): string {
    return (sp.shopCompany && sp.shopCompany.trim()) || sp.shop || 'Unknown shop';
  }

  /** Compose a location line from the available hierarchy fields.
   *  Walks city → outpost → space_station → orbit, then moon → planet,
   *  then star_system, joining the non-empty pieces with " · ". */
  shopLocation(sp: ShopPrice): string {
    const parts: string[] = [];
    const place = sp.city || sp.outpost || sp.spaceStation || sp.orbit;
    if (place) parts.push(place);
    const body = sp.moon || sp.planet;
    if (body && body !== place) parts.push(body);
    if (sp.starSystem && sp.starSystem !== body) parts.push(sp.starSystem);
    return parts.join(' · ');
  }

  /** True if a shop price entry has any location data at all. Used to
   *  hide the location line entirely when the entry is bare (e.g. an
   *  older manual override with no enrichment). */
  hasLocation(sp: ShopPrice): boolean {
    return !!(sp.city || sp.outpost || sp.spaceStation || sp.orbit || sp.moon || sp.planet || sp.starSystem);
  }

  remove(className: string): void {
    this.data.removeFromCart(className);
  }

  clear(): void {
    this.data.clearCart();
  }
}
