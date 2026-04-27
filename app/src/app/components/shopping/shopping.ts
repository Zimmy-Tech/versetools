import { Component, computed, signal } from '@angular/core';
import { DataService } from '../../services/data.service';
import { Item, Ship, ShopPrice } from '../../models/db.models';

/** A single line in the shopping results. Wraps a ship/item/fps entry
 *  with a display category and the shopPrices array, pre-sorted cheapest
 *  first so the template iterates a stable reference. */
interface ShopEntry {
  className: string;
  name: string;
  manufacturer: string;
  category: ShopCategory;
  /** Optional one-line meta shown next to the name (size, subType, etc.). */
  meta: string;
  /** Already sorted cheapest-first when the entry is built. */
  prices: ShopPrice[];
}

type ShopCategory =
  | 'Ship'
  | 'Ship Weapon'
  | 'Weapon Mount'
  | 'Shield'
  | 'Cooler'
  | 'Power Plant'
  | 'Quantum Drive'
  | 'Radar'
  | 'Mining Module'
  | 'Salvage'
  | 'Component'
  | 'FPS Weapon'
  | 'FPS Attachment'
  | 'FPS Gear'
  | 'FPS Armor';

const SHIP_WEAPON_TYPES = new Set(['WeaponGun', 'WeaponMining', 'Missile', 'Bomb']);
const WEAPON_MOUNT_TYPES = new Set(['WeaponMount', 'MissileLauncher', 'BombLauncher', 'Turret', 'TurretBase']);
const FPS_ATTACH_SUBTYPES = new Set(['Magazine', 'IronSight', 'Barrel', 'Ballistic', 'Energy', 'BottomAttachment']);
const FPS_WEAPON_TYPES = new Set([
  'Pistol', 'Rifle', 'SMG', 'Shotgun', 'Sniper', 'LMG', 'Special', 'Grenade', 'Grenade Launcher',
]);

@Component({
  selector: 'app-shopping',
  standalone: true,
  templateUrl: './shopping.html',
  styleUrl: './shopping.scss',
})
export class ShoppingComponent {
  searchQuery = signal('');

  constructor(public data: DataService) {}

  /** Master list — built once per data change, then filtered by search. */
  readonly allEntries = computed<ShopEntry[]>(() => {
    const out: ShopEntry[] = [];

    for (const ship of this.data.ships()) {
      out.push({
        className: ship.className,
        name: ship.name || ship.className,
        manufacturer: ship.manufacturer || '',
        category: 'Ship',
        meta: this.shipMeta(ship),
        prices: this.sortPrices(ship.shopPrices),
      });
    }

    for (const item of this.data.items()) {
      out.push({
        className: item.className,
        name: item.name || item.className,
        manufacturer: item.manufacturer || '',
        category: this.categoryForItem(item),
        meta: this.itemMeta(item),
        prices: this.sortPrices(item.shopPrices),
      });
    }

    const db = this.data.db();
    if (db) {
      const fpsItems = (db.fpsItems as any[] | undefined) ?? [];
      const fpsGear  = (db.fpsGear  as any[] | undefined) ?? [];
      const fpsArmor = (db.fpsArmor as any[] | undefined) ?? [];

      for (const fi of fpsItems) {
        const cat: ShopCategory =
          FPS_WEAPON_TYPES.has(fi.type) ? 'FPS Weapon' : 'FPS Attachment';
        out.push({
          className: fi.className,
          name: fi.name || fi.className,
          manufacturer: fi.manufacturer || '',
          category: cat,
          meta: this.fpsItemMeta(fi),
          prices: this.sortPrices(fi.shopPrices),
        });
      }
      for (const fg of fpsGear) {
        out.push({
          className: fg.className,
          name: fg.name || fg.className,
          manufacturer: fg.manufacturer || '',
          category: 'FPS Gear',
          meta: fg.subType || '',
          prices: this.sortPrices(fg.shopPrices),
        });
      }
      for (const fa of fpsArmor) {
        out.push({
          className: fa.className,
          name: fa.name || fa.className,
          manufacturer: fa.manufacturer || '',
          category: 'FPS Armor',
          meta: fa.slot || '',
          prices: this.sortPrices(fa.shopPrices),
        });
      }
    }

    return out;
  });

  /** Filtered + sorted result list. Empty when the search query is empty. */
  readonly results = computed<ShopEntry[]>(() => {
    const q = this.searchQuery().trim().toLowerCase();
    if (!q) return [];

    const arr = this.allEntries().filter(e =>
      e.name.toLowerCase().includes(q) ||
      e.className.toLowerCase().includes(q) ||
      e.manufacturer.toLowerCase().includes(q)
    );

    return [...arr].sort((a, b) => a.name.localeCompare(b.name));
  });

  // ─── Bucket assignment ───────────────────────────────────────────

  private categoryForItem(item: Item): ShopCategory {
    const t = item.type;
    if (SHIP_WEAPON_TYPES.has(t)) return 'Ship Weapon';
    if (WEAPON_MOUNT_TYPES.has(t)) return 'Weapon Mount';
    if (t === 'Shield') return 'Shield';
    if (t === 'Cooler') return 'Cooler';
    if (t === 'PowerPlant') return 'Power Plant';
    if (t === 'QuantumDrive') return 'Quantum Drive';
    if (t === 'Radar') return 'Radar';
    if (t === 'MiningModifier') return 'Mining Module';
    if (t === 'SalvageModifier' || t === 'SalvageHead') return 'Salvage';
    return 'Component';
  }

  // ─── Metadata strings (right of name) ────────────────────────────

  private shipMeta(ship: Ship): string {
    const parts: string[] = [];
    if (ship.role) parts.push(ship.roleFull || ship.role);
    if (ship.size) parts.push(`Size ${ship.size}`);
    return parts.join(' · ');
  }

  private itemMeta(item: Item): string {
    const parts: string[] = [];
    if (typeof item.size === 'number') parts.push(`S${item.size}`);
    if (item.grade) parts.push(item.grade);
    if (item.subType && item.subType !== 'UNDEFINED') parts.push(item.subType);
    return parts.join(' · ');
  }

  private fpsItemMeta(fi: any): string {
    const parts: string[] = [];
    if (fi.type) parts.push(fi.type);
    if (fi.subType && fi.subType !== fi.type) parts.push(fi.subType);
    return parts.join(' · ');
  }

  // ─── Price helpers ────────────────────────────────────────────────

  /** Sort once at entry-build time so the template doesn't re-sort on
   *  every change-detection pass. New array, so the original is left
   *  alone. Returns [] for missing/null. */
  private sortPrices(prices: ShopPrice[] | undefined): ShopPrice[] {
    if (!prices?.length) return [];
    return [...prices].sort((a, b) => a.price - b.price);
  }

  fmtPrice(n: number | null | undefined): string {
    if (n == null) return '';
    return n.toLocaleString('en-US');
  }

  shopLabel(sp: ShopPrice): string {
    return (sp.shopCompany && sp.shopCompany.trim()) || sp.shop || 'Unknown shop';
  }

  shopLocation(sp: ShopPrice): string {
    const parts: string[] = [];
    const place = sp.city || sp.outpost || sp.spaceStation || sp.orbit;
    if (place) parts.push(place);
    const body = sp.moon || sp.planet;
    if (body && body !== place) parts.push(body);
    if (sp.starSystem && sp.starSystem !== body) parts.push(sp.starSystem);
    return parts.join(' · ');
  }

  hasLocation(sp: ShopPrice): boolean {
    return !!(sp.city || sp.outpost || sp.spaceStation || sp.orbit || sp.moon || sp.planet || sp.starSystem);
  }
}
