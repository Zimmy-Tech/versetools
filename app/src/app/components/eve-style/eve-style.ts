import { Component, signal, computed } from '@angular/core';
import { DataService } from '../../services/data.service';
import { Item, Hardpoint, weaponDisplayType, calcMaxPips, calcWeaponAmmo } from '../../models/db.models';

type CategoryId = 'weapons' | 'shields' | 'power' | 'cooling' | 'quantum' | 'avionics' | 'missiles';

/** Column descriptor for the eve-style picker table. Mirrors the rich
 *  per-type columns from the main loadout picker (hardpoint-slot.html)
 *  so the same data density is visible in both views. */
interface PickerCol {
  label: string;
  /** Field name used for sorting. Omit to make the column non-sortable. */
  sortField?: string;
  /** Value accessor. Returns the already-formatted string shown in the cell. */
  value: (item: Item, ctx: EveStyleComponent) => string;
  /** 'name' flag widens the column and applies the name typography. */
  kind?: 'sz' | 'name' | 'num' | 'text' | 'shop';
  /** Tooltip shown on the header. */
  title?: string;
}

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
  /** Sort field matches the underlying Item key (e.g., 'dps', 'alphaDamage',
   *  'fireRate'). Defaults to 'size' so new slots show biggest-first. */
  pickerSort = signal<string>('size');
  pickerSortDir = signal<'asc' | 'desc'>('desc');
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
    const field = this.pickerSort();
    const dir = this.pickerSortDir() === 'asc' ? 1 : -1;

    let items = this.data.getOptionsForSlot(slot.hardpoint);
    if (q) {
      items = items.filter(i =>
        (i.name ?? '').toLowerCase().includes(q) ||
        (i.manufacturer ?? '').toLowerCase().includes(q)
      );
    }

    items.sort((a, b) => {
      const av = (a as any)[field];
      const bv = (b as any)[field];
      if (typeof av === 'number' && typeof bv === 'number') return (bv - av) * dir;
      return (String(bv ?? '') as string).localeCompare(String(av ?? '')) * dir;
    });

    return items;
  });

  /** Columns for the picker table, driven by the selected slot's category. */
  readonly activeCols = computed<PickerCol[]>(() => {
    const slot = this.selectedSlot();
    const cat = slot?.category ?? 'weapons';
    return PICKER_COLS[cat] ?? PICKER_COLS.weapons;
  });

  /** Thin wrapper so the template can call `renderCol(item, col)` without
   *  passing `this` explicitly (cleaner binding in Angular templates). */
  renderCol(item: Item, col: PickerCol): string {
    return col.value(item, this);
  }

  toggleSort(field: string | undefined): void {
    if (!field) return;
    if (this.pickerSort() === field) {
      this.pickerSortDir.set(this.pickerSortDir() === 'desc' ? 'asc' : 'desc');
    } else {
      this.pickerSort.set(field);
      this.pickerSortDir.set(field === 'name' ? 'asc' : 'desc');
    }
  }

  sortIndicator(field: string | undefined): string {
    if (!field || this.pickerSort() !== field) return '';
    return this.pickerSortDir() === 'desc' ? ' ▾' : ' ▴';
  }

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

  fmt(n: number | undefined | null, digits = 0): string {
    if (n == null || n === 0) return '—';
    return Number(n).toFixed(digits);
  }

  fmtRes(val: number | undefined | null): string {
    if (val == null || val === 0) return '—';
    return (Math.abs(val) * 100).toFixed(0) + '%';
  }

  fmtRegenTime(hp: number | undefined, rate: number | undefined): string {
    if (!hp || !rate) return '—';
    return (hp / rate).toFixed(1) + 's';
  }

  weaponType(item: Item): string { return weaponDisplayType(item); }

  canOverheat(item: Item): boolean { return !!(item.isBallistic && item.maxHeat); }

  /** Ammo count matching the main picker: ballistic → ammoCount; energy →
   *  calcWeaponAmmo against the current ship's power pool. */
  ammoForOption(opt: Item): string {
    if (opt.isBallistic) return opt.ammoCount?.toString() ?? '—';
    const ship = this.data.selectedShip();
    const poolSize = ship?.weaponPowerPoolSize ?? 4;
    const mult = ship?.ammoLoadMultiplier ?? 1;
    const allWeapons = this.data.allLoadoutWeapons();
    const maxPips = calcMaxPips(poolSize, allWeapons);
    const ammo = calcWeaponAmmo(opt, maxPips, poolSize, allWeapons, mult);
    return ammo != null ? ammo.toString() : '—';
  }

  shopMark(opt: Item): string { return opt.shopPrices?.length ? '✓' : '✗'; }

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

  // ── Center column: visual layout ──────────────────────

  /** True when ship qualifies for multi-crew collapsed layout */
  isMultiCrew = computed(() => {
    const ship = this.data.selectedShip();
    if (!ship) return false;
    const crew = ship.crew ?? 1;
    const weaponLeafCount = this.weaponLeafNodes().length;
    return crew > 2 && weaponLeafCount > 6;
  });

  /** All leaf weapon nodes (actual guns, not turret parents) */
  weaponLeafNodes = computed(() =>
    this.allFlatNodes().filter(n =>
      n.category === 'weapons' && n.children.length === 0 && n.item?.type !== 'WeaponMount'
    )
  );

  /** Shield, PP, cooler, QD, radar/avionics nodes */
  systemNodes = computed(() =>
    this.allFlatNodes().filter(n =>
      ['shields', 'power', 'cooling', 'quantum', 'avionics'].includes(n.category)
    )
  );

  /** Missile nodes (already collapsed per rack by slotTree) */
  missileLeafNodes = computed(() =>
    this.allFlatNodes().filter(n => n.category === 'missiles')
  );

  /** Group same-size slots for multi-crew bulk display */
  weaponBulkGroups = computed(() => this.buildBulkGroups(this.weaponLeafNodes()));
  missileBulkGroups = computed(() => this.buildBulkGroups(this.missileLeafNodes()));

  private buildBulkGroups(nodes: SlotNode[]): { label: string; size: number; count: number; equippedItem: Item | null; allSame: boolean; slotIds: string[]; rackLeafIds?: string[][]; category: CategoryId }[] {
    const buckets = new Map<number, SlotNode[]>();
    for (const n of nodes) {
      const sz = n.hardpoint.maxSize;
      if (!buckets.has(sz)) buckets.set(sz, []);
      buckets.get(sz)!.push(n);
    }
    const groups: { label: string; size: number; count: number; equippedItem: Item | null; allSame: boolean; slotIds: string[]; rackLeafIds?: string[][]; category: CategoryId }[] = [];
    for (const [sz, slots] of [...buckets.entries()].sort((a, b) => b[0] - a[0])) {
      const firstItem = slots[0].item;
      const allSame = slots.every(s => (s.item?.className ?? null) === (firstItem?.className ?? null));
      const rackLeafs = slots.filter(s => s.rackLeafIds).map(s => s.rackLeafIds!);
      groups.push({
        label: `${slots.length}× S${sz}`,
        size: sz,
        count: slots.length,
        equippedItem: firstItem,
        allSame,
        slotIds: slots.map(s => s.slotId),
        ...(rackLeafs.length ? { rackLeafIds: rackLeafs } : {}),
        category: slots[0].category,
      });
    }
    return groups;
  }

  /** Ship image for the center visual */
  shipImageSrc = computed(() => {
    const cls = this.data.selectedShip()?.className ?? '';
    return `ship-images/${cls}.webp`;
  });

  onShipImageError(img: HTMLImageElement): void {
    const cls = this.data.selectedShip()?.className ?? '';
    if (img.src.includes('.webp')) img.src = `ship-images/${cls}.png`;
    else if (img.src.includes('.png')) img.src = `ship-images/${cls.toUpperCase()}.png`;
    else img.style.opacity = '0';
  }

  /** All icons arranged in circular order with angle positions */
  radialSlots = computed<{ node: SlotNode; angle: number; category: CategoryId }[]>(() => {
    const weapons = this.weaponLeafNodes();
    const missiles = this.missileLeafNodes();
    const systems = this.systemNodes();

    // Order: weapons (top), right systems, missiles (bottom), left systems
    const leftSys = systems.filter(n => n.category === 'shields' || n.category === 'power');
    const rightSys = systems.filter(n => n.category === 'cooling' || n.category === 'quantum' || n.category === 'avionics');

    const segments: { nodes: SlotNode[]; category: CategoryId }[] = [];
    if (weapons.length) segments.push({ nodes: weapons, category: 'weapons' });
    if (rightSys.length) segments.push({ nodes: rightSys, category: 'cooling' });
    if (missiles.length) segments.push({ nodes: missiles, category: 'missiles' });
    if (leftSys.length) segments.push({ nodes: leftSys, category: 'shields' });

    const allNodes: { node: SlotNode; category: CategoryId }[] = [];
    for (const seg of segments) {
      for (const n of seg.nodes) allNodes.push({ node: n, category: n.category });
    }

    if (!allNodes.length) return [];

    const total = allNodes.length;
    // Start at top (-90deg) and go clockwise
    const startAngle = -90;
    const step = 360 / total;

    return allNodes.map((entry, i) => ({
      ...entry,
      angle: startAngle + i * step,
    }));
  });

  /** Equip an item to all slots in a bulk group */
  equipBulkGroup(group: { slotIds: string[]; rackLeafIds?: string[][] }, item: Item): void {
    for (const slotId of group.slotIds) {
      if (group.rackLeafIds) {
        // Missile bulk group
        for (const leafIds of group.rackLeafIds) {
          this.data.setRackItems(leafIds, item);
        }
      } else {
        this.data.setLoadoutItem(slotId, item);
      }
    }
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

/** Per-category picker column sets. Columns and labels mirror the main
 *  loadout picker (hardpoint-slot.html) so both views show the same data
 *  density. Value accessors return already-formatted display strings. */
const PICKER_COLS: Record<CategoryId, PickerCol[]> = {
  weapons: [
    { label: 'Sz',       sortField: 'size',                 kind: 'sz',   value: i => 'S' + (i.size ?? '—') },
    { label: 'Name',     sortField: 'name',                 kind: 'name', value: i => i.name ?? '—' },
    { label: 'Type',                                        kind: 'text', value: (i, c) => c.weaponType(i) },
    { label: 'Ammo',                                        kind: 'num',  value: (i, c) => c.ammoForOption(i) },
    { label: 'DPS',      sortField: 'dps',                  kind: 'num',  value: (i, c) => c.fmt(i.dps) },
    { label: 'Alpha',    sortField: 'alphaDamage',          kind: 'num',  value: (i, c) => c.fmt(i.alphaDamage, 1) },
    { label: 'Pen.Dst',  sortField: 'penetrationDistance',  kind: 'num',  value: (i, c) => i.penetrationDistance ? c.fmt(i.penetrationDistance, 2) + 'm' : '—' },
    { label: 'Pen.Rad',                                     kind: 'num',  value: (i, c) => i.penetrationMaxRadius ? c.fmt(i.penetrationMinRadius, 2) + '–' + c.fmt(i.penetrationMaxRadius, 2) + 'm' : '—' },
    { label: 'RPM',      sortField: 'fireRate',             kind: 'num',  value: (i, c) => c.fmt(i.fireRate) },
    { label: 'Vel',      sortField: 'projectileSpeed',      kind: 'num',  value: (i, c) => c.fmt(i.projectileSpeed) },
    { label: 'Range',    sortField: 'range',                kind: 'num',  value: (i, c) => c.fmt(i.range) },
    { label: 'Pwr',      sortField: 'powerDraw',            kind: 'num',  value: (i, c) => c.fmt(i.powerDraw, 2) },
    { label: 'EM',       sortField: 'emSignature',          kind: 'num',  value: (i, c) => c.fmt(i.emSignature) },
    { label: 'Overheat',                                    kind: 'text', value: (i, c) => c.canOverheat(i) ? '●' : '—' },
    { label: 'HP',       sortField: 'componentHp',          kind: 'num',  value: (i, c) => c.fmt(i.componentHp) },
    { label: 'Shop',                                        kind: 'shop', value: (i, c) => c.shopMark(i), title: 'Purchasable in-game' },
  ],
  shields: [
    { label: 'Sz',         sortField: 'size',              kind: 'sz',   value: i => 'S' + (i.size ?? '—') },
    { label: 'Name',       sortField: 'name',              kind: 'name', value: i => i.name ?? '—' },
    { label: 'Class',      sortField: 'itemClass',         kind: 'text', value: i => i.itemClass ?? '—' },
    { label: 'Grade',      sortField: 'grade',             kind: 'text', value: i => i.grade ?? '—' },
    { label: 'HP Pool',    sortField: 'hp',                kind: 'num',  value: (i, c) => c.fmt(i.hp) },
    { label: 'Regen/s',    sortField: 'regenRate',         kind: 'num',  value: (i, c) => c.fmt(i.regenRate) },
    { label: 'Regen Time',                                 kind: 'num',  value: (i, c) => c.fmtRegenTime(i.hp, i.regenRate) },
    { label: 'Enrg Res',   sortField: 'resistEnrgMax',     kind: 'num',  value: (i, c) => c.fmtRes(i.resistEnrgMax) },
    { label: 'Dmg Delay',  sortField: 'damagedRegenDelay', kind: 'num',  value: (i, c) => c.fmt(i.damagedRegenDelay, 2) + 's' },
    { label: 'Dwn Delay',  sortField: 'downedRegenDelay',  kind: 'num',  value: (i, c) => c.fmt(i.downedRegenDelay, 2) + 's' },
    { label: 'Min Pwr',    sortField: 'powerDraw',         kind: 'num',  value: (i, c) => c.fmt(i.powerDraw, 2) },
    { label: 'EM Max',     sortField: 'emMax',             kind: 'num',  value: (i, c) => c.fmt(i.emMax) },
    { label: 'Health',                                     kind: 'num',  value: (i, c) => c.fmt(i.componentHp) },
    { label: 'Shop',                                       kind: 'shop', value: (i, c) => c.shopMark(i) },
  ],
  cooling: [
    { label: 'Sz',       sortField: 'size',        kind: 'sz',   value: i => 'S' + (i.size ?? '—') },
    { label: 'Name',     sortField: 'name',        kind: 'name', value: i => i.name ?? '—' },
    { label: 'Class',    sortField: 'itemClass',   kind: 'text', value: i => i.itemClass ?? '—' },
    { label: 'Grade',    sortField: 'grade',       kind: 'text', value: i => i.grade ?? '—' },
    { label: 'Cooling',  sortField: 'coolingRate', kind: 'num',  value: (i, c) => c.fmt(i.coolingRate, 1) },
    { label: 'Min Pwr',  sortField: 'powerMin',    kind: 'num',  value: (i, c) => c.fmt(i.powerMin) },
    { label: 'Max Pwr',  sortField: 'powerMax',    kind: 'num',  value: (i, c) => c.fmt(i.powerMax) },
    { label: 'EM Max',   sortField: 'emMax',       kind: 'num',  value: (i, c) => c.fmt(i.emMax) },
    { label: 'IR Max',   sortField: 'irSignature', kind: 'num',  value: (i, c) => c.fmt(i.irSignature) },
    { label: 'Health',   sortField: 'componentHp', kind: 'num',  value: (i, c) => c.fmt(i.componentHp) },
    { label: 'Shop',                               kind: 'shop', value: (i, c) => c.shopMark(i) },
  ],
  power: [
    { label: 'Sz',            sortField: 'size',                kind: 'sz',   value: i => 'S' + (i.size ?? '—') },
    { label: 'Name',          sortField: 'name',                kind: 'name', value: i => i.name ?? '—' },
    { label: 'Class',         sortField: 'itemClass',           kind: 'text', value: i => i.itemClass ?? '—' },
    { label: 'Grade',         sortField: 'grade',               kind: 'text', value: i => i.grade ?? '—' },
    { label: 'Pwr Max',       sortField: 'powerOutput',         kind: 'num',  value: (i, c) => c.fmt(i.powerOutput) },
    { label: 'Dist Max',      sortField: 'distortionMax',       kind: 'num',  value: (i, c) => c.fmt(i.distortionMax) },
    { label: 'Dist Decay',    sortField: 'distortionDecayRate', kind: 'num',  value: (i, c) => c.fmt(i.distortionDecayRate, 2) },
    { label: 'Dist Recovery',                                   kind: 'num',  value: (i, c) => c.fmt(i.distortionDecayDelay, 2) + 's' },
    { label: 'EM/Seg',        sortField: 'emMax',               kind: 'num',  value: (i, c) => c.fmt(i.emMax) },
    { label: 'EM Decay',                                        kind: 'num',  value: (i, c) => c.fmt(i.emDecayRate, 2) },
    { label: 'Health',        sortField: 'componentHp',         kind: 'num',  value: (i, c) => c.fmt(i.componentHp) },
    { label: 'Shop',                                            kind: 'shop', value: (i, c) => c.shopMark(i) },
  ],
  quantum: [
    { label: 'Sz',           sortField: 'size',         kind: 'sz',   value: i => 'S' + (i.size ?? '—') },
    { label: 'Name',         sortField: 'name',         kind: 'name', value: i => i.name ?? '—' },
    { label: 'Class',        sortField: 'itemClass',    kind: 'text', value: i => i.itemClass ?? '—' },
    { label: 'Grade',        sortField: 'grade',        kind: 'text', value: i => i.grade ?? '—' },
    { label: 'Max Speed',    sortField: 'speed',        kind: 'num',  value: i => i.speed ? (i.speed / 1000).toFixed(0) + ' Mm/s' : '—' },
    { label: 'Fuel Rate',    sortField: 'fuelRate',     kind: 'num',  value: i => i.fuelRate ? i.fuelRate.toFixed(5) : '—' },
    { label: 'Spool Nav',    sortField: 'spoolTime',    kind: 'num',  value: (i, c) => c.fmt(i.spoolTime, 1) + 's' },
    { label: 'Max Cooldown', sortField: 'cooldownTime', kind: 'num',  value: (i, c) => c.fmt(i.cooldownTime, 1) + 's' },
    { label: 'EM Max',       sortField: 'emMax',        kind: 'num',  value: (i, c) => c.fmt(i.emMax) },
    { label: 'Health',       sortField: 'hp',           kind: 'num',  value: (i, c) => c.fmt(i.hp) },
    { label: 'Shop',                                    kind: 'shop', value: (i, c) => c.shopMark(i) },
  ],
  missiles: [
    { label: 'Sz',           sortField: 'size',            kind: 'sz',   value: i => 'S' + (i.size ?? '—') },
    { label: 'Name',         sortField: 'name',            kind: 'name', value: i => i.name ?? '—' },
    { label: 'Type',         sortField: 'subType',         kind: 'text', value: i => i.subType ?? '—' },
    { label: 'Damage',       sortField: 'alphaDamage',     kind: 'num',  value: (i, c) => c.fmt(i.alphaDamage) },
    { label: 'Speed',        sortField: 'projectileSpeed', kind: 'num',  value: (i, c) => c.fmt(i.projectileSpeed) },
    { label: 'Acquisition',  sortField: 'acquisition',     kind: 'text', value: i => i.acquisition ?? '—' },
    { label: 'Arm Time',     sortField: 'armTime',         kind: 'num',  value: (i, c) => c.fmt(i.armTime, 2) + 's' },
    { label: 'Lock Time',    sortField: 'lockTime',        kind: 'num',  value: (i, c) => c.fmt(i.lockTime, 2) + 's' },
    { label: 'Ignite',       sortField: 'igniteTime',      kind: 'num',  value: (i, c) => c.fmt(i.igniteTime, 2) + 's' },
    { label: 'Lock Angle',   sortField: 'lockAngle',       kind: 'num',  value: (i, c) => c.fmt(i.lockAngle, 0) + '°' },
    { label: 'Lock Min',     sortField: 'lockRangeMin',    kind: 'num',  value: (i, c) => c.fmt(i.lockRangeMin) + 'm' },
    { label: 'Lock Max',     sortField: 'lockRangeMax',    kind: 'num',  value: (i, c) => c.fmt(i.lockRangeMax) + 'm' },
    { label: 'Shop',                                       kind: 'shop', value: (i, c) => c.shopMark(i) },
  ],
  avionics: [
    { label: 'Sz',      sortField: 'size',           kind: 'sz',   value: i => 'S' + (i.size ?? '—') },
    { label: 'Name',    sortField: 'name',           kind: 'name', value: i => i.name ?? '—' },
    { label: 'Class',   sortField: 'itemClass',      kind: 'text', value: i => i.itemClass ?? '—' },
    { label: 'Grade',   sortField: 'grade',          kind: 'text', value: i => i.grade ?? '—' },
    { label: 'Aim Min', sortField: 'aimMin',         kind: 'num',  value: (i, c) => c.fmt(i.aimMin) },
    { label: 'Aim Max', sortField: 'aimMax',         kind: 'num',  value: (i, c) => c.fmt(i.aimMax) },
    { label: 'IR',      sortField: 'irSensitivity',  kind: 'num',  value: (i, c) => c.fmt(i.irSensitivity, 2) },
    { label: 'EM',      sortField: 'emSensitivity',  kind: 'num',  value: (i, c) => c.fmt(i.emSensitivity, 2) },
    { label: 'CS',      sortField: 'csSensitivity',  kind: 'num',  value: (i, c) => c.fmt(i.csSensitivity, 2) },
    { label: 'Max Pwr', sortField: 'powerDraw',      kind: 'num',  value: (i, c) => c.fmt(i.powerDraw, 2) },
    { label: 'EM Max',  sortField: 'emMax',          kind: 'num',  value: (i, c) => c.fmt(i.emMax) },
    { label: 'Health',  sortField: 'componentHp',    kind: 'num',  value: (i, c) => c.fmt(i.componentHp) },
    { label: 'Shop',                                 kind: 'shop', value: (i, c) => c.shopMark(i) },
  ],
};
