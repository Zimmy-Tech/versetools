import { Injectable, signal, computed, effect } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { VerseDb, Ship, Item, CartEntry, calcMaxPips } from '../models/db.models';
import { applyDataOverrides } from './data-overrides';
import {
  CraftingRecipe,
  QualityEffect,
  BaseStats,
} from '../components/quality-simulator/quality-simulator';

export type DataMode = 'live' | 'ptu';

@Injectable({ providedIn: 'root' })
export class DataService {
  readonly dataMode = signal<DataMode>('live');
  readonly db = signal<VerseDb | null>(null);
  readonly selectedShip = signal<Ship | null>(null);
  readonly loadout = signal<Record<string, Item>>({});
  readonly focusedItem = signal<Item | null>(null);
  readonly activePickerHpId = signal<string | null>(null);
  readonly poweredOff = signal<Set<string>>(new Set());
  powerAlloc = signal<Record<string, number>>({});
  weaponsPower = signal<number>(0);
  thrusterPower = signal<number>(4);
  flightMode = signal<'scm' | 'nav'>('scm');

  // ─── Ship-component crafting state ──────────────────────────────────
  // `recipes` is loaded once per data-mode change. `craftEffects` stores
  // the live QualityEffect[] emitted by QualitySimulatorComponent for
  // each crafted slot, keyed by hardpoint id. `craftModalSlotId` drives
  // a single page-level modal in loadout-view (per-slot CRAFT buttons
  // toggle this signal — only one modal at a time).
  readonly recipes = signal<CraftingRecipe[]>([]);
  readonly craftEffects = signal<Record<string, QualityEffect[]>>({});
  readonly craftModalSlotId = signal<string | null>(null);

  // Ships hidden from picker (non-player ships only)
  private readonly hiddenShips = new Set([
    'xian_nox', 'xian_nox_kue',
    'orig_x1', 'orig_x1_force', 'orig_x1_velocity',
    'mrai_pulse', 'mrai_pulse_lx',
    'anvl_lightning_f8',  // F8A Lightning — not player-owned
    'anvl_carrack_expedition',  // just a paintjob of the Carrack
    'aegs_javelin',  // not player-usable, missing shield hardpoints
  ]);
  readonly ships = computed(() =>
    (this.db()?.ships ?? []).filter(s => !this.hiddenShips.has(s.className.toLowerCase()))
  );
  readonly items = computed(() => this.db()?.items ?? []);
  readonly itemMap = computed(() => {
    const map = new Map<string, Item>();
    for (const i of this.items()) map.set(i.className.toLowerCase(), i);
    return map;
  });
  readonly isLoaded = computed(() => this.db() !== null);

  /** All weapons (energy + ballistic) currently in the loadout, for ammo pool calculation.
   *  Excludes PDC (Point Defense Cannon) weapons — those are AI-controlled. */
  allLoadoutWeapons = computed(() =>
    Object.entries(this.loadout()).filter(
      ([key, i]) => i !== null && (i.type === 'WeaponGun' || i.type === 'WeaponTachyon') &&
        !key.toLowerCase().includes('_pdc')
    ).map(([, i]) => i as Item)
  );

  /** Whether the compact UI route is active (enables mobile header). */
  compactMode = signal(false);

  /** Trigger to open bulk equip modal from header bar. */
  bulkEquipRequested = signal(false);

  /** Trigger to apply Military A loadout from header bar. */
  milARequested = signal(false);
  stealthARequested = signal(false);

  /** Gimbal mode: 'lock' = full fire rate, 'gimbal' = 0.85× fire rate. */
  gimbalMode = signal<'lock' | 'gimbal'>('lock');

  /** DPS panel display mode: 'hud' = hero cards, 'flat' = inline rows. */
  dpsPanelMode = signal<'hud' | 'flat'>(
    (localStorage.getItem('dps-panel-mode') as 'hud' | 'flat') || 'hud'
  );
  toggleDpsPanelMode() {
    const next = this.dpsPanelMode() === 'hud' ? 'flat' : 'hud';
    this.dpsPanelMode.set(next);
    localStorage.setItem('dps-panel-mode', next);
  }
  readonly GIMBAL_FIRE_RATE_MULT = 0.85;

  /** All weapons including PDCs — for weapon power pool max pip calculation. */
  allWeaponsIncludingPdc = computed(() =>
    Object.values(this.loadout()).filter(
      i => i !== null && (i.type === 'WeaponGun' || i.type === 'WeaponTachyon')
    ) as Item[]
  );

  /**
   * Total available power pips from all equipped power plants.
   * Single PP: full powerOutput.
   * Multiple PPs: each contributes ceil(output/2) + size (pairing penalty).
   * Validated across S1/S2/S3 on Sabre, Redeemer, Valkyrie (6 configs, 0% error).
   */
  totalPowerOut = computed(() => {
    const loadout = this.loadout();
    const pps = Object.values(loadout)
      .filter((item): item is Item => item !== null && item.type === 'PowerPlant' && (item.powerOutput ?? 0) > 0);
    if (pps.length <= 1) {
      return pps.reduce((sum, pp) => sum + (pp.powerOutput ?? 0), 0);
    }
    return pps.reduce((sum, pp) => {
      const solo = pp.powerOutput ?? 0;
      const size = pp.size ?? 1;
      return sum + Math.ceil(solo / 2) + size;
    }, 0);
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
    Object.values(this.powerAlloc()).reduce((sum, n) => sum + n, 0) + this.weaponsPower() + this.thrusterPower() + this.toolPower() + this.tractorPower()
  );

  /** Base path prefix for the current data mode (e.g. 'live/' or 'ptu/'). */
  readonly dataPrefix = computed(() => `${this.dataMode()}/`);

  /** Fires whenever dataMode changes — notifies components that secondary data (missions, crafting, changelog) should reload. */
  readonly modeVersion = signal(0);

  /** PTU availability — loaded from config.json */
  readonly ptuEnabled = signal(false);
  readonly ptuLabel = signal('');

  /** Which source satisfied the last successful db load: 'db' = live API,
   *  'static' = bundled JSON fallback. Empty until the first load resolves. */
  readonly dataSource = signal<'' | 'db' | 'static'>('');

  constructor(private http: HttpClient) {
    // Load PTU config — prefer the API (admin-toggleable, lives in the DB)
    // and fall back to the static config.json for hosts without an API
    // (GitHub Pages mirror).
    const isStaticHost =
      typeof window !== 'undefined' &&
      /github\.io$/i.test(window.location.hostname);
    const applyCfg = (cfg: { ptuEnabled: boolean; ptuLabel?: string }) => {
      this.ptuEnabled.set(cfg.ptuEnabled);
      this.ptuLabel.set(cfg.ptuLabel ?? '');
      if (!cfg.ptuEnabled && this.dataMode() === 'ptu') {
        this.dataMode.set('live');
      }
    };
    const loadStatic = () =>
      this.http
        .get<{ ptuEnabled: boolean; ptuLabel?: string }>('config.json', {
          headers: { 'Cache-Control': 'no-cache' },
        })
        .subscribe({ next: applyCfg, error: () => {} });
    if (isStaticHost) {
      loadStatic();
    } else {
      this.http
        .get<{ ptuEnabled: boolean; ptuLabel?: string }>('/api/config', {
          headers: { 'Cache-Control': 'no-cache' },
        })
        .subscribe({ next: applyCfg, error: () => loadStatic() });
    }

    // React to dataMode changes: reload the main database.
    // Both LIVE and PTU now live in the same database — the API serves
    // them via /api/db?mode=live and /api/db?mode=ptu. GitHub Pages has
    // no API, so we skip the network round-trip entirely and read the
    // bundled JSON file directly (PTU support there is read-only). On
    // any other host, if the API call fails for any reason, we fall
    // back to the bundled JSON so the site never breaks.
    // (isStaticHost is already declared above for the config load.)
    effect(() => {
      const mode = this.dataMode();
      const prefix = this.dataPrefix();
      const fallbackUrl = `${prefix}versedb_data.json`;
      const primaryUrl = isStaticHost ? fallbackUrl : `/api/db?mode=${mode}`;

      const applyDb = (db: VerseDb) => {
        this.db.set(applyDataOverrides(db));
        this.selectedShip.set(null);
        this.loadout.set({});
        this.craftEffects.set({});
        this.craftModalSlotId.set(null);
        this.modeVersion.update(v => v + 1);
        const gladius = db.ships.find(s => s.className === 'aegs_gladius');
        if (gladius) this.selectShip(gladius);
      };

      // Load crafting recipes for the new mode. Static fallback only —
      // the recipe set is large but rarely changes between imports, so
      // it stays JSON-only for now.
      this.http.get<{ recipes: CraftingRecipe[] }>(`${prefix}versedb_crafting.json`,
        { headers: { 'Cache-Control': 'no-cache' } }).subscribe({
          next: (d) => this.recipes.set(d?.recipes ?? []),
          error: () => this.recipes.set([]),
        });

      // No-cache header forces the browser HTTP cache to revalidate. The
      // service worker's dataGroup for this URL uses `freshness` strategy
      // (network-first) so it won't serve a stale copy either — data
      // updates now propagate on the very next page load after deploy.
      const noCache = { headers: { 'Cache-Control': 'no-cache' } };
      const primaryIsStatic = primaryUrl === fallbackUrl;
      this.http.get<VerseDb>(primaryUrl, noCache).subscribe({
        next: (db) => { this.dataSource.set(primaryIsStatic ? 'static' : 'db'); applyDb(db); },
        error: (err) => {
          if (!primaryIsStatic) {
            console.warn(`API ${primaryUrl} failed, falling back to ${fallbackUrl}`, err);
            this.http.get<VerseDb>(fallbackUrl, noCache).subscribe({
              next: (db) => { this.dataSource.set('static'); applyDb(db); },
              error: () => console.warn(`Could not load ${fallbackUrl}`),
            });
          } else {
            console.warn(`Could not load ${fallbackUrl}`, err);
          }
        },
      });
    });
  }

  switchMode(mode: DataMode): void {
    if (mode !== this.dataMode()) {
      this.dataMode.set(mode);
    }
  }

  /** Re-fetches the database from the current source. Used by the
   *  admin panel after create/delete operations so the picker reflects
   *  the new state without a full page reload. Preserves the currently
   *  selected ship if it still exists.
   *
   *  Optional `mode` arg lets the admin panel pull a specific dataset
   *  (e.g. always 'live' for editor pickers regardless of which mode
   *  the public toggle is on). Defaults to the current dataMode signal. */
  async refreshDb(mode?: DataMode): Promise<void> {
    const isStaticHost =
      typeof window !== 'undefined' &&
      /github\.io$/i.test(window.location.hostname);
    const m = mode ?? this.dataMode();
    const prefix = this.dataPrefix();
    const fallbackUrl = `${prefix}versedb_data.json`;
    const primaryUrl = isStaticHost ? fallbackUrl : `/api/db?mode=${m}`;

    const previousClassName = this.selectedShip()?.className;
    const db = await this.http.get<VerseDb>(primaryUrl, {
      headers: { 'Cache-Control': 'no-cache' },
    }).toPromise();
    if (!db) return;
    this.dataSource.set(primaryUrl === fallbackUrl ? 'static' : 'db');
    this.db.set(applyDataOverrides(db));
    this.modeVersion.update((v) => v + 1);
    if (previousClassName) {
      const found = db.ships.find((s) => s.className === previousClassName);
      if (found) this.selectShip(found);
    }
  }

  loadFromFile(file: File): void {
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const db = JSON.parse(ev.target!.result as string) as VerseDb;
        this.db.set(applyDataOverrides(db));
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
      // Top-level defaults not in ship.hardpoints (e.g., LifeSupport on some ships)
      const hpIds = new Set(ship.hardpoints.map(hp => hp.id.toLowerCase()));
      for (const [key, cls] of Object.entries(ship.defaultLoadout)) {
        if (key.includes('.') || hpIds.has(key.toLowerCase())) continue;
        const item = this.items().find(i => i.className.toLowerCase() === cls.toLowerCase());
        if (item && !newLoadout[key]) newLoadout[key] = item;
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
        if (item && (item.type === 'WeaponGun' || item.type === 'Missile' || item.type === 'Bomb' || item.type === 'WeaponMining' || item.type === 'SalvageHead' || item.type === 'SalvageModifier' || item.type === 'TractorBeam' || item.type === 'JumpDrive')) newLoadout[dotKey] = item;
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

      // Bespoke weapon-locked turrets (Hornet F7C-M Mk2 ball turret, Perseus
      // S8 main gimbals, etc.): the DCB defaultLoadout includes the turret
      // entry but not its child weapon assignments because the game engine
      // auto-fills sub-ports from the turret's weaponLock at runtime. Mirror
      // that here so the loadout view shows the locked guns equipped on
      // first selection rather than empty slots.
      for (const [slotId, item] of Object.entries(newLoadout)) {
        if (!item.weaponLock || !item.subPorts?.length) continue;
        const lockedWeapon = this.items().find(
          i => i.className.toLowerCase() === item.weaponLock!.toLowerCase()
        );
        if (!lockedWeapon) continue;
        for (const sp of item.subPorts) {
          const isGunPort = sp.type === 'WeaponGun' ||
            sp.allTypes?.some((t: any) => t.type === 'WeaponGun');
          if (!isGunPort) continue;
          const childKey = `${slotId}.${sp.id}`;
          if (!newLoadout[childKey]) newLoadout[childKey] = lockedWeapon;
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

    // Identify which slots get power columns (matches power-bars column discovery)
    // Shields: first 2 only. Radar: first only. LS: first only.
    const primaryShieldIds = new Set<string>();
    let sc = 0;
    for (const hp of ship.hardpoints) {
      const si = newLoadout[hp.id];
      if (si?.type === 'Shield' && (si.powerMax ?? 0) > 0) {
        sc++;
        if (sc <= 2) primaryShieldIds.add(hp.id);
      }
    }
    for (const [key, si] of Object.entries(newLoadout)) {
      if (si?.type === 'Shield' && key.includes('.') && (si.powerMax ?? 0) > 0 && !primaryShieldIds.has(key)) {
        sc++;
        if (sc <= 2) primaryShieldIds.add(key);
      }
    }
    // First radar and first LS that appear in hardpoints (power-bars uses break after first)
    let primaryRadarId: string | null = null;
    let primaryLsId: string | null = null;
    for (const hp of ship.hardpoints) {
      const si = newLoadout[hp.id];
      if (!primaryRadarId && si?.type === 'Radar' && (si.powerDraw ?? 0) > 0) primaryRadarId = hp.id;
      if (!primaryLsId && si?.type === 'LifeSupportGenerator' && (si.powerMax ?? 0) > 0) primaryLsId = hp.id;
    }
    // LS fallback: scan loadout for LS not in hardpoints
    if (!primaryLsId) {
      for (const [key, si] of Object.entries(newLoadout)) {
        if (si?.type === 'LifeSupportGenerator' && (si.powerMax ?? 0) > 0) { primaryLsId = key; break; }
      }
    }

    const allocInit: Record<string, number> = {};
    for (const [hpId, item] of Object.entries(newLoadout)) {
      if (this.isFlightRestricted(item)) {
        allocInit[hpId] = 0;
        continue;
      }
      if (item.type === 'Shield') {
        if (primaryShieldIds.has(hpId)) {
          const maxPips = Math.max(1, (item.powerMax ?? 0) - 1);
          const b = item.powerBands ?? [];
          const minThreshold = b.length <= 1 ? 1 : Math.max(1, b[1].start - b[0].start);
          allocInit[hpId] = Math.max(minThreshold, Math.round(maxPips * 0.5));
        }
        // Excess shields: no entry in allocInit
      } else if (item.type === 'Cooler') {
        // Coolers: start at minimum band
        const b = item.powerBands ?? [];
        const cMin = b.length <= 1 ? 1 : Math.max(1, b[1].start - b[0].start);
        allocInit[hpId] = cMin;
      } else if (item.type === 'LifeSupportGenerator') {
        // Life support: first only (matches power-bars which breaks after first)
        if (hpId === primaryLsId) allocInit[hpId] = 1;
      } else if (item.type === 'Radar') {
        // Radar: first only (matches power-bars which breaks after first)
        if (hpId === primaryRadarId) {
          const pd = item.powerDraw ?? 1;
          const mcf = item.minConsumptionFraction ?? 0.25;
          allocInit[hpId] = Math.max(1, Math.round(pd * mcf));
        }
      } else if (item.type === 'QuantumDrive') {
        // QD: OFF at spawn
        allocInit[hpId] = 0;
      } else if (item.type === 'EMP') {
        // EMP: OFF at spawn
        allocInit[hpId] = 0;
      } else if (item.type === 'QuantumInterdictionGenerator') {
        // QED: OFF at spawn
        allocInit[hpId] = 0;
      } else if (item.powerBands?.length) {
        allocInit[hpId] = item.powerMin ?? 1;
      }
    }
    this.powerAlloc.set(allocInit);

    // Weapons: default to 50% of poolSize, capped by actual weapon power draw
    const poolSize = ship.weaponPowerPoolSize ?? 0;
    const wpnWeapons = Object.values(newLoadout).filter(
      i => i !== null && (i.type === 'WeaponGun' || i.type === 'WeaponTachyon')
    ) as Item[];
    const wpnMax = poolSize > 0 ? calcMaxPips(poolSize, wpnWeapons) : 0;
    const wpnDefault = Math.max(0, Math.min(Math.round(poolSize * 0.5), wpnMax));
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

  /** Re-initialize all power allocations from the current loadout without changing the loadout. */
  reinitPower(): void {
    const ship = this.selectedShip();
    if (!ship) return;

    // Wipe all power state first to prevent any stale entries
    this.powerAlloc.set({});
    this.weaponsPower.set(0);
    this.thrusterPower.set(0);
    this.toolPower.set(0);
    this.tractorPower.set(0);

    const loadout = this.loadout();

    // Identify which slots get power columns (matches power-bars column discovery)
    const primaryShieldIds = new Set<string>();
    let sc = 0;
    for (const hp of ship.hardpoints) {
      const item = loadout[hp.id];
      if (item?.type === 'Shield' && (item.powerMax ?? 0) > 0) {
        sc++;
        if (sc <= 2) primaryShieldIds.add(hp.id);
      }
    }
    for (const [key, item] of Object.entries(loadout)) {
      if (item?.type === 'Shield' && key.includes('.') && (item.powerMax ?? 0) > 0 && !primaryShieldIds.has(key)) {
        sc++;
        if (sc <= 2) primaryShieldIds.add(key);
      }
    }
    let primaryRadarId: string | null = null;
    let primaryLsId: string | null = null;
    for (const hp of ship.hardpoints) {
      const si = loadout[hp.id];
      if (!primaryRadarId && si?.type === 'Radar' && (si.powerDraw ?? 0) > 0) primaryRadarId = hp.id;
      if (!primaryLsId && si?.type === 'LifeSupportGenerator' && (si.powerMax ?? 0) > 0) primaryLsId = hp.id;
    }
    if (!primaryLsId) {
      for (const [key, si] of Object.entries(loadout)) {
        if (si?.type === 'LifeSupportGenerator' && (si.powerMax ?? 0) > 0) { primaryLsId = key; break; }
      }
    }

    const allocInit: Record<string, number> = {};
    for (const [hpId, item] of Object.entries(loadout)) {
      if (this.isFlightRestricted(item)) {
        allocInit[hpId] = 0;
        continue;
      }
      if (item.type === 'Shield') {
        if (primaryShieldIds.has(hpId)) {
          const maxPips = Math.max(1, (item.powerMax ?? 0) - 1);
          const b = item.powerBands ?? [];
          const minThreshold = b.length <= 1 ? 1 : Math.max(1, b[1].start - b[0].start);
          allocInit[hpId] = Math.max(minThreshold, Math.round(maxPips * 0.5));
        }
      } else if (item.type === 'Cooler') {
        const b = item.powerBands ?? [];
        const cMin = b.length <= 1 ? 1 : Math.max(1, b[1].start - b[0].start);
        allocInit[hpId] = cMin;
      } else if (item.type === 'LifeSupportGenerator') {
        if (hpId === primaryLsId) allocInit[hpId] = 1;
      } else if (item.type === 'Radar') {
        if (hpId === primaryRadarId) {
          const pd = item.powerDraw ?? 1;
          const mcf = item.minConsumptionFraction ?? 0.25;
          allocInit[hpId] = Math.max(1, Math.round(pd * mcf));
        }
      } else if (item.type === 'QuantumDrive') {
        allocInit[hpId] = 0;
      } else if (item.type === 'EMP') {
        allocInit[hpId] = 0;
      } else if (item.type === 'QuantumInterdictionGenerator') {
        allocInit[hpId] = 0;
      } else if (item.powerBands?.length) {
        allocInit[hpId] = item.powerMin ?? 1;
      }
    }
    this.powerAlloc.set(allocInit);

    const poolSize = ship.weaponPowerPoolSize ?? 0;
    const wpnWeapons = Object.values(loadout).filter(
      (i): i is Item => i !== null && (i.type === 'WeaponGun' || i.type === 'WeaponTachyon')
    );
    const wpnMax = poolSize > 0 ? calcMaxPips(poolSize, wpnWeapons) : 0;
    this.weaponsPower.set(Math.max(0, Math.min(Math.round(poolSize * 0.5), wpnMax)));

    const thrustMax = ship.thrusterPowerBars ?? 4;
    this.thrusterPower.set(Math.max(1, Math.round(thrustMax * 0.5)));

    const toolCount = Object.values(loadout).filter(
      i => i?.type === 'WeaponMining' || i?.type === 'SalvageHead'
    ).length;
    const pipsPerTool = ship.className.toLowerCase() === 'argo_mole' ? 2 : 1;
    this.toolPower.set(toolCount * pipsPerTool);

    this.tractorPower.set(0);
  }

  // ─── Crafting helpers ────────────────────────────────────────────────
  /** Crafting recipe matching the item's className, or null if none. */
  recipeForItem(item: Item | null | undefined): CraftingRecipe | null {
    if (!item) return null;
    return this.recipes().find(r => r.className === item.className) ?? null;
  }

  /** BaseStats lookup map for QualitySimulator's before→after preview.
   *  Loose aliases — keys are matched case-insensitively via includes(),
   *  so the same map covers every ship-component category. */
  baseStatsForItem(item: Item | null | undefined): BaseStats {
    if (!item) return {};
    return {
      // "Integrity" → componentHp on most components, hp on shields/QDs.
      'integrity':         item.componentHp ?? item.hp ?? null,
      'shield strength':   item.type === 'Shield' ? (item.hp ?? null) : null,
      'shield hp':         item.type === 'Shield' ? (item.hp ?? null) : null,
      'coolant rating':    item.coolingRate ?? null,
      'coolant':           item.coolingRate ?? null,
      'cooling':           item.coolingRate ?? null,
      'power pips':        item.powerOutput ?? null,
      'power output':      item.powerOutput ?? null,
      'aim min':           item.aimMin ?? null,
      'min assist':        item.aimMin ?? null,
      'aim max':           item.aimMax ?? null,
      'max assist':        item.aimMax ?? null,
      'quantum speed':     item.speed ?? null,
      'qd speed':          item.speed ?? null,
      'quantum fuel':      item.fuelRate ?? null,
      'fuel rate':         item.fuelRate ?? null,
      'fuel burn':         item.fuelRate ?? null,
    };
  }

  setCraftEffects(slotId: string, effects: QualityEffect[]): void {
    this.craftEffects.update(m => ({ ...m, [slotId]: effects }));
  }

  clearCraftEffects(slotId: string): void {
    this.craftEffects.update(m => {
      if (!(slotId in m)) return m;
      const next = { ...m };
      delete next[slotId];
      return next;
    });
  }

  /** Has the player rolled non-identity quality on this slot? */
  isCrafted(slotId: string | null | undefined): boolean {
    if (!slotId) return false;
    const effects = this.craftEffects()[slotId];
    if (!effects?.length) return false;
    return effects.some(e => Math.abs(e.combined - 1.0) > 1e-4);
  }

  /** Returns the equipped item with crafting modifiers layered onto its
   *  numeric stats. When nothing is crafted, returns the item by reference
   *  so existing identity comparisons stay cheap. The crafting layer is
   *  the OUTERMOST in any stat pipeline — apply this last on top of pip
   *  scaling, attachments, etc. */
  effectiveItem(slotId: string | null | undefined): Item | null {
    if (!slotId) return null;
    const base = this.loadout()[slotId];
    if (!base) return null;
    const effects = this.craftEffects()[slotId];
    if (!effects?.length) return base;
    let dirty = false;
    const eff: any = { ...base };
    for (const e of effects) {
      const m = e.combined;
      if (Math.abs(m - 1) < 1e-4) continue;
      const p = e.property.toLowerCase();
      if (p.includes('integrity')) {
        if (eff.componentHp != null) { eff.componentHp = eff.componentHp * m; dirty = true; }
        else if (eff.hp != null)     { eff.hp = eff.hp * m;                   dirty = true; }
      } else if (p.includes('coolant')) {
        if (eff.coolingRate != null) { eff.coolingRate = eff.coolingRate * m; dirty = true; }
      } else if (p.includes('shield strength') || p.includes('shield hp')) {
        if (eff.type === 'Shield' && eff.hp != null) { eff.hp = eff.hp * m; dirty = true; }
      } else if (p.includes('power pips') || p.includes('power output')) {
        // Today the PTU recipe values are 1.0×1.0 stubs — this branch is
        // a no-op until CIG fills them in. Wired now so the day they ship
        // real numbers, the powerOutput rolls through with no further
        // changes here or in the simulator.
        if (eff.powerOutput != null) { eff.powerOutput = eff.powerOutput * m; dirty = true; }
      } else if (p.includes('min') && p.includes('assist')) {
        if (eff.aimMin != null) { eff.aimMin = eff.aimMin * m; dirty = true; }
      } else if (p.includes('max') && p.includes('assist')) {
        if (eff.aimMax != null) { eff.aimMax = eff.aimMax * m; dirty = true; }
      } else if (p.includes('quantum speed')) {
        if (eff.speed != null) { eff.speed = eff.speed * m; dirty = true; }
      } else if (p.includes('quantum') && p.includes('fuel')) {
        if (eff.fuelRate != null) { eff.fuelRate = eff.fuelRate * m; dirty = true; }
      }
    }
    return dirty ? (eff as Item) : base;
  }

  setLoadoutItem(slotId: string, item: Item | null): void {
    const current = { ...this.loadout() };
    const prefix = slotId.toLowerCase() + '.';

    // Clear child sub-slot entries when changing a parent slot,
    // but preserve jump drive entries (they persist independently)
    for (const key of Object.keys(current)) {
      if (key.toLowerCase().startsWith(prefix) && !key.toLowerCase().includes('jump_drive')) {
        delete current[key];
      }
    }

    // Drop any crafting state for the slot (and its children) — the
    // modifier set is item-specific and doesn't carry across swaps.
    this.craftEffects.update(m => {
      let touched = false;
      const next = { ...m };
      for (const key of Object.keys(next)) {
        const lk = key.toLowerCase();
        if (lk === slotId.toLowerCase() || lk.startsWith(prefix)) {
          delete next[key];
          touched = true;
        }
      }
      return touched ? next : m;
    });

    if (item) {
      current[slotId] = item;
      const defaultLoadout = this.selectedShip()?.defaultLoadout ?? {};

      if (item.weaponLock && item.subPorts?.length) {
        // Turret with weapon lock + subPorts: fill each gun sub-port with locked weapon
        const lockedWeapon = this.items().find(i => i.className.toLowerCase() === item.weaponLock!.toLowerCase());
        if (lockedWeapon) {
          for (const sp of item.subPorts) {
            if (sp.type === 'WeaponGun' || sp.allTypes?.some((t: any) => t.type === 'WeaponGun')) {
              current[`${slotId}.${sp.id}`] = lockedWeapon;
            }
          }
        }
      } else if (item.weaponLock) {
        // Turret with weapon lock (no subPorts): fallback to default loadout scan
        const lockedWeapon = this.items().find(i => i.className.toLowerCase() === item.weaponLock!.toLowerCase());
        if (lockedWeapon) {
          for (const [dotKey, cls] of Object.entries(defaultLoadout)) {
            if (!dotKey.startsWith(prefix)) continue;
            const defaultItem = this.items().find(i => i.className.toLowerCase() === cls.toLowerCase());
            if (defaultItem?.type === 'WeaponGun') current[dotKey] = lockedWeapon;
          }
        }
      } else if ((item.type === 'Turret' || item.type === 'TurretBase' || item.type === 'WeaponMount') && item.subPorts?.length) {
        // Turret/mount with subPorts: populate children from default loadout matching sub-port ids
        for (const sp of item.subPorts) {
          const childKey = `${slotId}.${sp.id}`;
          const childPrefix = childKey.toLowerCase() + '.';
          // If sub-port has a locked item, auto-equip it
          const lockedCls = (sp as any).locked as string | undefined;
          if (lockedCls) {
            const lockedItem = this.items().find(i => i.className.toLowerCase() === lockedCls.toLowerCase());
            if (lockedItem) current[childKey] = lockedItem;
          }
          // Populate the direct child from default loadout (if not already set by locked)
          if (!current[childKey]) {
            const childCls = defaultLoadout[childKey.toLowerCase()];
            if (childCls) {
              const childItem = this.items().find(i => i.className.toLowerCase() === childCls.toLowerCase());
              if (childItem) current[childKey] = childItem;
            }
          }
          // Populate grandchildren (e.g. gimbal→gun, missile_rack→missiles)
          for (const [dotKey, cls] of Object.entries(defaultLoadout)) {
            if (!dotKey.toLowerCase().startsWith(childPrefix)) continue;
            const subItem = this.items().find(i => i.className.toLowerCase() === cls.toLowerCase());
            if (subItem) current[dotKey] = subItem;
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
          if (!subItem) continue;
          // Rack-type swap: don't re-populate leaves with incompatible ordnance
          // (missile rack → bomb rack must not keep the ship's default missile, and vice versa)
          if (item.type === 'BombLauncher'    && subItem.type === 'Missile') continue;
          if (item.type === 'MissileLauncher' && subItem.type === 'Bomb')    continue;
          if (subItem.type === 'WeaponGun' || subItem.type === 'Missile' || subItem.type === 'MissileLauncher' || subItem.type === 'Shield' || subItem.type === 'WeaponMining' || subItem.type === 'SalvageHead' || subItem.type === 'TractorBeam') {
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
    // Clamp weapon pips to maxPips (includes PDC power draw)
    if (poolSize > 0) {
      const maxPips = calcMaxPips(poolSize, this.allWeaponsIncludingPdc());
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
    // Radar/QD: actual max = powerDraw (SRU), not powerMax (from bands)
    // Others: max = powerMax - 1 (base segment offset)
    const max = (item?.type === 'Radar' || item?.type === 'QuantumDrive')
      ? (item?.powerDraw ?? item?.powerMax ?? 0)
      : Math.max(1, (item?.powerMax ?? 0) - 1);
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
    // Phase 2: distribute remaining as extras up to each shield's max (powerMax - 1)
    for (const { hpId, item } of slots) {
      if (newAlloc[hpId] === 0 || remaining <= 0) continue;
      const pMax = Math.max(1, (item.powerMax ?? 0) - 1);
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
    const totalOut = this.totalPowerOut();
    const headroom = totalOut - (this.totalPowerUsed() - this.thrusterPower());
    this.thrusterPower.set(Math.max(0, Math.min(n, maxBars, headroom)));
  }

  setWeaponsPower(n: number): void {
    if (this.flightMode() === 'nav') return;
    const poolSize = this.selectedShip()?.weaponPowerPoolSize ?? 0;
    const maxPips = calcMaxPips(poolSize, this.allWeaponsIncludingPdc());
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

    // Items that are cross-equippable across ship variants (not exclusive to one)
    const NEVER_EXCLUSIVE = new Set([
      'klwe_massdriver_s10',          // Destroyer Mass Driver (Idris M/P)
      'hrst_laserbeam_bespoke',       // Exodus-10 Laser Beam (Idris M/P)
      'mrck_s10_aegs_idris_nose_s12_torpedo', // Hammerfall Torpedo (Idris M/P)
    ]);

    const itemByCls = new Map(db.items.map(i => [i.className.toLowerCase(), i]));
    const exclusive = new Map<string, string>();
    for (const [cls, ships] of appearsIn) {
      if (ships.length !== 1) continue;
      if (NEVER_EXCLUSIVE.has(cls)) continue;
      // Items sold in shops are universal — don't mark them exclusive
      const item = itemByCls.get(cls);
      if (item?.shopPrices?.length) continue;
      exclusive.set(cls, ships[0]);
    }
    return exclusive;
  });

  // Vanguard nose slot: these exclusives only appear on that specific hardpoint
  private readonly VANGUARD_NOSE_ONLY = new Set([
    'behr_lasercannon_vng_s2',
    'behr_laserrepeater_vng_s2',
    'behr_ballisticcannon_vng_s2',
    'behr_ballisticrepeater_vng_s2',
    'behr_distortionrepeater_vng_s2',
    'behr_distortioncannon_vng_s2',
  ]);

  // Wolf hull weapons: only on L-21/L-22 Wolf ships, swappable between both
  private readonly WOLF_WEAPONS = new Set([
    'krig_ballisticgatling_bespoke_s4',  // Relentless L-21 Gatling
    'krig_laserrepeater_bespoke_s4',     // Axiom L-22 Repeater
  ]);

  // Items that should never appear in weapon pickers (locked to specific hardpoints only)
  isBlacklisted(cls: string): boolean { return this.PICKER_BLACKLIST.has(cls); }

  /** Should `item` be excluded from the bulk-equip picker on `shipCls`?
   *
   *  Mirrors the ship-specific filtering from getOptionsForSlot so bulk
   *  equip stays consistent with what the per-slot picker would accept.
   *
   *  Rules:
   *    - Globally blacklisted items: always excluded
   *    - VNG nose guns: only on Vanguard ships (other ships have no nose-only slots)
   *    - Wolf hull guns: only on Wolf ships
   *    - On a Wolf ship: ALL non-Wolf gun weapons excluded (Wolf weapon
   *      slots don't accept universal guns, so they'd never equip)
   *    - On a Vanguard: S2 gun weapons must be VNG nose-only (every Vanguard
   *      variant's only S2 gun slots are the 4 locked nose-fixed slots,
   *      which only accept VNG nose weapons)
   */
  isItemExcludedFromBulkEquip(cls: string, shipCls: string, item?: Item): boolean {
    if (this.PICKER_BLACKLIST.has(cls)) return true;
    const ship = shipCls.toLowerCase();
    const isWolf = ship.includes('wolf') || ship.includes('alphawolf') || ship.includes('alpha_wolf');
    const isVanguard = ship.includes('vanguard');

    if (this.VANGUARD_NOSE_ONLY.has(cls)) return !isVanguard;
    if (this.WOLF_WEAPONS.has(cls)) return !isWolf;

    // On a Wolf ship, every non-Wolf gun is excluded from bulk equip because
    // no Wolf hull slot would accept it (matches getOptionsForSlot:1121).
    if (isWolf && item && (item.type === 'WeaponGun' || item.type === 'WeaponTachyon')) {
      return true;
    }

    // On a Vanguard, S2 guns must be VNG nose-only — the only S2 slots on
    // every Vanguard variant are the 4 locked nose-fixed slots, restricted
    // to the 6 VNG nose weapons.
    if (isVanguard && item && item.size === 2 &&
        (item.type === 'WeaponGun' || item.type === 'WeaponTachyon')) {
      return true;
    }
    return false;
  }

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
    'vncl_neutroncannon_s5',    // WAR Cannon
    'misl_s10_ir_vncl_cleaver', // Vanduul Cleaver torpedo (ship-locked)
    // Internal / event / duplicate missile variants — no real localization,
    // never appear in player pickers
    'misl_s02_cs_fski_tempest_citcon',  // CitizenCon promotional Tempest variant
    'misl_s09_cs_taln_argos_2',         // Argos torpedo duplicate (_2 suffix)
    // Capital/ground vehicle weapons (not player-equippable on ships)
    'bengal_turret_ballisticcannon_s8', // Slayer Cannon (Bengal turret)
    'hrst_nova_ballisticcannon_s5',     // Slayer Cannon (Nova tank)
    'behr_nova_ballisticgatling_s5',    // NV57 Ballistic Gatling (Nova tank)
    // Hurston Storm (ship-locked)
    'hrst_storm_laserrepeater_s3', // Reign-3 Repeater
    // Liberator rocket pods (TODO: determine where these belong)
    'rpod_s1_thcn_4x_s2',         // Liberator
    'rpod_s2_thcn_8x_s2',         // Liberator Prime
    'rpod_s3_thcn_12x_s2',        // Liberator Ultra
    // AI/NPC weapon variants
    'amrs_aagun_cc_s3',                // PyroBurst AA variant (NPC only)
    // NOTE: ship-exclusive weapons (Wolf hull guns, Vanguard nose guns) used
    // to live here for "bulk equip cleanup" but caused a regression — the
    // picker's per-ship exception logic at VANGUARD_NOSE_ONLY / WOLF_WEAPONS
    // never fired because PICKER_BLACKLIST is checked first, so they were
    // hidden from pickers on the ships that should have them. They're now
    // filtered from bulk equip via isItemExcludedFromBulkEquip() instead.
    // Capital/security network weapons
    'behr_laserrepeater_s10',               // GVSR Repeater (S10)
    'behr_laserrepeater_s10_securitynetwork',      // GVSR Security Network
    'behr_laserrepeater_s10_securitynetwork_weak', // GVSR Security Network (weak)
    // Ship-exclusive weapons
    'toag_lasergatling_s2',             // Thlilye Laser Gatling (Mirai Pulse only)
    // Placeholder/broken items with wrong size data
    'vncl_gen2_plasmacannon_s4',        // Vanduul Gen2 placeholder (shows as S1)
    'vncl_gen2_plasmacannon_s2',        // Vanduul Gen2 placeholder (shows as S1)
    'apar_ballisticscattergun_s6',      // S6 scattergun placeholder (shows as S1)
    'brra_lasercannon_ap_automatedturret', // Automated turret placeholder
    // Ship-locked weapons
    'krig_ballisticgatling_s2',        // Tigerstrike T-19P (Merlin-only)
    'rpod_s1_fski_3x_s3',             // Yebira I (ship-locked rocket pod)
    'rpod_s2_fski_6x_s3',             // Yebira II (ship-locked rocket pod)
    'behr_ballisticgatling_hornet_bespoke', // TMSB-5 Gatling (Hornet ball turret only)
    // Internal shield variants
    'shld_godi_s01_allstop_scitem_resistgasclouds', // AllStop gas cloud variant (not in-game)
    // Internal QD variants
    'qdrv_acas_s01_foxfire',   // Foxfire (not in-game)
    'qdrv_acas_s01_lightfire', // Lightfire (not in-game)
    // Internal template/placeholder items (all sizes, all types)
    'qdrv_s01_template', 'qdrv_s02_template', 'qdrv_s03_template', 'qdrv_s04_template',
    'powr_s01_template', 'powr_s02_template', 'powr_s03_template', 'powr_s04_template',
    'shld_s01_template', 'shld_s02_template', 'shld_s03_template', 'shld_s04_template',
    'cool_s01_template', 'cool_s02_template', 'cool_s03_template', 'cool_s04_template', 'cool_template',
    'lfsp_s00_template', 'lfsp_s01_template', 'lfsp_s02_template', 'lfsp_s03_template', 'lfsp_s04_template',
    'radr_s01_template', 'radr_s02_template', 'radr_s03_template',
    'mining_laser_s0_template', 'mining_laser_s1_template',
    'wep_tractorbeam_s1_template', 'wep_tractorbeam_s2_template', 'wep_tractorbeam_s4_template',
    'turret_pdc_scitem_template', 'aegs_idris_turret_pdc_scitem_template',
    'default_fixed_mount_s3', 'default_fixed_mount_s4',
    'salvage_head_template', 'salvage_buff_modifier_template', 'salvage_modifier_template',
    'salvage_modifier_tractor_template', 'salvage_modifier_scraper_template',
    'qed_template',
    'jdrv_s01_template', 'jdrv_s02_template', 'jdrv_s03_template', 'jdrv_s04_template',
    'shld_banu_s01_placeholder_scitem', // Banu S1 shield placeholder (unused)
    // Internal weapon variants (non-zero DPS but not real items)
    'banu_energyrepeater_s2',      // CF-227 Badger clone (0 DPS)
    'klwe_laserrepeater_pdc_s2',   // CF-227 Badger PDC variant (0 DPS)
    // Cyclone vehicle-locked racks
    'mrck_s03_tmbl_dual_s02_cyclone_mt_left',  // Cyclone MT left rack
    'mrck_s03_tmbl_dual_s02_cyclone_mt_right', // Cyclone MT right rack
    'mrck_s02_behr_single_s02_cyclone_aa',     // Cyclone AA rack
    // Internal/turret variants (duplicates with reduced stats)
    'hrst_laserrepeater_s4_turret',    // Attrition-4 turret variant
    'klwe_laserrepeater_s5_turret',    // CF-557 turret variant
    'klwe_laserrepeater_s5_idris_m',   // CF-557 Idris variant
    'klwe_laserrepeater_s5_lowpoly',   // CF-557 low-poly variant
    'behr_lasercannon_s6_turret',      // M7A turret variant
    'behr_lasercannon_s7_turret',      // M9A turret variant
    'bengal_turret_ballisticcannon_s8', // Slayer Cannon (Bengal turret, wrong size)
    'behr_laserrepeater_s10',          // GVSR S10 (security network turret, not player-equippable)
    'espr_prowler_remote_turret_s5',   // Prowler bespoke turret (not cross-equippable)
    // Polaris-specific torpedo racks (bespoke, not cross-equippable)
    'mrck_s10_rsi_polaris_torpedo_rb',
    'mrck_s10_rsi_polaris_torpedo_rt',
    'mrck_s10_rsi_polaris_right',
    'mrck_s10_rsi_polaris_torpedo',
    'mrck_s10_rsi_polaris_torpedo_lb',
    'mrck_s10_rsi_polaris_left',
    'mrck_s10_rsi_polaris_torpedo_cylinder_right_inner',
    'mrck_s10_rsi_polaris_torpedo_lt',
    'mrck_s10_rsi_polaris_torpedo_left',
    // Unknown mount (TODO: research if this is a real in-game item)
    'behr_pc2_dual_s1',                // PC2 Dual S1 Mount — never seen in-game
    // Template/placeholder mounts (TODO: research if these are real items)
    'default_fixed_mount_s3',          // Size 3 Fixed Mount — unused by any ship
    'default_fixed_mount_s4',          // Size 4 Fixed Mount — unused by any ship
  ]);

  getOptionsForSlot(hp: { id: string; minSize: number; maxSize: number; type: string; flags?: string; portTags?: string; allTypes: { type: string }[] }): Item[] {
    const { minSize, maxSize } = hp;
    const allTypes = hp.allTypes?.map(t => t.type) ?? [];

    // Port-tag filtering: if the hardpoint has portTags, items with ship-specific
    // itemTags must share at least one tag with the port. Items without itemTags
    // (universal items) always pass.
    //
    // Tag normalization: CIG decorates some portTags with a leading `$` to
    // indicate a stricter lock (e.g. 4.8 PTU adds `$AEGS_Retaliator_Module_Rear`
    // to the Retaliator's module slots while the matching modules still
    // carry `AEGS_Retaliator_Module_Rear` — no $). Strip leading `$` from
    // both sides so the string comparison still matches.
    const normalizeTag = (t: string) => t.toLowerCase().replace(/^\$+/, '');
    const hpPortTagSet = hp.portTags
      ? new Set(hp.portTags.split(/\s+/).filter(Boolean).map(normalizeTag))
      : null;

    const shipCls = this.selectedShip()?.className?.toLowerCase() ?? '';
    const exclusive = this.shipExclusiveMap();
    const isVanguardNoseSlot = shipCls.includes('vanguard') &&
                               hp.id.toLowerCase().startsWith('hardpoint_weapon_gun_nose_fixed');
    const isWolfShip = shipCls.includes('wolf') || shipCls.includes('alphawolf') || shipCls.includes('alpha_wolf');

    // ── Hornet-only port-tag-driven picker (2026-04-28) ─────────────────
    // CIG's portTag/itemTag system is the authoritative compatibility map
    // for Mk II Hornet variants. Trust it instead of inferring exclusivity
    // from default-loadout patterns. Scope-limited to Hornets for now;
    // expand to other ship families after per-family validation.
    const isHornet = shipCls.startsWith('anvl_hornet');
    const defaultLoadout = this.selectedShip()?.defaultLoadout ?? {};
    const slotDefaultCls = (defaultLoadout[hp.id] ?? '').toLowerCase();
    // Effective tag set = slot's own portTags ∪ default item's itemTags.
    // CIG sometimes leaves portTags empty but the default item carries
    // the correct tag-set, which we read back as authoritative.
    let hornetEffectiveTags: Set<string> | null = null;
    if (isHornet) {
      const tags = new Set<string>(hpPortTagSet ?? []);
      if (slotDefaultCls) {
        const di = this.itemMap().get(slotDefaultCls);
        for (const t of di?.itemTags ?? []) tags.add(normalizeTag(t));
      }
      hornetEffectiveTags = tags.size > 0 ? tags : null;
    }

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
    const acceptsMissileRack = hp.type === 'MissileLauncher' || allTypes.includes('MissileLauncher');
    const acceptsBombRack    = hp.type === 'BombLauncher'    || allTypes.includes('BombLauncher');
    const acceptsRack        = acceptsMissileRack || acceptsBombRack;
    const acceptsMissile = hp.type === 'Missile';
    const acceptsMining  = hp.type === 'WeaponMining' || allTypes.includes('WeaponMining');
    const acceptsMiningMod = hp.type === 'MiningModifier' || allTypes.includes('MiningModifier');
    const acceptsSalvage = hp.type === 'SalvageHead' || allTypes.includes('SalvageHead');
    const acceptsSalvageMod = hp.type === 'SalvageModifier' || allTypes.includes('SalvageModifier');
    const acceptsModule = hp.type === 'Module' || allTypes.includes('Module');

    return this.items()
      .filter(i => {
        const sz = i.size ?? 0;
        if (sz < minSize || sz > maxSize) return false;

        const clsL = i.className.toLowerCase();
        if (this.PICKER_BLACKLIST.has(clsL)) return false;
        // Ground-vehicle missile variants (gmisl_*, "-G" name suffix) are
        // parallel duplicates of the ship missile lineup, restricted to
        // ground vehicle hardpoints. Never show them in ship pickers.
        if (i.type === 'Missile' && clsL.startsWith('gmisl_')) return false;
        // Filter out manned-turret structural items. These are extracted so
        // their subPort flags are visible to the loadout sub-slot synthesiser
        // (e.g. Polaris Maris cannon locks), but they aren't picker-equippable
        // — every TurretBase ship hardpoint is fixed-fitment.
        if (i.subType === 'MannedTurret') return false;
        // Filter out turret-internal weapon variants (lower stats, not player-equippable)
        if ((i.type === 'WeaponGun' || i.type === 'WeaponTachyon') && clsL.endsWith('_turret')) return false;
        // Filter out _lowpoly variants across the board. These are lower-poly
        // model duplicates used for distant-render conditions — they share
        // ammoparams with their full-detail counterpart (same damage, same
        // ammoRef), so they'd appear as identical-looking duplicate picker
        // entries next to the real weapon.
        if (clsL.endsWith('_lowpoly')) return false;
        // Filter out 0-DPS weapon variants (turret/lowpoly/dummy internals)
        if ((i.type === 'WeaponGun' || i.type === 'WeaponTachyon') && (i.dps ?? 0) <= 0) return false;
        const nameL = (i.name ?? '').toLowerCase();
        if (nameL.includes('placeholder') || nameL.includes('template')) return false;
        const exclusiveShip = exclusive.get(clsL);

        // Vanguard nose-only weapons: only on that specific slot
        if (this.VANGUARD_NOSE_ONLY.has(clsL)) return isVanguardNoseSlot;
        if (isVanguardNoseSlot) return false;

        // Wolf hull weapons: only on Wolf ships, and Wolf weapon slots only show Wolf weapons
        if (this.WOLF_WEAPONS.has(clsL)) return isWolfShip;
        if (isWolfShip && (acceptsGun || acceptsTurret) && i.type !== 'WeaponMount' && !this.WOLF_WEAPONS.has(clsL)) return false;

        // ── Hornet-only path: CIG tag system is authoritative ──────────
        // The slot's exact default always passes (safety net). Otherwise
        // require itemTags/portTags overlap (where portTags is inferred
        // from the default item if the slot left them blank). Universal
        // slots (no portTags, no default-item tags) only accept untagged
        // items. Skips the exclusive-ship heuristic entirely.
        if (isHornet) {
          if (clsL === slotDefaultCls) return true;
          const itemTagSet = (i.itemTags ?? []).map(normalizeTag);
          if (hornetEffectiveTags) {
            if (!itemTagSet.some(t => hornetEffectiveTags!.has(t))) return false;
          } else {
            if (itemTagSet.length > 0) return false;
          }
        } else {
          // Ship-exclusive items: only show when that ship is selected
          if (exclusiveShip && exclusiveShip !== shipCls) return false;

          // Port-tag filtering: if an item has itemTags, it is ship-specific and
          // requires a hardpoint with matching portTags. Untagged hardpoints never
          // show tagged items. With exclusive_tags flag, items WITHOUT tags are also
          // excluded. FlightController slots always require matching tags.
          if (hpPortTagSet) {
            const isExclusive = hp.flags?.includes('exclusive_tags');
            if (i.itemTags && i.itemTags.length > 0) {
              if (!i.itemTags.some(t => hpPortTagSet.has(normalizeTag(t)))) return false;
            } else if (isExclusive || i.type === 'FlightController') {
              return false;  // no matching tags → excluded
            }
          } else if (i.itemTags && i.itemTags.length > 0) {
            return false;  // item has tags but hardpoint has none — not compatible
          }
        }
        // Filter internal flight controller variants (_mm_ = master mode test)
        if (i.type === 'FlightController' && clsL.includes('_mm_')) {
          return false;
        }

        if (acceptsGun    && i.type === 'WeaponMount' && !hp.id.includes('.')) return true;
        if (acceptsGun    && (i.type === 'WeaponGun' || i.type === 'WeaponTachyon')) return true;
        if (acceptsTurret && (i.type === 'Turret' || i.type === 'TurretBase')) return true;
        if (acceptsMissileRack && i.type === 'MissileLauncher') return true;
        if (acceptsBombRack    && i.type === 'BombLauncher')    return true;
        if (acceptsMissile && i.type === 'Missile') return true;
        if (acceptsMining  && i.type === 'WeaponMining') return true;
        if (acceptsMiningMod && i.type === 'MiningModifier') return true;
        if (acceptsSalvage && i.type === 'SalvageHead') return true;
        if (acceptsSalvageMod && i.type === 'SalvageModifier') return true;
        if (acceptsModule && i.type === 'Module') return true;
        if (!acceptsGun && !acceptsTurret && !acceptsRack && !acceptsMissile && !acceptsMining && !acceptsMiningMod && !acceptsSalvage && !acceptsSalvageMod && !acceptsModule) {
          if (i.type === 'Module' && hp.type === 'Module') {
            // Only show modules belonging to this ship
            if (!clsL.includes(shipCls.replace(/_/g, '').toLowerCase().slice(0, 8)) &&
                !clsL.includes(shipCls.toLowerCase())) {
              // Try matching by ship name prefix (e.g., "retaliator", "aurora_mk2")
              const shipWords = shipCls.toLowerCase().split('_').filter(w => w.length > 3);
              if (!shipWords.some(w => clsL.includes(w))) return false;
            }
            // Filter front/rear and left/right modules to matching bays
            const hpId = hp.id.toLowerCase();
            const hpPos = hpId.includes('front') ? 'front' : hpId.includes('rear') ? 'rear' : '';
            const itemPos = clsL.includes('front') ? 'front' : clsL.includes('rear') ? 'rear' : '';
            if (hpPos && itemPos && hpPos !== itemPos) return false;
            const hpSide = hpId.includes('left') ? 'left' : hpId.includes('right') ? 'right' : '';
            const itemSide = clsL.includes('left') ? 'left' : clsL.includes('right') ? 'right' : '';
            if (hpSide && itemSide && hpSide !== itemSide) return false;
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

  /** Transient feedback after a cart action — picked up by the global
   *  toast in app.html and auto-cleared after a few seconds. */
  readonly cartFeedback = signal<{
    kind: 'info' | 'success' | 'warning';
    message: string;
    detailNames?: string[];
  } | null>(null);

  private cartFeedbackTimer: any = null;

  private setCartFeedback(feedback: { kind: 'info' | 'success' | 'warning'; message: string; detailNames?: string[] }): void {
    this.cartFeedback.set(feedback);
    clearTimeout(this.cartFeedbackTimer);
    this.cartFeedbackTimer = setTimeout(() => this.cartFeedback.set(null), 6000);
  }

  dismissCartFeedback(): void {
    clearTimeout(this.cartFeedbackTimer);
    this.cartFeedback.set(null);
  }

  private readonly PURCHASABLE_TYPES = new Set([
    'WeaponGun', 'WeaponTachyon', 'Shield', 'PowerPlant', 'Cooler',
    'QuantumDrive', 'Radar', 'Missile', 'WeaponMining', 'MiningModifier',
    'SalvageHead', 'SalvageModifier', 'LifeSupportGenerator',
  ]);

  addNonStockToCart(): void {
    const ship = this.selectedShip();
    if (!ship?.defaultLoadout) {
      this.setCartFeedback({ kind: 'info', message: 'No ship selected.' });
      return;
    }
    const loadout = this.loadout();
    const defaults = ship.defaultLoadout;
    const newCart = new Map(this.cart());

    let addedCount = 0;
    const skippedNames: string[] = [];
    const seenSkipped = new Set<string>();

    for (const [slotId, item] of Object.entries(loadout)) {
      if (!this.PURCHASABLE_TYPES.has(item.type)) continue;
      const defaultCls = defaults[slotId.toLowerCase()];
      if (defaultCls && item.className.toLowerCase() === defaultCls.toLowerCase()) continue;

      // Non-default, purchasable type — but does it actually have shop data?
      if (!item.shopPrices?.length) {
        if (!seenSkipped.has(item.className)) {
          seenSkipped.add(item.className);
          skippedNames.push(item.name);
        }
        continue;
      }

      // Non-stock and purchasable — add to cart
      const key = item.className;
      const existing = newCart.get(key);
      if (existing) {
        newCart.set(key, { ...existing, quantity: existing.quantity + 1 });
      } else {
        newCart.set(key, { item, quantity: 1 });
      }
      addedCount++;
    }
    this.cart.set(newCart);

    // Feedback message
    const skippedCount = skippedNames.length;
    if (addedCount > 0 && skippedCount === 0) {
      this.setCartFeedback({
        kind: 'success',
        message: `Added ${addedCount} item${addedCount === 1 ? '' : 's'} to cart.`,
      });
    } else if (addedCount > 0 && skippedCount > 0) {
      this.setCartFeedback({
        kind: 'warning',
        message: `Added ${addedCount} item${addedCount === 1 ? '' : 's'}. ${skippedCount} item${skippedCount === 1 ? '' : 's'} not for sale in-game ${skippedCount === 1 ? 'was' : 'were'} skipped.`,
        detailNames: skippedNames,
      });
    } else if (addedCount === 0 && skippedCount > 0) {
      this.setCartFeedback({
        kind: 'warning',
        message: `Some items in your loadout are not for sale in-game and were not added to the cart.`,
        detailNames: skippedNames,
      });
    } else {
      this.setCartFeedback({
        kind: 'info',
        message: 'No non-stock items to add — this loadout matches the default.',
      });
    }
  }

  removeFromCart(className: string): void {
    const newCart = new Map(this.cart());
    newCart.delete(className);
    this.cart.set(newCart);
  }

  clearCart(): void {
    this.cart.set(new Map());
  }

  /** Reverse lookup: which ships equip the given item as default gear, and
   *  in which slot(s). Walks every ship's defaultLoadout (both top-level
   *  hardpoint keys and dotted sub-slot keys). Used by the Ship Tools DB
   *  click-through to show "who ships this component as default". */
  getShipsWithDefaultItem(className: string): { ship: Ship; slotIds: string[] }[] {
    const target = className.toLowerCase();
    const results: { ship: Ship; slotIds: string[] }[] = [];
    for (const ship of this.ships()) {
      const loadout = ship.defaultLoadout;
      if (!loadout) continue;
      const slots: string[] = [];
      for (const [slotId, cls] of Object.entries(loadout)) {
        if (cls && cls.toLowerCase() === target) slots.push(slotId);
      }
      if (slots.length) results.push({ ship, slotIds: slots });
    }
    // Biggest/best-known ships first feels nicer than alphabetical —
    // sort by slot count desc then ship name asc.
    results.sort((a, b) =>
      b.slotIds.length - a.slotIds.length ||
      (a.ship.name ?? '').localeCompare(b.ship.name ?? '')
    );
    return results;
  }
}
