import { Component, signal, computed, effect } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { DataService } from '../../services/data.service';
import { QualitySimulatorComponent, QualityEffect } from '../quality-simulator/quality-simulator';

interface QualityModifier {
  property: string;
  unit: string;
  startQuality: number;
  endQuality: number;
  modifierAtStart: number;
  modifierAtEnd: number;
}

interface CraftingIngredient {
  type: string;
  resource: string;
  quantity: number;
  minQuality?: number;
  qualityModifiers?: QualityModifier[];
}

interface CraftingRecipe {
  className: string;
  itemName: string;
  category: string;
  subtype: string;
  tier: number;
  craftTimeSeconds: number;
  ingredients: CraftingIngredient[];
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
  categoryFilter = signal('');
  subtypeFilter = signal('');
  resourceFilter = signal('');
  setFilter = signal('');
  sortBy = signal<'name' | 'time' | 'ingredients'>('name');
  page = signal(1);
  readonly pageSize = 100;

  readonly armorSets = [
    'ADP', 'Antium', 'Argus', 'Arden-SL', 'Aril', 'Artimex', 'Aves',
    'Balor HCH', 'CBH-3', 'Calico', 'Citadel', 'Corbel', 'Defiance', 'DustUp',
    'G-2', 'Geist', 'Inquisitor', 'Lynx', 'Monde', 'Morozov-SH',
    'ORC-mkV', 'ORC-mkX', 'Overlord', 'PAB-1', 'Palatino', 'Strata',
    'Testudo', 'TrueDef-Pro', 'Venture',
  ];

  readonly weaponPistols = ['Arclight', 'Coda', 'LH86', 'Pulse', 'Tripledown', 'Yubarev'];
  readonly weaponRifles = ['Gallant', 'Karna', 'Killshot', 'P4-AR', 'S71'];
  readonly weaponSnipers = ['A03', 'Arrowhead', 'Atzkav', 'P6-LR', 'Scalpel', 'Zenith'];
  readonly weaponShotguns = ['BR-2', 'Deadrig', 'Devastator', 'Prism', 'R97', 'Ravager'];
  readonly weaponSMGs = ['C54', 'Custodian', 'Lumin', 'P8-SC', 'Quartz', 'S-38'];
  readonly weaponLMGs = ['Demeco', 'F55', 'FS-9', 'Fresnel', 'Pulverizer'];

  toggleSet(set: string): void {
    this.setFilter.set(this.setFilter() === set ? '' : set);
    this.searchQuery.set('');
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
      if (ing.type === 'resource' && lookup[ing.resource]) {
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

  categories = computed(() => {
    const cats = new Set(this.allRecipes().map(r => r.category));
    return ['', ...Array.from(cats).sort()];
  });

  subtypes = computed(() => {
    const cat = this.categoryFilter();
    if (!cat) return [] as string[];
    const subs = new Set(this.allRecipes().filter(r => r.category === cat).map(r => r.subtype).filter(Boolean));
    return ['', ...Array.from(subs).sort()];
  });

  resources = computed(() => {
    const res = new Set<string>();
    for (const r of this.allRecipes()) {
      for (const i of r.ingredients) res.add(i.resource);
    }
    return ['', ...Array.from(res).sort()];
  });

  hasActiveFilter = computed(() =>
    this.searchQuery().length >= 2 || this.categoryFilter() !== '' ||
    this.resourceFilter() !== '' || this.setFilter() !== ''
  );

  private allFiltered = computed(() => {
    const search = this.searchQuery().toLowerCase();
    const cat = this.categoryFilter();
    const sub = this.subtypeFilter();
    const res = this.resourceFilter();
    const setF = this.setFilter();
    const sort = this.sortBy();

    let recipes = this.allRecipes();
    if (cat) recipes = recipes.filter(r => r.category === cat);
    if (sub) recipes = recipes.filter(r => r.subtype === sub);
    if (res) recipes = recipes.filter(r => r.ingredients.some(i => i.resource === res));
    if (setF) recipes = recipes.filter(r => r.itemName.toLowerCase().startsWith(setF.toLowerCase()));
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
      this.http.get<any>(`${prefix}versedb_missions.json`).subscribe(data => {
        this.allMissions.set(data.contracts ?? data.missions ?? []);
      });
    });
  }

  resetPage(): void { this.page.set(1); }
  prevPage(): void { if (this.page() > 1) this.page.update(p => p - 1); }
  nextPage(): void { if (this.page() < this.totalPages()) this.page.update(p => p + 1); }

  clearFilters(): void {
    this.searchQuery.set('');
    this.categoryFilter.set('');
    this.subtypeFilter.set('');
    this.resourceFilter.set('');
    this.setFilter.set('');
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
