import { Injectable, signal, computed, effect } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { VerseDb, Ship, Item, CartEntry, calcMaxPips } from '../models/db.models';

export type DataMode = 'live' | 'ptu';

@Injectable({ providedIn: 'root' })
export class DataService {
  readonly dataMode = signal<DataMode>('live');
  readonly db = signal<VerseDb | null>(null);
  readonly selectedShip = signal<Ship | null>(null);
  readonly loadout = signal<Record<string, Item>>({});
  readonly focusedItem = signal<Item | null>(null);
  readonly poweredOff = signal<Set<string>>(new Set());
  powerAlloc = signal<Record<string, number>>({});
  weaponsPower = signal<number>(0);
  thrusterPower = signal<number>(4);
  flightMode = signal<'scm' | 'nav'>('scm');

  // Ships hidden from picker (ground vehicles until properly supported, non-player ships)
  private readonly hiddenShips = new Set([
    'tmbl_cyclone', 'tmbl_cyclone_aa', 'tmbl_cyclone_mt', 'tmbl_cyclone_rc', 'tmbl_cyclone_rn', 'tmbl_cyclone_tr',
    'tmbl_nova', 'rsi_ursa_rover', 'rsi_lynx',
    'xian_nox', 'xian_nox_kue',
    'orig_x1', 'orig_x1_force', 'orig_x1_velocity',
    'mrai_pulse', 'mrai_pulse_lx',
    'anvl_lightning_f8',  // F8A Lightning — not player-owned
    'anvl_carrack_expedition',  // just a paintjob of the Carrack
  ]);
  readonly ships = computed(() =>
    (this.db()?.ships ?? []).filter(s => !this.hiddenShips.has(s.className.toLowerCase()))
  );
  readonly items = computed(() => this.db()?.items ?? []);
  readonly isLoaded = computed(() => this.db() !== null);

  /** All weapons (energy + ballistic) currently in the loadout, for ammo pool calculation.
   *  Excludes PDC (Point Defense Cannon) weapons — those are AI-controlled. */
  allLoadoutWeapons = computed(() =>
    Object.entries(this.loadout()).filter(
      ([key, i]) => i !== null && (i.type === 'WeaponGun' || i.type === 'WeaponTachyon') &&
        !key.toLowerCase().includes('_pdc')
    ).map(([, i]) => i as Item)
  );

  totalPowerOut = computed(() => {
    const loadout = this.loadout();
    return Object.values(loadout)
      .filter((item): item is Item => item !== null && item.type === 'PowerPlant')
      .reduce((sum, item) => sum + (item.powerOutput ?? 0), 0);
  });

  /** Power allocated to mining/salvage tools (2 pips per tool, togglable). */
  toolPower = signal(0);

  /** Tractor beam power: 2-pip merged block, toggled on/off. */
  tractorPower = signal<number>(0);

  /** Whether the current ship has tractor beam(s) in loadout. */
  hasTractorBeams = computed(() =>
    Object.values(this.loadout()).some(i => i?.type === 'TractorBeam')
  );

  totalPowerUsed = computed(() =>
    Object.values(this.powerAlloc()).reduce((sum, n) => sum + n, 0) + this.weaponsPower() + this.toolPower() + this.tractorPower()
  );

  /** Base path prefix for the current data mode (e.g. 'live/' or 'ptu/'). */
  readonly dataPrefix = computed(() => `${this.dataMode()}/`);

  /** Fires whenever dataMode changes — notifies components that secondary data (missions, crafting, changelog) should reload. */
  readonly modeVersion = signal(0);

  /** PTU availability — loaded from config.json */
  readonly ptuEnabled = signal(false);
  readonly ptuLabel = signal('');

  constructor(private http: HttpClient) {
    // Load PTU config
    this.http.get<{ ptuEnabled: boolean; ptuLabel?: string }>('config.json', { headers: { 'Cache-Control': 'no-cache' } })
      .subscribe({
        next: cfg => {
          this.ptuEnabled.set(cfg.ptuEnabled);
          this.ptuLabel.set(cfg.ptuLabel ?? '');
          // Force back to LIVE if PTU is disabled
          if (!cfg.ptuEnabled && this.dataMode() === 'ptu') {
            this.dataMode.set('live');
          }
        },
        error: () => {},
      });

    // React to dataMode changes: reload the main database
    effect(() => {
      const prefix = this.dataPrefix();
      this.http.get<VerseDb>(`${prefix}versedb_data.json`).subscribe({
        next: db => {
          this.db.set(db);
          this.selectedShip.set(null);
          this.loadout.set({});
          this.modeVersion.update(v => v + 1);
          // Auto-select Gladius as default ship
          const gladius = db.ships.find(s => s.className === 'aegs_gladius');
          if (gladius) this.selectShip(gladius);
        },
        error: () => console.warn(`Could not load ${prefix}versedb_data.json`),
      });
    });
  }

  switchMode(mode: DataMode): void {
    if (mode !== this.dataMode()) {
      this.dataMode.set(mode);
    }
  }

  loadFromFile(file: File): void {
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const db = JSON.parse(ev.target!.result as string) as VerseDb;
        this.db.set(db);
        this.selectedShip.set(null);
        this.loadout.set({});
      } catch (e) {
        alert('Invalid JSON file: ' + e);
      }
    };
    reader.readAsText(file);
  }

  togglePower(slotId: string): void {
    const current = new Set(this.poweredOff());
    if (current.has(slotId)) {
      current.delete(slotId);
    } else {
      current.add(slotId);
    }
    this.poweredOff.set(current);
  }

  selectShip(ship: Ship): void {
    this.selectedShip.set(ship);
    this.poweredOff.set(new Set());
    this.powerAlloc.set({});
    this.weaponsPower.set(0);
    this.tractorPower.set(0);
    // Thrusters: default to 50% of max bars
    const thrustMax = ship.thrusterPowerBars ?? 4;
    this.thrusterPower.set(Math.max(1, Math.round(thrustMax * 0.5)));
    const newLoadout: Record<string, Item> = {};
    if (ship.defaultLoadout) {
      // Top-level hardpoints (includes mounts/gimbals now that WeaponMount items exist)
      for (const hp of ship.hardpoints) {
        const defaultCls = ship.defaultLoadout[hp.id.toLowerCase()];
        if (!defaultCls) continue;
        const item = this.items().find(
          i => i.className.toLowerCase() === defaultCls.toLowerCase()
        );
        if (item) {
          newLoadout[hp.id] = item;
        }
      }
      // Sub-slots (dot-notation keys whose values are weapons or missiles)
      for (const [dotKey, cls] of Object.entries(ship.defaultLoadout)) {
        if (!dotKey.includes('.')) continue;
        // Skip sub-slots whose parent module doesn't have the matching sub-port
        const topKey = dotKey.split('.')[0];
        const parentItem = newLoadout[topKey];
        if (parentItem?.type === 'Module') {
          const subs = parentItem.subPorts ?? [];
          if (subs.length === 0) {
            continue; // Module has no sub-ports — skip all children
          }
          const firstSeg = dotKey.split('.')[1];
          if (!subs.some((sp: any) => sp.id === firstSeg)) {
            continue; // Sub-port doesn't exist on this module variant
          }
        }
        const item = this.items().find(i => i.className.toLowerCase() === cls.toLowerCase());
        if (item && (item.type === 'WeaponGun' || item.type === 'Missile' || item.type === 'WeaponMining' || item.type === 'SalvageHead' || item.type === 'SalvageModifier' || item.type === 'TractorBeam')) newLoadout[dotKey] = item;
      }

      // PDC turrets: replace turret item with the actual weapon directly
      const pdcWeaponMap: Record<string, string> = {
        'turret_pdc_behr_a': 'behr_laserrepeater_pdc_s1',  // M2C "Swarm"
        'turret_pdc_behr_g': 'behr_ballisticgatling_pdc_s1',  // MRX "Torrent"
        'turret_pdc_behr_m': 'klwe_laserrepeater_pdc_s2',  // PPB-116 "Pepperbox" (placeholder)
      };
      for (const [hpId, item] of Object.entries(newLoadout)) {
        const weaponCls = pdcWeaponMap[item.className.toLowerCase()];
        if (weaponCls) {
          const weapon = this.items().find(i => i.className.toLowerCase() === weaponCls);
          if (weapon) newLoadout[hpId] = weapon;  // replace turret with weapon
        }
      }
    }
    this.loadout.set(newLoadout);

    // Initialize power allocations using SC default power distribution:
    // - Weapons: 50% of poolSize
    // - Shields: 50% of max (split across primaries)
    // - Coolers: minimum pips (at least 1)
    // - Life Support: ON (turnedOnByDefault)
    // - Radar/QD: OFF at spawn
    const allocInit: Record<string, number> = {};
    let shieldCount = 0;
    for (const [hpId, item] of Object.entries(newLoadout)) {
      if (this.isFlightRestricted(item)) {
        allocInit[hpId] = 0;
        continue;
      }
      if (item.type === 'Shield') {
        shieldCount++;
        if (shieldCount <= 2) {
          // Primary shields: 50% of their max pips, but at least the min threshold
          const maxPips = Math.max(1, (item.powerMax ?? 0) - 1);
          const b = item.powerBands ?? [];
          const minThreshold = b.length <= 1 ? 1 : Math.max(1, b[1].start - b[0].start);
          allocInit[hpId] = Math.max(minThreshold, Math.round(maxPips * 0.5));
        }
        // Excess shields (3rd+): no power allocation
      } else if (item.type === 'Cooler') {
        // Coolers: start at minimum band
        const b = item.powerBands ?? [];
        const cMin = b.length <= 1 ? 1 : Math.max(1, b[1].start - b[0].start);
        allocInit[hpId] = cMin;
      } else if (item.type === 'LifeSupportGenerator') {
        // Life support: ON by default
        allocInit[hpId] = 1;
      } else if (item.type === 'Radar') {
        // Radar: ON at spawn at minimum power
        const pd = item.powerDraw ?? 1;
        const mcf = item.minConsumptionFraction ?? 0.25;
        allocInit[hpId] = Math.max(1, Math.round(pd * mcf));
      } else if (item.type === 'QuantumDrive') {
        // QD: OFF at spawn
        allocInit[hpId] = 0;
      } else if (item.powerBands?.length) {
        allocInit[hpId] = item.powerMin ?? 1;
      }
    }
    this.powerAlloc.set(allocInit);

    // Weapons: default to 50% of poolSize
    const poolSize = ship.weaponPowerPoolSize ?? 0;
    const wpnDefault = Math.max(0, Math.round(poolSize * 0.5));
    this.weaponsPower.set(wpnDefault);

    // Tools: 1 pip per tool (MOLE uses 2 pips per turret), default ON
    const toolCount = Object.values(newLoadout).filter(
      i => i?.type === 'WeaponMining' || i?.type === 'SalvageHead'
    ).length;
    const pipsPerTool = ship.className.toLowerCase() === 'argo_mole' ? 2 : 1;
    this.toolPower.set(toolCount * pipsPerTool);
  }

  resetLoadout(): void {
    const ship = this.selectedShip();
    if (ship) this.selectShip(ship);
  }

  setLoadoutItem(slotId: string, item: Item | null): void {
    const current = { ...this.loadout() };
    const prefix = slotId.toLowerCase() + '.';

    // Always clear child sub-slot entries when changing a parent slot
    for (const key of Object.keys(current)) {
      if (key.toLowerCase().startsWith(prefix)) delete current[key];
    }

    if (item) {
      current[slotId] = item;
      const defaultLoadout = this.selectedShip()?.defaultLoadout ?? {};

      if (item.weaponLock) {
        // Turret with weapon lock: auto-fill gun sub-slots with locked weapon
        const lockedWeapon = this.items().find(i => i.className.toLowerCase() === item.weaponLock!.toLowerCase());
        if (lockedWeapon) {
          for (const [dotKey, cls] of Object.entries(defaultLoadout)) {
            if (!dotKey.startsWith(prefix)) continue;
            const defaultItem = this.items().find(i => i.className.toLowerCase() === cls.toLowerCase());
            if (defaultItem?.type === 'WeaponGun') current[dotKey] = lockedWeapon;
          }
        }
      } else if (item.type === 'Module') {
        // Module equipped: auto-fill sub-ports with default items
        const moduleDefaults: Record<string, Record<string, string>> = {
          'aegs_retaliator_module_front_bomber': {
            'hardpoint_torpedo_launcher_fore': 'mrck_s09_aegs_retaliator_fore',
            'hardpoint_torpedo_launcher_fore.missile_01_attach': 'misl_s09_cs_taln_argos',
            'hardpoint_torpedo_launcher_fore.missile_02_attach': 'misl_s09_cs_taln_argos',
            'hardpoint_torpedo_launcher_fore.missile_03_attach': 'misl_s09_cs_taln_argos',
            'hardpoint_torpedo_launcher_fore.missile_04_attach': 'misl_s09_cs_taln_argos',
          },
          'aegs_retaliator_module_rear_bomber': {
            'hardpoint_torpedo_launcher_rear': 'mrck_s09_aegs_retaliator_rear',
            'hardpoint_torpedo_launcher_rear.missile_01_attach': 'misl_s09_cs_taln_argos',
            'hardpoint_torpedo_launcher_rear.missile_02_attach': 'misl_s09_cs_taln_argos',
          },
          'rsi_aurora_mk2_module_missile': {
            'missile_01_rack': 'mrck_s01_rsi_aurora_mk2_combat_module_rack',
            'missile_01_rack.missile_01_attach': 'misl_s02_em_taln_dominator',
            'missile_02_rack': 'mrck_s01_rsi_aurora_mk2_combat_module_rack',
            'missile_02_rack.missile_01_attach': 'misl_s02_em_taln_dominator',
            'missile_03_rack': 'mrck_s01_rsi_aurora_mk2_combat_module_rack',
            'missile_03_rack.missile_01_attach': 'misl_s02_em_taln_dominator',
            'missile_04_rack': 'mrck_s01_rsi_aurora_mk2_combat_module_rack',
            'missile_04_rack.missile_01_attach': 'misl_s02_em_taln_dominator',
            'missile_05_rack': 'mrck_s01_rsi_aurora_mk2_combat_module_rack',
            'missile_05_rack.missile_01_attach': 'misl_s02_em_taln_dominator',
            'missile_06_rack': 'mrck_s01_rsi_aurora_mk2_combat_module_rack',
            'missile_06_rack.missile_01_attach': 'misl_s02_em_taln_dominator',
            'missile_07_rack': 'mrck_s01_rsi_aurora_mk2_combat_module_rack',
            'missile_07_rack.missile_01_attach': 'misl_s02_em_taln_dominator',
            'missile_08_rack': 'mrck_s01_rsi_aurora_mk2_combat_module_rack',
            'missile_08_rack.missile_01_attach': 'misl_s02_em_taln_dominator',
            'hardpoint_shield_generator_back': 'shld_behr_s01_5sa_scitem',
          },
        };
        const modDefaults = moduleDefaults[item.className.toLowerCase()];
        if (modDefaults) {
          for (const [subKey, cls] of Object.entries(modDefaults)) {
            const fullKey = `${slotId}.${subKey}`;
            const subItem = this.items().find(i => i.className.toLowerCase() === cls.toLowerCase());
            if (subItem) current[fullKey] = subItem;
          }
        }
      } else if (item.type !== 'WeaponGun' && item.type !== 'WeaponTachyon') {
        // Non-gun item: restore default sub-slot weapons and missiles from this ship's default loadout
        for (const [dotKey, cls] of Object.entries(defaultLoadout)) {
          if (!dotKey.startsWith(prefix)) continue;
          const subItem = this.items().find(i => i.className.toLowerCase() === cls.toLowerCase());
          if (subItem && (subItem.type === 'WeaponGun' || subItem.type === 'Missile' || subItem.type === 'MissileLauncher' || subItem.type === 'Shield' || subItem.type === 'WeaponMining' || subItem.type === 'SalvageHead' || subItem.type === 'TractorBeam')) {
            current[dotKey] = subItem;
          }
        }
      }
    } else {
      delete current[slotId];
      // Remove cleared slot from powered-off set
      const pOff = new Set(this.poweredOff());
      if (pOff.delete(slotId)) this.poweredOff.set(pOff);
    }
    this.loadout.set(current);
    this.initPowerAlloc(slotId, item);
    this.clampWeaponsPower();
  }

  /** Clamp all power allocations to fit within total power plant output. */
  private clampWeaponsPower(): void {
    const poolSize = this.selectedShip()?.weaponPowerPoolSize ?? 0;
    // Clamp weapon pips to maxPips
    if (poolSize > 0) {
      const maxPips = calcMaxPips(poolSize, this.allLoadoutWeapons());
      if (this.weaponsPower() > maxPips) {
        this.weaponsPower.set(maxPips);
      }
    }
    // Clamp tool power to current tool count × pips per tool
    const toolCount = Object.values(this.loadout()).filter(
      i => i?.type === 'WeaponMining' || i?.type === 'SalvageHead'
    ).length;
    const ppt = this.selectedShip()?.className?.toLowerCase() === 'argo_mole' ? 2 : 1;
    const toolMax = toolCount * ppt;
    if (this.toolPower() > toolMax) {
      this.toolPower.set(toolMax);
    }
    // Clamp total allocations to power plant output
    const totalOut = this.totalPowerOut();
    if (totalOut > 0 && this.totalPowerUsed() > totalOut) {
      // Reduce allocations starting from the end until we fit
      const alloc = { ...this.powerAlloc() };
      let excess = this.totalPowerUsed() - totalOut;
      // First try reducing weapon power
      if (excess > 0 && this.weaponsPower() > 0) {
        const reduce = Math.min(this.weaponsPower(), excess);
        this.weaponsPower.update(v => v - reduce);
        excess -= reduce;
      }
      // Then reduce individual component allocations (reverse order)
      if (excess > 0) {
        const keys = Object.keys(alloc).reverse();
        for (const key of keys) {
          if (excess <= 0) break;
          const reduce = Math.min(alloc[key], excess);
          alloc[key] -= reduce;
          excess -= reduce;
        }
        this.powerAlloc.set(alloc);
      }
    }
  }

  setRackItems(leafIds: string[], item: Item | null): void {
    const current = { ...this.loadout() };
    for (const id of leafIds) {
      if (item) {
        current[id] = item;
      } else {
        delete current[id];
      }
      this.initPowerAlloc(id, item);
    }
    this.loadout.set(current);
  }

  getMod(alloc: number, item: Item | null): number {
    if (!item?.powerBands?.length) return 1;
    let mod = 0;
    for (const band of item.powerBands) {
      if (band.start <= alloc) mod = band.mod;
      else break;
    }
    return mod;
  }

  setPowerAlloc(hpId: string, n: number, item: Item | null): void {
    if (this.isFlightRestricted(item)) return;
    // Radar/QD: actual max = powerDraw (PSRU), not powerMax (from bands)
    const max = (item?.type === 'Radar' || item?.type === 'QuantumDrive')
      ? (item?.powerDraw ?? item?.powerMax ?? 0)
      : (item?.powerMax ?? 0);
    const current = this.powerAlloc()[hpId] ?? 0;
    const totalOut = this.totalPowerOut();
    const headroom = totalOut - (this.totalPowerUsed() - current);
    const clamped = Math.max(0, Math.min(max, Math.min(n, headroom)));
    this.powerAlloc.update(a => ({ ...a, [hpId]: clamped }));
  }

  initPowerAlloc(hpId: string, item: Item | null): void {
    this.powerAlloc.update(a => {
      const copy = { ...a };
      if (item?.powerBands?.length) {
        const restricted = this.isFlightRestricted(item);
        copy[hpId] = restricted ? 0 : (item.powerMin ?? 1);
      } else {
        delete copy[hpId];
      }
      return copy;
    });
  }

  isFlightRestricted(item: Item | null): boolean {
    if (!item) return false;
    const mode = this.flightMode();
    return (mode === 'scm' && item.type === 'QuantumDrive') ||
           (mode === 'nav' && item.type === 'Shield');
  }

  toggleFlightMode(): void {
    const next = this.flightMode() === 'scm' ? 'nav' : 'scm';
    this.flightMode.set(next);
    const ship = this.selectedShip();
    const loadout = this.loadout();

    if (next === 'nav') {
      // NAV mode: weapons off, shields off, QD on
      this.weaponsPower.set(0);
      this.powerAlloc.update(alloc => {
        const copy = { ...alloc };
        for (const [hpId, item] of Object.entries(loadout)) {
          if (item.type === 'Shield') copy[hpId] = 0;
          if (item.type === 'QuantumDrive') {
            copy[hpId] = item.powerDraw ?? item.powerMin ?? 1;
          }
        }
        return copy;
      });
    } else {
      // SCM mode: reset all to defaults
      const poolSize = ship?.weaponPowerPoolSize ?? 0;
      this.weaponsPower.set(Math.max(0, Math.round(poolSize * 0.5)));
      const thrustMax = ship?.thrusterPowerBars ?? 4;
      this.thrusterPower.set(Math.max(1, Math.round(thrustMax * 0.5)));

      const allocInit: Record<string, number> = {};
      let shieldCount = 0;
      for (const [hpId, item] of Object.entries(loadout)) {
        if (item.type === 'Shield') {
          shieldCount++;
          if (shieldCount <= 2) {
            const maxPips = Math.max(1, (item.powerMax ?? 0) - 1);
            allocInit[hpId] = Math.max(1, Math.round(maxPips * 0.5));
          }
        } else if (item.type === 'Cooler') {
          const b = item.powerBands ?? [];
          allocInit[hpId] = b.length <= 1 ? 1 : Math.max(1, b[1].start - b[0].start);
        } else if (item.type === 'LifeSupportGenerator') {
          allocInit[hpId] = 1;
        } else if (item.type === 'Radar') {
          const pd = item.powerDraw ?? 1;
          const mcf = item.minConsumptionFraction ?? 0.25;
          allocInit[hpId] = Math.max(1, Math.round(pd * mcf));
        } else if (item.type === 'QuantumDrive') {
          allocInit[hpId] = 0;
        } else if (item.powerBands?.length) {
          allocInit[hpId] = item.powerMin ?? 1;
        }
      }
      this.powerAlloc.set(allocInit);
    }
  }

  // Distribute n total segments across shield slots in loadout order.
  // Each shield either gets 0 (off) or powerMin..powerMax.
  setShieldsPower(n: number, slots: { hpId: string; item: Item }[]): void {
    if (this.flightMode() === 'nav') return;
    const totalOut  = this.totalPowerOut();
    const shieldUsed = slots.reduce((s, sl) => s + (this.powerAlloc()[sl.hpId] ?? 0), 0);
    const headroom  = totalOut - (this.totalPowerUsed() - shieldUsed);
    let remaining = Math.max(0, Math.min(n, headroom));

    const newAlloc = { ...this.powerAlloc() };
    // Phase 1: give each shield its minimum first (band-based block size)
    for (const { hpId, item } of slots) {
      const b = item.powerBands ?? [];
      const pMin = b.length <= 1 ? 1 : Math.max(1, b[1].start - b[0].start);
      if (remaining >= pMin) {
        newAlloc[hpId] = pMin;
        remaining -= pMin;
      } else {
        newAlloc[hpId] = 0;
      }
    }
    // Phase 2: distribute remaining as extras up to each shield's max
    for (const { hpId, item } of slots) {
      if (newAlloc[hpId] === 0 || remaining <= 0) continue;
      const pMax = item.powerMax ?? 0;
      const extra = Math.min(remaining, pMax - newAlloc[hpId]);
      if (extra > 0) {
        newAlloc[hpId] += extra;
        remaining -= extra;
      }
    }
    this.powerAlloc.set(newAlloc);
  }

  setThrusterPower(n: number): void {
    const maxBars = this.selectedShip()?.thrusterPowerBars ?? 4;
    this.thrusterPower.set(Math.max(1, Math.min(n, maxBars)));
  }

  setWeaponsPower(n: number): void {
    if (this.flightMode() === 'nav') return;
    const poolSize = this.selectedShip()?.weaponPowerPoolSize ?? 0;
    const maxPips = calcMaxPips(poolSize, this.allLoadoutWeapons());
    const totalOut = this.totalPowerOut();
    const headroom = totalOut - (this.totalPowerUsed() - this.weaponsPower());
    this.weaponsPower.set(Math.max(0, Math.min(n, maxPips, headroom)));
  }

  // Maps item className (lowercase) -> ship className (lowercase) for items that
  // appear in exactly one ship's default loadout — these are bespoke/ship-exclusive.
  readonly shipExclusiveMap = computed(() => {
    const db = this.db();
    if (!db) return new Map<string, string>();

    // Only weapon/mount/turret/missile types can be ship-exclusive.
    // Standard system components (power plants, coolers, shields, QDs) are always
    // universally swappable even if they only appear in one ship's default loadout.
    const equippableTypes = new Set([
      'WeaponGun', 'WeaponTachyon', 'WeaponMount', 'Turret', 'TurretBase',
      'MissileLauncher', 'BombLauncher', 'Missile',
      'WeaponMining', 'MiningModifier', 'ToolArm', 'UtilityTurret', 'SalvageHead', 'SalvageModifier',
    ]);
    const equippable = new Set(
      db.items.filter(i => equippableTypes.has(i.type)).map(i => i.className.toLowerCase())
    );

    const appearsIn = new Map<string, string[]>();
    for (const ship of db.ships) {
      for (const cls of Object.values(ship.defaultLoadout ?? {})) {
        const clsL = cls.toLowerCase();
        if (!equippable.has(clsL)) continue;
        if (!appearsIn.has(clsL)) appearsIn.set(clsL, []);
        if (!appearsIn.get(clsL)!.includes(ship.className.toLowerCase()))
          appearsIn.get(clsL)!.push(ship.className.toLowerCase());
      }
    }

    const exclusive = new Map<string, string>();
    for (const [cls, ships] of appearsIn)
      if (ships.length === 1) exclusive.set(cls, ships[0]);
    return exclusive;
  });

  // Vanguard nose slot: these exclusives only appear on that specific hardpoint
  private readonly VANGUARD_NOSE_ONLY = new Set([
    'behr_lasercannon_vng_s2',
    'behr_laserrepeater_vng_s2',
    'behr_ballisticcannon_vng_s2',
    'behr_distortionrepeater_vng_s2',
  ]);

  // Wolf hull weapons: only on L-21/L-22 Wolf ships, swappable between both
  private readonly WOLF_WEAPONS = new Set([
    'krig_ballisticgatling_bespoke_s4',  // Relentless L-21 Gatling
    'krig_laserrepeater_bespoke_s4',     // Axiom L-22 Repeater
  ]);

  // Items that should never appear in weapon pickers (locked to specific hardpoints only)
  private readonly PICKER_BLACKLIST = new Set([
    // Jericho rocket pods
    'rpod_s3_fski_9x_s3',
    'rpod_s2_hrst_12x_s1',
    'rpod_s3_hrst_18x_s1',
    'rpod_s1_hrst_6x_s1',
    // Vanduul weapons (ship-locked)
    'vncl_plasmacannon_s2',     // WHIP Cannon
    'vncl_plasmacannon_s3',     // WARLORD Cannon
    'vncl_plasmacannon_s5',     // WRATH Cannon
    'vncl_gen2_plasmacannon_s5',// WRATH Cannon (Gen2)
    'vncl_lasercannon_s1',      // WEAK Repeater
    'vncl_lasercannon_s2',      // WASP Repeater
    // Hurston Storm (ship-locked)
    'hrst_storm_laserrepeater_s3', // Reign-3 Repeater
    // Liberator rocket pods (TODO: determine where these belong)
    'rpod_s1_thcn_4x_s2',         // Liberator
    'rpod_s2_thcn_8x_s2',         // Liberator Prime
    'rpod_s3_thcn_12x_s2',        // Liberator Ultra
  ]);

  getOptionsForSlot(hp: { id: string; minSize: number; maxSize: number; type: string; flags?: string; portTags?: string; allTypes: { type: string }[] }): Item[] {
    const { minSize, maxSize } = hp;
    const allTypes = hp.allTypes?.map(t => t.type) ?? [];

    // Port-tag filtering: if the hardpoint has portTags, items with ship-specific
    // itemTags must share at least one tag with the port. Items without itemTags
    // (universal items) always pass.
    const hpPortTagSet = hp.portTags
      ? new Set(hp.portTags.toLowerCase().split(/\s+/))
      : null;

    const shipCls = this.selectedShip()?.className?.toLowerCase() ?? '';
    const exclusive = this.shipExclusiveMap();
    const isVanguardNoseSlot = shipCls.includes('vanguard') &&
                               hp.id.toLowerCase().startsWith('hardpoint_weapon_gun_nose_fixed');
    const isWolfShip = shipCls.includes('wolf') || shipCls.includes('alphawolf') || shipCls.includes('alpha_wolf');

    // PDC hardpoints: show PDC weapons/turrets directly (flat, no nesting)
    if (hp.id.toLowerCase().includes('_pdc')) {
      const PDC_ITEMS = new Set([
        'behr_laserrepeater_pdc_s1',    // M2C "Swarm"
        'behr_ballisticgatling_pdc_s1',  // MRX "Torrent"
        'turret_pdc_behr_m',            // PPB-116 "Pepperbox" (missile PDC)
      ]);
      return this.items().filter(i => PDC_ITEMS.has(i.className.toLowerCase()));
    }

    // If the sub-slot is locked to a specific weapon, only return that item
    const weaponLockMatch = /weaponLock:(\S+)/.exec(hp.flags ?? '');
    if (weaponLockMatch) {
      const lockedCls = weaponLockMatch[1].toLowerCase();
      return this.items().filter(i => i.className.toLowerCase() === lockedCls);
    }

    const acceptsGun     = hp.type === 'WeaponGun' || allTypes.includes('WeaponGun');
    const acceptsTurret  = hp.type === 'Turret' || hp.type === 'TurretBase' ||
                           allTypes.includes('Turret') || allTypes.includes('TurretBase');
    const acceptsRack    = hp.type === 'MissileLauncher' || hp.type === 'BombLauncher';
    const acceptsMissile = hp.type === 'Missile';
    const acceptsMining  = hp.type === 'WeaponMining' || allTypes.includes('WeaponMining');
    const acceptsMiningMod = hp.type === 'MiningModifier' || allTypes.includes('MiningModifier');
    const acceptsSalvage = hp.type === 'SalvageHead' || allTypes.includes('SalvageHead');
    const acceptsSalvageMod = hp.type === 'SalvageModifier' || allTypes.includes('SalvageModifier');

    return this.items()
      .filter(i => {
        const sz = i.size ?? 0;
        if (sz < minSize || sz > maxSize) return false;

        const clsL = i.className.toLowerCase();
        if (this.PICKER_BLACKLIST.has(clsL)) return false;
        const nameL = (i.name ?? '').toLowerCase();
        if (nameL.includes('placeholder') || nameL.includes('template')) return false;
        const exclusiveShip = exclusive.get(clsL);

        // Vanguard nose-only weapons: only on that specific slot
        if (this.VANGUARD_NOSE_ONLY.has(clsL)) return isVanguardNoseSlot;
        if (isVanguardNoseSlot) return false;

        // Wolf hull weapons: only on Wolf ships, and Wolf weapon slots only show Wolf weapons
        if (this.WOLF_WEAPONS.has(clsL)) return isWolfShip;
        if (isWolfShip && (acceptsGun || acceptsTurret) && i.type !== 'WeaponMount' && !this.WOLF_WEAPONS.has(clsL)) return false;

        // Ship-exclusive items: only show when that ship is selected
        if (exclusiveShip && exclusiveShip !== shipCls) return false;

        // Port-tag filtering: if hardpoint has portTags and item has itemTags,
        // at least one itemTag must match a portTag
        if (hpPortTagSet && i.itemTags && i.itemTags.length > 0) {
          if (!i.itemTags.some(t => hpPortTagSet.has(t.toLowerCase()))) return false;
        }

        if (acceptsGun    && i.type === 'WeaponMount' && !hp.id.includes('.')) return true;
        if (acceptsGun    && (i.type === 'WeaponGun' || i.type === 'WeaponTachyon')) return true;
        if (acceptsTurret && (i.type === 'Turret' || i.type === 'TurretBase')) return true;
        if (acceptsRack   && i.type === 'MissileLauncher') return true;
        if (acceptsMissile && i.type === 'Missile') return true;
        if (acceptsMining  && i.type === 'WeaponMining') return true;
        if (acceptsMiningMod && i.type === 'MiningModifier') return true;
        if (acceptsSalvage && i.type === 'SalvageHead') return true;
        if (acceptsSalvageMod && i.type === 'SalvageModifier') return true;
        if (!acceptsGun && !acceptsTurret && !acceptsRack && !acceptsMissile && !acceptsMining && !acceptsMiningMod && !acceptsSalvage && !acceptsSalvageMod) {
          if (i.type === 'Module' && hp.type === 'Module') {
            // Only show modules belonging to this ship
            if (!clsL.includes(shipCls.replace(/_/g, '').toLowerCase().slice(0, 8)) &&
                !clsL.includes(shipCls.toLowerCase())) {
              // Try matching by ship name prefix (e.g., "retaliator", "aurora_mk2")
              const shipWords = shipCls.toLowerCase().split('_').filter(w => w.length > 3);
              if (!shipWords.some(w => clsL.includes(w))) return false;
            }
            // Filter front/rear modules to matching bays
            const hpPos = hp.id.toLowerCase().includes('front') ? 'front' : hp.id.toLowerCase().includes('rear') ? 'rear' : '';
            const itemPos = clsL.includes('front') ? 'front' : clsL.includes('rear') ? 'rear' : '';
            if (hpPos && itemPos && hpPos !== itemPos) return false;
          }
          return i.type === hp.type;
        }
        return false;
      })
      .sort((a, b) => {
        // Mounts first, then by primary stat descending
        if (a.type === 'WeaponMount' && b.type !== 'WeaponMount') return -1;
        if (b.type === 'WeaponMount' && a.type !== 'WeaponMount') return 1;
        if ((b.dps ?? 0) !== (a.dps ?? 0)) return (b.dps ?? 0) - (a.dps ?? 0);
        if ((b.hp ?? 0) !== (a.hp ?? 0)) return (b.hp ?? 0) - (a.hp ?? 0);
        if ((b.powerOutput ?? 0) !== (a.powerOutput ?? 0)) return (b.powerOutput ?? 0) - (a.powerOutput ?? 0);
        if ((b.coolingRate ?? 0) !== (a.coolingRate ?? 0)) return (b.coolingRate ?? 0) - (a.coolingRate ?? 0);
        if ((b.speed ?? 0) !== (a.speed ?? 0)) return (b.speed ?? 0) - (a.speed ?? 0);
        return (a.name ?? '').localeCompare(b.name ?? '');
      });
  }

  // ── Shopping Cart ──────────────────────────────────

  readonly cart = signal<Map<string, CartEntry>>(new Map());
  readonly cartCount = computed(() => {
    let total = 0;
    for (const entry of this.cart().values()) total += entry.quantity;
    return total;
  });

  private readonly PURCHASABLE_TYPES = new Set([
    'WeaponGun', 'WeaponTachyon', 'Shield', 'PowerPlant', 'Cooler',
    'QuantumDrive', 'Radar', 'Missile', 'WeaponMining', 'MiningModifier',
    'SalvageHead', 'SalvageModifier', 'LifeSupportGenerator',
  ]);

  addNonStockToCart(): void {
    const ship = this.selectedShip();
    if (!ship?.defaultLoadout) return;
    const loadout = this.loadout();
    const defaults = ship.defaultLoadout;
    const newCart = new Map(this.cart());

    for (const [slotId, item] of Object.entries(loadout)) {
      if (!this.PURCHASABLE_TYPES.has(item.type)) continue;
      const defaultCls = defaults[slotId.toLowerCase()];
      if (defaultCls && item.className.toLowerCase() === defaultCls.toLowerCase()) continue;
      // Non-stock item — add to cart
      const key = item.className;
      const existing = newCart.get(key);
      if (existing) {
        newCart.set(key, { ...existing, quantity: existing.quantity + 1 });
      } else {
        newCart.set(key, { item, quantity: 1 });
      }
    }
    this.cart.set(newCart);
  }

  removeFromCart(className: string): void {
    const newCart = new Map(this.cart());
    newCart.delete(className);
    this.cart.set(newCart);
  }

  clearCart(): void {
    this.cart.set(new Map());
  }
}
