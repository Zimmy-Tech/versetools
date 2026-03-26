import { Component, computed } from '@angular/core';
import { DataService } from '../../services/data.service';
import { CartEntry } from '../../models/db.models';

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

  remove(className: string): void {
    this.data.removeFromCart(className);
  }

  clear(): void {
    this.data.clearCart();
  }
}
