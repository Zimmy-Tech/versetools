import { Component, computed, signal } from '@angular/core';
import { DataService } from '../../services/data.service';
import { Item, Ship, ShopPrice } from '../../models/db.models';

/** A single line in the shopping list. Wraps a ship/item/fps entry with a
 *  display category and the underlying shopPrices array. */
interface ShopEntry {
  className: string;
  name: string;
  manufacturer: string;
  category: ShopCategory;
  /** Optional one-line meta shown next to the name (size, subType, etc.). */
  meta: string;
  prices: ShopPrice[];
}

type ShopCategory =
  | 'Ships'
  | 'Ship Weapons'
  | 'Weapon Mounts'
  | 'Shields'
  | 'Coolers'
  | 'Power Plants'
  | 'Quantum Drives'
  | 'Radars'
  | 'Mining Modules'
  | 'Salvage'
  | 'Other Components'
  | 'FPS Weapons'
  | 'FPS Attachments'
  | 'FPS Gear'
  | 'FPS Armor';

const ALL_CATEGORIES: ShopCategory[] = [
  'Ships',
  'Ship Weapons',
  'Weapon Mounts',
  'Shields',
  'Coolers',
  'Power Plants',
  'Quantum Drives',
  'Radars',
  'Mining Modules',
  'Salvage',
  'Other Components',
  'FPS Weapons',
  'FPS Attachments',
  'FPS Gear',
  'FPS Armor',
];

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
  // Empty set = "all categories"
  activeCategories = signal<Set<ShopCategory>>(new Set());
  systemFilter = signal('');
  shopFilter = signal('');
  showNoShop = signal(false);

  readonly allCategories = ALL_CATEGORIES;

  constructor(public data: DataService) {}

  /** Build the master flat list once per data change. */
  readonly allEntries = computed<ShopEntry[]>(() => {
    const out: ShopEntry[] = [];

    for (const ship of this.data.ships()) {
      out.push({
        className: ship.className,
        name: ship.name || ship.className,
        manufacturer: ship.manufacturer || '',
        category: 'Ships',
        meta: this.shipMeta(ship),
        prices: ship.shopPrices ?? [],
      });
    }

    for (const item of this.data.items()) {
      const cat = this.categoryForItem(item);
      out.push({
        className: item.className,
        name: item.name || item.className,
        manufacturer: item.manufacturer || '',
        category: cat,
        meta: this.itemMeta(item),
        prices: item.shopPrices ?? [],
      });
    }

    const db = this.data.db();
    if (db) {
      const fpsItems = (db.fpsItems as any[] | undefined) ?? [];
      const fpsGear  = (db.fpsGear  as any[] | undefined) ?? [];
      const fpsArmor = (db.fpsArmor as any[] | undefined) ?? [];

      for (const fi of fpsItems) {
        const cat: ShopCategory =
          FPS_WEAPON_TYPES.has(fi.type) ? 'FPS Weapons'
          : FPS_ATTACH_SUBTYPES.has(fi.subType) ? 'FPS Attachments'
          : 'FPS Attachments';
        out.push({
          className: fi.className,
          name: fi.name || fi.className,
          manufacturer: fi.manufacturer || '',
          category: cat,
          meta: this.fpsItemMeta(fi),
          prices: (fi.shopPrices as ShopPrice[] | undefined) ?? [],
        });
      }
      for (const fg of fpsGear) {
        out.push({
          className: fg.className,
          name: fg.name || fg.className,
          manufacturer: fg.manufacturer || '',
          category: 'FPS Gear',
          meta: fg.subType || '',
          prices: (fg.shopPrices as ShopPrice[] | undefined) ?? [],
        });
      }
      for (const fa of fpsArmor) {
        out.push({
          className: fa.className,
          name: fa.name || fa.className,
          manufacturer: fa.manufacturer || '',
          category: 'FPS Armor',
          meta: fa.slot || '',
          prices: (fa.shopPrices as ShopPrice[] | undefined) ?? [],
        });
      }
    }

    return out;
  });

  /** Distinct star systems present in the current data. */
  readonly availableSystems = computed<string[]>(() => {
    const set = new Set<string>();
    for (const e of this.allEntries()) {
      for (const p of e.prices) {
        if (p.starSystem) set.add(p.starSystem);
      }
    }
    return [...set].sort();
  });

  /** Distinct shop names (company preferred, falling back to nickname). */
  readonly availableShops = computed<string[]>(() => {
    const set = new Set<string>();
    for (const e of this.allEntries()) {
      for (const p of e.prices) {
        const label = (p.shopCompany && p.shopCompany.trim()) || p.shop;
        if (label) set.add(label);
      }
    }
    return [...set].sort();
  });

  /** Filtered + sorted result list. */
  readonly results = computed<ShopEntry[]>(() => {
    const q = this.searchQuery().trim().toLowerCase();
    const cats = this.activeCategories();
    const sys = this.systemFilter();
    const shop = this.shopFilter();
    const showEmpty = this.showNoShop();

    let arr = this.allEntries();

    if (cats.size > 0) {
      arr = arr.filter(e => cats.has(e.category));
    }

    if (q) {
      arr = arr.filter(e =>
        e.name.toLowerCase().includes(q) ||
        e.className.toLowerCase().includes(q) ||
        e.manufacturer.toLowerCase().includes(q)
      );
    }

    if (sys) {
      arr = arr.filter(e => e.prices.some(p => p.starSystem === sys));
    }
    if (shop) {
      arr = arr.filter(e =>
        e.prices.some(p => ((p.shopCompany && p.shopCompany.trim()) || p.shop) === shop)
      );
    }

    if (!showEmpty) {
      arr = arr.filter(e => e.prices.length > 0);
    }

    return [...arr].sort((a, b) => a.name.localeCompare(b.name));
  });

  /** Counts per category over the *unfiltered* list — useful for chips. */
  readonly categoryCounts = computed<Record<string, number>>(() => {
    const showEmpty = this.showNoShop();
    const counts: Record<string, number> = {};
    for (const c of ALL_CATEGORIES) counts[c] = 0;
    for (const e of this.allEntries()) {
      if (!showEmpty && e.prices.length === 0) continue;
      counts[e.category]++;
    }
    return counts;
  });

  // ─── Filter UI handlers ──────────────────────────────────────────

  toggleCategory(cat: ShopCategory): void {
    const cur = new Set(this.activeCategories());
    if (cur.has(cat)) cur.delete(cat); else cur.add(cat);
    this.activeCategories.set(cur);
  }

  isCategoryActive(cat: ShopCategory): boolean {
    return this.activeCategories().has(cat);
  }

  clearCategories(): void { this.activeCategories.set(new Set()); }

  clearAll(): void {
    this.searchQuery.set('');
    this.activeCategories.set(new Set());
    this.systemFilter.set('');
    this.shopFilter.set('');
  }

  // ─── Bucket assignment ───────────────────────────────────────────

  private categoryForItem(item: Item): ShopCategory {
    const t = item.type;
    if (SHIP_WEAPON_TYPES.has(t)) return 'Ship Weapons';
    if (WEAPON_MOUNT_TYPES.has(t)) return 'Weapon Mounts';
    if (t === 'Shield') return 'Shields';
    if (t === 'Cooler') return 'Coolers';
    if (t === 'PowerPlant') return 'Power Plants';
    if (t === 'QuantumDrive') return 'Quantum Drives';
    if (t === 'Radar') return 'Radars';
    if (t === 'MiningModifier') return 'Mining Modules';
    if (t === 'SalvageModifier' || t === 'SalvageHead') return 'Salvage';
    return 'Other Components';
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

  // ─── Shop display helpers — mirror cart-view conventions ─────────

  fmtPrice(n: number | null | undefined): string {
    if (n == null) return '';
    return n.toLocaleString('en-US');
  }

  sortedShops(prices: ShopPrice[]): ShopPrice[] {
    return [...prices].sort((a, b) => a.price - b.price);
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
