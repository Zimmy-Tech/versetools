import { Component, signal, computed, effect } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { DataService } from '../../services/data.service';

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

@Component({
  selector: 'app-crafting-view',
  standalone: true,
  templateUrl: './crafting-view.html',
  styleUrl: './crafting-view.scss',
})
export class CraftingViewComponent {
  allRecipes = signal<CraftingRecipe[]>([]);
  loaded = signal(false);

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
  popoutTab = signal<'crafting' | 'missions'>('crafting');

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

  // Quality sliders: resource name → quality value (0–1000)
  qualityValues = signal<Record<string, number>>({});

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

  // Computed: aggregate quality effects for the selected recipe
  qualityEffects = computed(() => {
    const sr = this.selectedRecipe();
    if (!sr) return [];
    const qv = this.qualityValues();

    // Aggregate all modifiers by property
    const propMap: Record<string, { combined: number; contributions: { resource: string; modifier: number }[] }> = {};

    for (const ing of sr.ingredients) {
      const mods = ing.qualityModifiers ?? [];
      const quality = qv[ing.resource] ?? 500; // default mid quality

      for (const m of mods) {
        const range = m.endQuality - m.startQuality;
        if (range <= 0) continue;
        // Clamp quality to the modifier's range
        const clampedQ = Math.max(m.startQuality, Math.min(m.endQuality, quality));
        const t = (clampedQ - m.startQuality) / range;
        const modifier = m.modifierAtStart + t * (m.modifierAtEnd - m.modifierAtStart);

        if (!propMap[m.property]) {
          propMap[m.property] = { combined: 1.0, contributions: [] };
        }
        propMap[m.property].combined *= modifier;
        propMap[m.property].contributions.push({ resource: ing.resource, modifier });
      }
    }

    return Object.entries(propMap).map(([prop, data]) => ({
      property: prop,
      combined: data.combined,
      contributions: data.contributions,
    })).sort((a, b) => a.property.localeCompare(b.property));
  });

  constructor(private http: HttpClient, private data: DataService) {
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
      // Initialize quality sliders at midpoint for all ingredients
      const qv: Record<string, number> = {};
      for (const ing of r.ingredients) {
        if (ing.qualityModifiers?.length) {
          qv[ing.resource] = 500;
        }
      }
      this.qualityValues.set(qv);
    }
  }

  closePopout(): void { this.selectedRecipe.set(null); }

  setQuality(resource: string, value: number): void {
    this.qualityValues.update(qv => ({ ...qv, [resource]: value }));
  }

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

  isOre(ing: CraftingIngredient): boolean {
    return ing.type === 'resource' && ing.quantity < 1;
  }

  isGem(ing: CraftingIngredient): boolean {
    return ing.type === 'item' || (ing.type === 'resource' && ing.quantity >= 1);
  }

  hasQualityMods(recipe: CraftingRecipe): boolean {
    return recipe.ingredients.some(i => i.qualityModifiers?.length);
  }

  ingredientsWithQuality(recipe: CraftingRecipe): CraftingIngredient[] {
    return recipe.ingredients.filter(i => i.qualityModifiers?.length);
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
