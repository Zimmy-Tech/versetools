import { Component, signal, computed, effect } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { DataService } from '../../services/data.service';
import {
  QualitySimulatorComponent,
  QualityEffect,
  QualityModifier,
  CraftingIngredient as BaseCraftingIngredient,
  CraftingRecipe as BaseCraftingRecipe,
} from '../quality-simulator/quality-simulator';

// Local extensions add the optional/research fields the standalone
// /crafting page surfaces. Core ingredient + modifier shape is shared
// with the simulator so the additive vs multiplicative kind flag and
// `additiveModifierAtStart/End` flow through automatically.
type CraftingIngredient = BaseCraftingIngredient;
interface CraftingRecipe extends BaseCraftingRecipe {
  optionalIngredients?: CraftingIngredient[];
  research?: { timeSeconds: number; ingredients: CraftingIngredient[] };
}

interface CraftingData {
  meta: { totalRecipes: number; categories: Record<string, number> };
  recipes: CraftingRecipe[];
}

interface ArmorPieceRef {
  className: string;
  tempMin: number | null;
  tempMax: number | null;
  damageReduction: number | null;
  weight: string;
  resistPhysical?: number;
  resistEnergy?: number;
  resistDistortion?: number;
  resistThermal?: number;
  resistBiochemical?: number;
  resistStun?: number;
}

interface FpsWeaponRef {
  className: string;
  fireRate: number;
  alphaDamage: number;
  dps: number;
  recoilPitch?: number;
  recoilYaw?: number;
  recoilSmooth?: number;
}

@Component({
  selector: 'app-crafting-view',
  standalone: true,
  imports: [QualitySimulatorComponent],
  templateUrl: './crafting-view.html',
  styleUrl: './crafting-view.scss',
})
export class CraftingViewComponent {
  allRecipes = signal<CraftingRecipe[]>([]);
  loaded = signal(false);
  armorLookup = signal<Record<string, ArmorPieceRef>>({});
  weaponLookup = signal<Record<string, FpsWeaponRef>>({});

  searchQuery = signal('');
  resourceFilter = signal('');
  /** Hierarchical filter, encoded as `top` or `top.sub`. Driven by the
   *  top-tab strip + the contextual sub-category dropdown in the
   *  sidebar. Encoded values:
   *    ''                              All Recipes
   *    'fpsWeapons'                    All FPS Weapons
   *    'fpsWeapons.<subtype>'          Pistol / Rifle / Sniper / etc.
   *    'fpsArmor'                      All FPS Armor
   *    'fpsArmor.<subtype>'            Core / Helmet / Arms / Legs / Undersuit
   *    'flightSuits'                   Flight suits (name predicate)
   *    'shipComponents'                All ship recipes
   *    'shipComponents.<category>'     ShipCooler / ShipPowerPlant / ...
   *  Split on '.' inside allFiltered() to apply category/subtype
   *  filtering. */
  groupFilter = signal('');
  sortBy = signal<'name' | 'time' | 'ingredients'>('name');
  page = signal(1);
  readonly pageSize = 100;

  /** Tabs surfaced as a horizontal strip at the top of the page. The
   *  empty slug = "All Recipes" — matches groupFilter '' so no filter
   *  is applied. The order here is the order they render. */
  readonly tabs: { slug: string; label: string }[] = [
    { slug: '',               label: 'All' },
    { slug: 'fpsWeapons',     label: 'FPS Weapons' },
    { slug: 'fpsArmor',       label: 'FPS Armor' },
    { slug: 'flightSuits',    label: 'Flight Suits' },
    { slug: 'shipComponents', label: 'Ship Components' },
  ];

  /** Top-level slug derived from groupFilter — used to highlight the
   *  active tab and to drive the contextual sub-dropdown. */
  activeTab = computed(() => this.groupFilter().split('.', 1)[0]);

  /** Sub-category portion of groupFilter (after the dot), or '' for
   *  "all within this tab". Drives the sidebar sub-dropdown value. */
  activeSub = computed(() => {
    const parts = this.groupFilter().split('.');
    return parts.length > 1 ? parts[1] : '';
  });

  /** Concrete subtype options surfaced under each group in the
   *  template. Auto-derived from the data so new recipes light up
   *  without code changes — see the @for over groupOptions in the
   *  template. */
  groupOptions = computed(() => {
    const recipes = this.allRecipes();
    const fpsWeaponSubs = new Set<string>();
    const fpsArmorSubs = new Set<string>();
    const shipCats = new Set<string>();
    for (const r of recipes) {
      if (r.category === 'FPSWeapons' && r.subtype) fpsWeaponSubs.add(r.subtype);
      else if (r.category === 'FPSArmours' && r.subtype) fpsArmorSubs.add(r.subtype);
      else if (r.category.startsWith('Ship')) shipCats.add(r.category);
    }
    const shipLabel = (cat: string) => cat.replace(/^Ship/, '').replace(/([A-Z])/g, ' $1').trim() || cat;
    return {
      fpsWeaponSubs: [...fpsWeaponSubs].sort(),
      fpsArmorSubs: [...fpsArmorSubs].sort(),
      shipCats: [...shipCats].sort().map(c => ({ value: c, label: shipLabel(c) })),
    };
  });

  // Predicate that classifies a recipe as a flight suit. Surfaces the
  // VGL/NVY/MRAI/Origin/BASL flightsuits as their own virtual group
  // since they're a meaningful gameplay subset (G-tolerance bonus)
  // distinct from generic FPS armor/undersuits.
  private isFlightSuit(r: CraftingRecipe): boolean {
    return /flight\s*suit/i.test(r.itemName);
  }

  /** Recipe count per top tab — drives the "(N)" suffix on each tab
   *  label. Computed from the same predicates allFiltered() uses so
   *  the numbers always match what the list will show. */
  tabCounts = computed(() => {
    const recipes = this.allRecipes();
    const counts: Record<string, number> = {
      '':               recipes.length,
      'fpsWeapons':     0,
      'fpsArmor':       0,
      'flightSuits':    0,
      'shipComponents': 0,
    };
    for (const r of recipes) {
      if (r.category === 'FPSWeapons')           counts['fpsWeapons']++;
      else if (r.category === 'FPSArmours')      counts['fpsArmor']++;
      if (this.isFlightSuit(r))                  counts['flightSuits']++;
      if (r.category.startsWith('Ship'))         counts['shipComponents']++;
    }
    return counts;
  });

  /** Click handler for the top tab strip — drops any sub-filter so a
   *  tab switch lands you on "all within this tab", not a stale sub
   *  selection from the previous tab. */
  setTab(slug: string): void {
    this.groupFilter.set(slug);
    this.page.set(1);
  }

  /** Change handler for the contextual sub-dropdown — appends the sub
   *  to the active tab's slug. Empty value = "all within this tab". */
  setSub(sub: string): void {
    const top = this.activeTab();
    this.groupFilter.set(sub ? `${top}.${sub}` : top);
    this.page.set(1);
  }

  /** Click handler on result tags / cards — drops a name into the
   *  search field instead of the old prefix-matched setFilter. */
  toggleSet(set: string): void {
    this.searchQuery.set(this.searchQuery() === set ? '' : set);
    this.page.set(1);
  }

  selectedRecipe = signal<CraftingRecipe | null>(null);
  addQty = signal(1);
  readonly Math = Math;

  // Popout tab: 'crafting' or 'missions'
  popoutTab = signal<'crafting' | 'missions' | 'mining'>('crafting');
  mineralLocations = signal<Record<string, { location: string; system: string; type: string; probability: number }[]>>({});

  // Mission data for blueprint source lookup
  private allMissions = signal<any[]>([]);
  expandedMission = signal<string | null>(null);

  /** Missions that reward the selected recipe's blueprint (exact match only). */
  rewardingMissions = computed(() => {
    const sr = this.selectedRecipe();
    if (!sr) return [];
    const name = sr.itemName;
    return this.allMissions().filter(m =>
      m.blueprintRewards?.some((bp: string) => bp === name)
    );
  });

  recipeMineralSources = computed(() => {
    const sr = this.selectedRecipe();
    if (!sr) return [];
    const lookup = this.mineralLocations();
    const sources: { resource: string; locations: { location: string; system: string; type: string; probability: number }[] }[] = [];
    for (const ing of sr.ingredients) {
      // Some minerals come through as type='item' (entity-based pickup,
      // e.g. harvestable_mineral_1h_glacosite) rather than type='resource'
      // (abstract ResourceType ref). The mining-locs lookup is keyed by
      // mineral display name regardless of how CIG models the cost, so we
      // include any ingredient whose name has location data.
      if (lookup[ing.resource]) {
        sources.push({ resource: ing.resource, locations: lookup[ing.resource] });
      }
    }
    return sources;
  });

  // Quality sliders: resource name → quality value (0–1000)
  // Live stream of the simulator's computed effects. Fed by the simulator's
  // (qualityEffectsChange) output so that armorResistances + any other
  // downstream consumer stays reactive. Same name as the old computed so
  // we don't have to rewire anything else.
  qualityEffects = signal<QualityEffect[]>([]);
  onQualityEffectsChange(e: QualityEffect[]): void { this.qualityEffects.set(e); }

  /** BaseStats map for the simulator preview column of the currently
   *  selected recipe — pulls from the armor + weapon lookups. */
  baseStatsForRecipe(r: CraftingRecipe): Record<string, number | null | undefined> {
    const armorLookup = this.armorLookup();
    let armorPiece: ArmorPieceRef | undefined = armorLookup[r.className];
    if (!armorPiece) {
      const basePrefix = r.className.replace(/_\d+$/, '');
      armorPiece = Object.values(armorLookup).find(p => p.className.startsWith(basePrefix));
    }
    const weaponLookup = this.weaponLookup();
    let weaponPiece: FpsWeaponRef | undefined = weaponLookup[r.className];
    if (!weaponPiece) {
      const basePrefix = r.className.replace(/_\d+$/, '');
      weaponPiece = Object.values(weaponLookup).find(w => w.className.startsWith(basePrefix));
    }
    return {
      'damage reduction': armorPiece?.damageReduction ?? null,
      'max temp':         armorPiece?.tempMax ?? null,
      'min temp':         armorPiece?.tempMin ?? null,
      'fire rate':        weaponPiece?.fireRate ?? null,
      'impact force':     weaponPiece?.alphaDamage ?? null,
      'alpha':            weaponPiece?.alphaDamage ?? null,
      'recoil kick':      weaponPiece?.recoilPitch ?? null,
      'recoilpitch':      weaponPiece?.recoilPitch ?? null,
      'recoil handling':  weaponPiece?.recoilYaw ?? null,
      'recoilyaw':        weaponPiece?.recoilYaw ?? null,
      'recoil smooth':    weaponPiece?.recoilSmooth ?? null,
      'recoilsmooth':     weaponPiece?.recoilSmooth ?? null,
    };
  }

  resources = computed(() => {
    const res = new Set<string>();
    for (const r of this.allRecipes()) {
      for (const i of r.ingredients) res.add(i.resource);
    }
    return ['', ...Array.from(res).sort()];
  });

  hasActiveFilter = computed(() =>
    this.searchQuery().length >= 2 || this.groupFilter() !== '' ||
    this.resourceFilter() !== ''
  );

  private allFiltered = computed(() => {
    const search = this.searchQuery().toLowerCase();
    const group = this.groupFilter();
    const res = this.resourceFilter();
    const sort = this.sortBy();

    let recipes = this.allRecipes();
    // Single hierarchical group filter — see groupFilter doc above.
    if (group) {
      const [top, sub] = group.split('.', 2);
      if (top === 'flightSuits') {
        recipes = recipes.filter(r => this.isFlightSuit(r));
      } else if (top === 'fpsWeapons') {
        recipes = recipes.filter(r => r.category === 'FPSWeapons' && (!sub || r.subtype === sub));
      } else if (top === 'fpsArmor') {
        recipes = recipes.filter(r => r.category === 'FPSArmours' && (!sub || r.subtype === sub));
      } else if (top === 'shipComponents') {
        recipes = recipes.filter(r => r.category.startsWith('Ship') && (!sub || r.category === sub));
      }
    }
    if (res) recipes = recipes.filter(r => r.ingredients.some(i => i.resource === res));
    if (search) {
      recipes = recipes.filter(r =>
        r.itemName.toLowerCase().includes(search) ||
        r.className.toLowerCase().includes(search) ||
        r.ingredients.some(i => i.resource.toLowerCase().includes(search))
      );
    }

    if (sort === 'name') recipes = [...recipes].sort((a, b) => a.itemName.localeCompare(b.itemName));
    else if (sort === 'time') recipes = [...recipes].sort((a, b) => b.craftTimeSeconds - a.craftTimeSeconds);
    else recipes = [...recipes].sort((a, b) => b.ingredients.length - a.ingredients.length);

    return recipes;
  });

  totalFiltered = computed(() => this.allFiltered().length);
  totalPages = computed(() => Math.ceil(this.totalFiltered() / this.pageSize) || 1);

  filteredRecipes = computed(() => {
    const start = (this.page() - 1) * this.pageSize;
    return this.allFiltered().slice(start, start + this.pageSize);
  });

  armorResistances = computed(() => {
    const sr = this.selectedRecipe();
    if (!sr || sr.category !== 'FPSArmours') return null;
    const armorLookup = this.armorLookup();
    let piece: ArmorPieceRef | undefined = armorLookup[sr.className];
    if (!piece) {
      const basePrefix = sr.className.replace(/_\d+$/, '');
      piece = Object.values(armorLookup).find(p => p.className.startsWith(basePrefix));
    }
    if (!piece || !piece.resistPhysical) return null;

    // Apply Damage Mitigation quality modifier to resistances
    const effects = this.qualityEffects();
    const mitEff = effects.find(e => e.property.toLowerCase().includes('mitigation') || e.property.toLowerCase().includes('damage'));
    const mitMod = mitEff ? mitEff.combined : 1;

    const types = [
      { type: 'Physical', base: piece.resistPhysical! },
      { type: 'Energy', base: piece.resistEnergy! },
      { type: 'Distortion', base: piece.resistDistortion! },
      { type: 'Thermal', base: piece.resistThermal! },
      { type: 'Biochemical', base: piece.resistBiochemical! },
      { type: 'Stun', base: piece.resistStun! },
    ];

    return types.map(t => {
      const baseDR = Math.round((1 - t.base) * 100);
      const modDR = Math.round((1 - t.base) * mitMod * 100 * 10) / 10;
      return { type: t.type, baseDR, modDR, changed: Math.abs(modDR - baseDR) > 0.05 };
    });
  });

  constructor(private http: HttpClient, private data: DataService) {
    // Load mining location data for mineral sources
    this.http.get<any>('live/versedb_mining_locs.json').subscribe(d => {
      const locs = d.locations ?? [];
      const lookup: Record<string, { location: string; system: string; type: string; probability: number }[]> = {};
      for (const loc of locs) {
        for (const cat of ['ship', 'roc', 'hand']) {
          for (const m of loc.mining?.[cat] ?? []) {
            if (!lookup[m.mineral]) lookup[m.mineral] = [];
            lookup[m.mineral].push({
              location: loc.location,
              system: loc.system,
              type: cat,
              probability: m.probability,
            });
          }
        }
      }
      // Sort each mineral's locations by probability descending, keep top 3
      for (const mineral of Object.keys(lookup)) {
        lookup[mineral] = lookup[mineral].sort((a, b) => b.probability - a.probability).slice(0, 3);
      }
      this.mineralLocations.set(lookup);
    });

    // Load armor and weapon data for base stat lookups
    this.http.get<{ armor: ArmorPieceRef[] }>('live/versedb_fps_armor.json').subscribe(d => {
      const resistByWeight: Record<string, { phys: number; enrg: number; dist: number; thrm: number; bio: number; stun: number }> = {
        light:  { phys: 0.80, enrg: 0.80, dist: 0.80, thrm: 0.80, bio: 0.80, stun: 0.70 },
        medium: { phys: 0.70, enrg: 0.70, dist: 0.70, thrm: 0.70, bio: 0.70, stun: 0.55 },
        heavy:  { phys: 0.60, enrg: 0.60, dist: 0.60, thrm: 0.60, bio: 0.60, stun: 0.40 },
      };
      const lookup: Record<string, ArmorPieceRef> = {};
      for (const p of d.armor) {
        const r = resistByWeight[p.weight];
        if (r) {
          p.resistPhysical = r.phys;
          p.resistEnergy = r.enrg;
          p.resistDistortion = r.dist;
          p.resistThermal = r.thrm;
          p.resistBiochemical = r.bio;
          p.resistStun = r.stun;
        }
        lookup[p.className] = p;
      }
      this.armorLookup.set(lookup);
    });
    this.http.get<{ weapons: FpsWeaponRef[] }>('live/versedb_fps.json').subscribe(d => {
      const lookup: Record<string, FpsWeaponRef> = {};
      for (const w of d.weapons) lookup[w.className] = w;
      this.weaponLookup.set(lookup);
    });

    effect(() => {
      const prefix = this.data.dataPrefix();
      this.data.modeVersion(); // track mode changes
      this.loaded.set(false);
      this.http.get<CraftingData>(`${prefix}versedb_crafting.json`).subscribe(data => {
        const recipes = data.recipes.map(r => {
          const name = r.itemName.toLowerCase();
          if (name.includes('magazine') || name.includes('battery')) {
            return { ...r, category: 'Ammunition' };
          }
          return r;
        });
        this.allRecipes.set(recipes);
        this.loaded.set(true);

        // Check if navigated from Blueprint Finder
        const craftSearch = localStorage.getItem('versetools_craft_search');
        if (craftSearch) {
          localStorage.removeItem('versetools_craft_search');
          this.searchQuery.set(craftSearch);
          const match = recipes.find(r => r.itemName === craftSearch);
          if (match) {
            this.selectedRecipe.set(match);
          }
        }
      });
      // Missions: prefer DB when available (fps/ships/missions all
      // promote through the same diff pipeline), fall back to the
      // static JSON on preview hosts where no API is reachable.
      const dbMissions = this.data.db()?.missions as any[] | undefined;
      if (dbMissions?.length) {
        this.allMissions.set(dbMissions);
      } else {
        this.http.get<any>(`${prefix}versedb_missions.json`).subscribe(data => {
          this.allMissions.set(data.contracts ?? data.missions ?? []);
        });
      }
    });
  }

  resetPage(): void { this.page.set(1); }
  prevPage(): void { if (this.page() > 1) this.page.update(p => p - 1); }
  nextPage(): void { if (this.page() < this.totalPages()) this.page.update(p => p + 1); }

  clearFilters(): void {
    this.searchQuery.set('');
    this.groupFilter.set('');
    this.resourceFilter.set('');
    this.page.set(1);
  }

  selectRecipe(r: CraftingRecipe, e: MouseEvent): void {
    e.stopPropagation();
    if (this.selectedRecipe()?.className === r.className) {
      this.selectedRecipe.set(null);
    } else {
      this.selectedRecipe.set(r);
      this.addQty.set(1);
      this.popoutTab.set('crafting');
      this.expandedMission.set(null);
      // QualitySimulatorComponent resets its own sliders on recipe change.
    }
  }

  closePopout(): void { this.selectedRecipe.set(null); }

  fmtTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }

  fmtQty(ing: CraftingIngredient): string {
    if (ing.quantity < 1) return `${ing.quantity} SCU`;
    return `×${ing.quantity}`;
  }

  fmtMod(val: number): string {
    const pct = (val - 1) * 100;
    return pct >= 0 ? `+${pct.toFixed(1)}%` : `${pct.toFixed(1)}%`;
  }

  cleanDesc(desc: string): string {
    return desc
      .replace(/<[^>]+>/g, '')
      .replace(/\\n/g, '\n')
      .replace(/~mission\([^)]+\)/g, '???')
      .trim();
  }

  isOre(ing: CraftingIngredient): boolean {
    return ing.type === 'resource' && ing.quantity < 1;
  }

  isGem(ing: CraftingIngredient): boolean {
    return ing.type === 'item' || (ing.type === 'resource' && ing.quantity >= 1);
  }

  dismantleReturns = computed(() => {
    const sr = this.selectedRecipe();
    if (!sr) return [];
    return sr.ingredients
      .map(ing => {
        const half = ing.quantity * 0.5;
        const returned = ing.quantity < 1 ? half : Math.floor(half);
        return { resource: ing.resource, quantity: returned, type: ing.type };
      })
      .filter(r => r.quantity >= 0.01);
  });

  fmtDismantleQty(d: { quantity: number; type: string }): string {
    if (d.type === 'item' || d.quantity >= 1) return `×${d.quantity}`;
    return `${d.quantity} SCU`;
  }

  // ── Materials List (tally) ──
  materialsList = signal<{ itemName: string; className: string }[]>([]);

  materialsTally = computed(() => {
    const list = this.materialsList();
    const recipes = this.allRecipes();
    const tally: Record<string, { quantity: number; type: string }> = {};

    for (const entry of list) {
      const recipe = recipes.find(r => r.className === entry.className);
      if (!recipe) continue;
      for (const ing of recipe.ingredients) {
        if (!tally[ing.resource]) {
          tally[ing.resource] = { quantity: 0, type: ing.type };
        }
        tally[ing.resource].quantity += ing.quantity;
      }
    }

    return Object.entries(tally)
      .map(([resource, data]) => ({
        resource,
        quantity: Math.round(data.quantity * 10000) / 10000,
        type: data.type,
      }))
      .sort((a, b) => a.resource.localeCompare(b.resource));
  });

  totalCraftTime = computed(() => {
    const list = this.materialsList();
    const recipes = this.allRecipes();
    let total = 0;
    for (const entry of list) {
      const recipe = recipes.find(r => r.className === entry.className);
      if (recipe) total += recipe.craftTimeSeconds;
    }
    return total;
  });

  addToMaterialsList(recipe: CraftingRecipe, qty = 1): void {
    const entries = Array.from({ length: qty }, () => ({ itemName: recipe.itemName, className: recipe.className }));
    this.materialsList.update(list => [...list, ...entries]);
  }

  removeFromMaterialsList(index: number): void {
    this.materialsList.update(list => list.filter((_, i) => i !== index));
  }

  clearMaterialsList(): void {
    this.materialsList.set([]);
  }

  fmtTallyQty(t: { quantity: number; type: string }): string {
    if (t.type === 'item' || t.quantity >= 1) return `×${t.quantity}`;
    return `${t.quantity} SCU`;
  }
}
