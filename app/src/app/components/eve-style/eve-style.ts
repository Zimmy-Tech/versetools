import { Component, signal, computed } from '@angular/core';
import { DataService } from '../../services/data.service';
import { Item, Hardpoint } from '../../models/db.models';

type CategoryId = 'weapons' | 'shields' | 'power' | 'cooling' | 'quantum' | 'avionics' | 'missiles';

/**
 * A node in the EVE-style slot tree. Can represent a top-level hardpoint,
 * a turret sub-port, a gimbal, or a weapon leaf.
 */
interface SlotNode {
  /** The dotted loadout key for this slot (e.g., "hardpoint_gun_left.hardpoint_class_2") */
  slotId: string;
  /** Display label */
  label: string;
  /** Category for grouping in the browser */
  category: CategoryId;
  /** The Hardpoint-like descriptor for getOptionsForSlot() */
  hardpoint: Hardpoint;
  /** Currently equipped item (null = empty) */
  item: Item | null;
  /** Nesting depth (0 = top-level, 1 = sub-slot, 2 = grandchild) */
  depth: number;
  /** Parent slot ID (null for top-level) */
  parentSlotId: string | null;
  /** Whether this slot is editable */
  editable: boolean;
  /** Child nodes (e.g., guns under a turret) */
  children: SlotNode[];
  /** For missile rack nodes: all leaf IDs to bulk-fill */
  rackLeafIds?: string[];
}

interface BrowserCategory {
  id: CategoryId;
  name: string;
  icon: string;
  expanded: boolean;
}

const TYPE_TO_CAT: Record<string, CategoryId> = {
  WeaponGun: 'weapons', WeaponTachyon: 'weapons', Turret: 'weapons', TurretBase: 'weapons',
  WeaponMount: 'weapons',
  Missile: 'missiles', MissileLauncher: 'missiles', BombLauncher: 'missiles',
  Shield: 'shields',
  PowerPlant: 'power',
  Cooler: 'cooling',
  QuantumDrive: 'quantum',
  Radar: 'avionics', LifeSupportGenerator: 'avionics',
};

@Component({
  selector: 'app-eve-style',
  standalone: true,
  templateUrl: './eve-style.html',
  styleUrl: './eve-style.scss',
})
export class EveStyleComponent {
  Math = Math;
  constructor(public data: DataService) {}

  selectedSlotId = signal<string | null>(null);
  selectedPickerItem = signal<Item | null>(null);
  browserTab = signal<'browse' | 'buy'>('browse');
  pickerSearch = signal('');
  pickerSort = signal<'name' | 'dps' | 'size'>('name');
  shipSearch = signal('');
  shipPickerOpen = signal(false);

  categories: BrowserCategory[] = [
    { id: 'weapons', name: 'Weapons', icon: '⚔', expanded: true },
    { id: 'missiles', name: 'Missiles', icon: '◆', expanded: false },
    { id: 'shields', name: 'Shields', icon: '◈', expanded: false },
    { id: 'power', name: 'Power Plants', icon: '⚡', expanded: false },
    { id: 'cooling', name: 'Coolers', icon: '❄', expanded: false },
    { id: 'quantum', name: 'Quantum Drives', icon: '◉', expanded: false },
    { id: 'avionics', name: 'Avionics', icon: '◎', expanded: false },
  ];

  /**
   * Build the full slot tree from ship hardpoints, equipped items, and their subPorts.
   * This is the EVE view's own tree builder — parallel to loadout-view's _subSlotData
   * but structured as a nested tree for the EVE UI.
   */
  slotTree = computed<SlotNode[]>(() => {
    const ship = this.data.selectedShip();
    if (!ship) return [];
    const loadout = this.data.loadout();
    const defaults = ship.defaultLoadout ?? {};
    const items = this.data.items();
    const nodes: SlotNode[] = [];

    for (const hp of ship.hardpoints) {
      const cat = TYPE_TO_CAT[hp.type];
      if (!cat) continue;

      const item = loadout[hp.id] ?? null;
      const editable = !hp.flags?.includes('$uneditable') && !hp.flags?.includes('uneditable');
      const label = this.cleanLabel(hp.label || hp.id);

      const node: SlotNode = {
        slotId: hp.id,
        label,
        category: cat,
        hardpoint: hp,
        item,
        depth: 0,
        parentSlotId: null,
        editable,
        children: [],
      };

      // Build children depending on parent type
      const isRack = hp.type === 'MissileLauncher' || hp.type === 'BombLauncher'
                  || item?.type === 'MissileLauncher' || item?.type === 'BombLauncher';

      if (isRack) {
        // Missile/bomb rack: children are missile attach points from defaultLoadout or capacity
        node.children = this.buildRackChildren(hp, item, loadout, defaults, items);
      } else if (item?.subPorts?.length) {
        node.children = this.buildSubSlots(hp, item, loadout, defaults, items, 1);
      } else if (!item && (hp.type === 'Turret' || hp.type === 'TurretBase')) {
        // No item equipped but it's a turret slot — check defaults for children
        const defaultCls = defaults[hp.id.toLowerCase()];
        const defaultItem = defaultCls ? items.find(i => i.className.toLowerCase() === defaultCls.toLowerCase()) : null;
        if (defaultItem?.subPorts?.length) {
          node.children = this.buildSubSlots(hp, defaultItem, loadout, defaults, items, 1);
        }
      }

      nodes.push(node);
    }

    return nodes;
  });

  /** Build child SlotNodes from an item's subPorts. Handles gimbal → weapon nesting. */
  private buildSubSlots(
    parentHp: Hardpoint,
    parentItem: Item,
    loadout: Record<string, Item>,
    defaults: Record<string, string>,
    items: Item[],
    depth: number
  ): SlotNode[] {
    const children: SlotNode[] = [];
    if (!parentItem.subPorts) return children;

    const weaponLock = parentItem.weaponLock ?? null;
    let gunIdx = 1;

    for (const sp of parentItem.subPorts) {
      const subId = `${parentHp.id}.${sp.id}`.toLowerCase();

      // --- Missile rack sub-port ---
      if (sp.type === 'MissileLauncher' || sp.type === 'BombLauncher') {
        const rackItem = loadout[subId]
          ?? (defaults[subId] ? items.find(i => i.className.toLowerCase() === defaults[subId].toLowerCase()) : null);
        const capacity = rackItem?.capacity ?? 1;
        const missileSize = rackItem?.missileSize ?? sp.maxSize;
        const isBomb = sp.type === 'BombLauncher';

        // Build all leaf IDs for bulk equip
        const leafIds: string[] = [];
        for (let n = 1; n <= capacity; n++) {
          leafIds.push(`${subId}.missile_${String(n).padStart(2, '0')}_attach`);
        }
        const firstLeaf = leafIds[0] ?? `${subId}.missile_01_attach`;
        const missileItem = loadout[firstLeaf] ?? null;

        children.push({
          slotId: firstLeaf,
          label: isBomb ? `Bombs ×${capacity}` : `Missiles ×${capacity}`,
          category: 'missiles',
          hardpoint: {
            id: firstLeaf,
            label: isBomb ? 'Bombs' : 'Missiles',
            type: isBomb ? 'Bomb' : 'Missile',
            subtypes: '',
            minSize: missileSize,
            maxSize: missileSize,
            flags: '',
            allTypes: [{ type: 'Missile', subtypes: '' }],
          },
          item: missileItem,
          depth,
          parentSlotId: parentHp.id,
          editable: true,
          children: [],
          rackLeafIds: leafIds,
        });
        continue;
      }

      // --- Gun / utility sub-port ---
      const equippedChild = loadout[subId] ?? loadout[subId.toLowerCase()];
      const defaultChildCls = defaults[subId.toLowerCase()];
      const childItem = equippedChild
        ?? (defaultChildCls ? items.find(i => i.className.toLowerCase() === defaultChildCls.toLowerCase()) : null);

      const isGimbal = childItem?.type === 'WeaponMount';

      if (isGimbal && childItem?.subPorts?.length) {
        // Gimbal equipped — show the gimbal as a node, with the weapon inside it
        const gimbalPort = childItem.subPorts[0];
        const gunLeafId = `${subId}.${gimbalPort.id}`;
        const gunItem = loadout[gunLeafId] ?? loadout[gunLeafId.toLowerCase()] ?? null;
        const gunSize = gunItem?.size ?? gimbalPort.maxSize;

        const weaponChild: SlotNode = {
          slotId: gunLeafId,
          label: `Gun ${gunIdx++}`,
          category: 'weapons',
          hardpoint: {
            id: gunLeafId,
            label: `Gun`,
            type: 'WeaponGun',
            subtypes: '',
            minSize: weaponLock ? gunSize : Math.max(1, gunSize - 1),
            maxSize: gunSize,
            flags: weaponLock ? `weaponLock:${weaponLock}` : '',
            allTypes: [{ type: 'WeaponGun', subtypes: '' }],
            ...(parentHp.portTags ? { portTags: parentHp.portTags } : {}),
          },
          item: gunItem,
          depth: depth + 1,
          parentSlotId: subId,
          editable: !weaponLock,
          children: [],
        };

        // Show the gimbal node with the weapon as its child
        children.push({
          slotId: subId,
          label: childItem.name ?? `Mount ${gunIdx - 1}`,
          category: 'weapons',
          hardpoint: {
            id: subId,
            label: 'Mount',
            type: sp.type || 'WeaponGun',
            subtypes: '',
            minSize: sp.minSize,
            maxSize: sp.maxSize,
            flags: '',
            allTypes: sp.allTypes?.map((t: any) => ({ type: t.type, subtypes: '' })) ?? [{ type: 'WeaponGun', subtypes: '' }],
            ...(parentHp.portTags ? { portTags: parentHp.portTags } : {}),
          },
          item: childItem,
          depth,
          parentSlotId: parentHp.id,
          editable: true,
          children: [weaponChild],
        });
      } else {
        // Direct weapon port (no gimbal) or non-weapon sub-port
        const slotType = sp.type === 'WeaponMining' ? 'WeaponMining'
          : sp.type === 'SalvageHead' ? 'SalvageHead'
          : sp.type === 'TractorBeam' ? 'TractorBeam'
          : 'WeaponGun';

        const slotLabel = slotType === 'WeaponMining' ? `Laser ${gunIdx++}`
          : slotType === 'SalvageHead' ? `Salvage ${gunIdx++}`
          : `Gun ${gunIdx++}`;

        const slotSize = weaponLock
          ? (items.find(i => i.className.toLowerCase() === weaponLock.toLowerCase())?.size ?? sp.maxSize)
          : sp.maxSize;

        children.push({
          slotId: subId,
          label: slotLabel,
          category: 'weapons',
          hardpoint: {
            id: subId,
            label: slotLabel,
            type: slotType,
            subtypes: '',
            minSize: weaponLock ? slotSize : sp.minSize,
            maxSize: slotSize,
            flags: weaponLock ? `weaponLock:${weaponLock}` : '',
            allTypes: sp.allTypes?.map((t: any) => ({ type: t.type, subtypes: '' })) ?? [{ type: slotType, subtypes: '' }],
            ...(parentHp.portTags ? { portTags: parentHp.portTags } : {}),
          },
          item: equippedChild ?? null,
          depth,
          parentSlotId: parentHp.id,
          editable: !weaponLock,
          children: [],
        });
      }
    }

    return children;
  }

  /** Build missile/bomb children for a rack hardpoint. */
  private buildRackChildren(
    hp: Hardpoint,
    rackItem: Item | null,
    loadout: Record<string, Item>,
    defaults: Record<string, string>,
    items: Item[],
  ): SlotNode[] {
    const prefix = hp.id.toLowerCase() + '.';
    const isBomb = hp.type === 'BombLauncher' || rackItem?.type === 'BombLauncher';

    // Discover missile leaf keys from defaults and current loadout
    const allKeys = new Set([
      ...Object.keys(defaults).filter(k => k.startsWith(prefix)),
      ...Object.keys(loadout).filter(k => k.toLowerCase().startsWith(prefix)),
    ]);
    let missileLeaves = [...allKeys].filter(k => {
      // Only leaf keys (no further children)
      return ![...allKeys].some(k2 => k2.startsWith(k + '.'));
    });

    // If rack has capacity but fewer known leaves, generate synthetic keys
    const capacity = rackItem?.capacity ?? missileLeaves.length;
    if (capacity > missileLeaves.length) {
      for (let n = missileLeaves.length + 1; n <= capacity; n++) {
        const padded = String(n).padStart(2, '0');
        missileLeaves.push(`${hp.id.toLowerCase()}.missile_${padded}_attach`);
      }
    }
    missileLeaves = missileLeaves.slice(0, capacity);

    if (!missileLeaves.length) return [];

    // Determine missile size from rack or first equipped missile
    const missileSize = rackItem?.missileSize
      ?? loadout[missileLeaves[0]]?.size
      ?? (defaults[missileLeaves[0]] ? items.find(i => i.className.toLowerCase() === defaults[missileLeaves[0]].toLowerCase())?.size : null)
      ?? hp.maxSize;

    // All missiles in the rack share one equip action (bulk), show as single node
    const firstLeaf = missileLeaves[0];
    const missileItem = loadout[firstLeaf] ?? null;

    return [{
      slotId: firstLeaf,
      label: isBomb ? `Bombs ×${capacity}` : `Missiles ×${capacity}`,
      category: 'missiles',
      hardpoint: {
        id: firstLeaf,
        label: isBomb ? 'Bombs' : 'Missiles',
        type: isBomb ? 'Bomb' : 'Missile',
        subtypes: '',
        minSize: missileSize,
        maxSize: missileSize,
        flags: '',
        allTypes: [{ type: 'Missile', subtypes: '' }],
      },
      item: missileItem,
      depth: 1,
      parentSlotId: hp.id,
      editable: true,
      children: [],
      rackLeafIds: missileLeaves,
    }];
  }

  /** Flatten the tree for a given category, including children recursively */
  flatNodesForCategory(catId: CategoryId): SlotNode[] {
    const result: SlotNode[] = [];
    const addNodes = (nodes: SlotNode[]) => {
      for (const node of nodes) {
        if (node.category === catId || (catId === 'weapons' && node.children.some(c => c.category === 'weapons'))) {
          result.push(node);
        }
        if (node.children.length) {
          addNodes(node.children);
        }
      }
    };
    addNodes(this.slotTree());
    return result;
  }

  /** All slot nodes flattened (for the center "Fitted Loadout" panel) */
  allFlatNodes = computed<SlotNode[]>(() => {
    const result: SlotNode[] = [];
    const flatten = (nodes: SlotNode[]) => {
      for (const node of nodes) {
        // Only show nodes that have an equipped item or are leaf slots
        if (node.item || node.children.length === 0) {
          result.push(node);
        }
        if (node.children.length) flatten(node.children);
      }
    };
    flatten(this.slotTree());
    return result;
  });

  // The currently selected slot node
  selectedSlot = computed<SlotNode | null>(() => {
    const id = this.selectedSlotId();
    if (!id) return null;
    const find = (nodes: SlotNode[]): SlotNode | null => {
      for (const n of nodes) {
        if (n.slotId === id) return n;
        const child = find(n.children);
        if (child) return child;
      }
      return null;
    };
    return find(this.slotTree());
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

  // Stats from equipped items
  equippedWeapons = computed(() =>
    this.allFlatNodes().filter(n => n.item && (n.item.type === 'WeaponGun' || n.item.type === 'WeaponTachyon'))
  );
  equippedShields = computed(() =>
    this.allFlatNodes().filter(n => n.item?.type === 'Shield')
  );

  totalDps = computed(() => this.equippedWeapons().reduce((s, n) => s + (n.item!.dps ?? 0), 0));
  totalAlpha = computed(() => this.equippedWeapons().reduce((s, n) => s + (n.item!.alphaDamage ?? 0), 0));
  totalShieldHp = computed(() => this.equippedShields().reduce((s, n) => s + (n.item!.hp ?? 0), 0));
  totalShieldRegen = computed(() => this.equippedShields().reduce((s, n) => s + (n.item!.regenRate ?? 0), 0));
  totalPowerOutput = computed(() =>
    this.allFlatNodes().filter(n => n.item?.type === 'PowerPlant').reduce((s, n) => s + (n.item!.powerOutput ?? 0), 0)
  );
  totalPowerDraw = computed(() =>
    this.allFlatNodes().filter(n => n.item && n.item.type !== 'PowerPlant').reduce((s, n) => s + (n.item!.powerDraw ?? 0), 0)
  );
  totalCooling = computed(() =>
    this.allFlatNodes().filter(n => n.item?.type === 'Cooler').reduce((s, n) => s + (n.item!.coolingRate ?? 0), 0)
  );
  missileCount = computed(() =>
    this.allFlatNodes().filter(n => n.item?.type === 'Missile').length
  );

  // Actions
  selectSlot(slotId: string): void {
    this.selectedSlotId.set(slotId);
    this.pickerSearch.set('');
    this.selectedPickerItem.set(null);
  }

  equipToSlot(item: Item): void {
    const slot = this.selectedSlot();
    if (!slot) return;
    if (slot.rackLeafIds?.length) {
      // Missile rack: bulk-fill all leaf positions
      this.data.setRackItems(slot.rackLeafIds, item);
    } else {
      this.data.setLoadoutItem(slot.slotId, item);
    }
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

  // Ship picker
  filteredShips = computed(() => {
    const q = this.shipSearch().toLowerCase();
    const ships = this.data.ships();
    if (!q) return ships.slice(0, 50);
    return ships.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.manufacturer?.toLowerCase().includes(q) ||
      s.role?.toLowerCase().includes(q)
    ).slice(0, 50);
  });

  selectShip(ship: any): void {
    this.data.selectShip(ship);
    this.shipPickerOpen.set(false);
    this.shipSearch.set('');
    this.selectedSlotId.set(null);
  }

  // Additional stats for right panel
  totalMissileDmg = computed(() =>
    this.allFlatNodes().filter(n => n.item?.type === 'Missile')
      .reduce((s, n) => s + (n.item!.alphaDamage ?? 0), 0)
  );

  avgProjectileSpeed = computed(() => {
    const wpns = this.equippedWeapons().filter(n => n.item!.speed);
    if (!wpns.length) return 0;
    return wpns.reduce((s, n) => s + (n.item!.speed ?? 0), 0) / wpns.length;
  });

  private cleanLabel(raw: string): string {
    return raw
      .replace(/hardpoint_/gi, '')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
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
