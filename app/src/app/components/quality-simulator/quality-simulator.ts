import { Component, computed, input, output, signal, effect } from '@angular/core';

export interface QualityModifier {
  property: string;
  unit: string;
  /** Two CIG variants ship in DCB:
   *   'multiplicative' — modifierAtStart/modifierAtEnd as floats,
   *      combined across ingredients via product. Default for omitted
   *      `kind` field (back-compat with older recipe JSONs).
   *   'additive' — additiveModifierAtStart/End as integers (e.g.
   *      Power Pips: -1/0/+1 per ingredient), combined via sum. */
  kind?: 'multiplicative' | 'additive';
  startQuality: number;
  endQuality: number;
  modifierAtStart?: number;
  modifierAtEnd?: number;
  additiveModifierAtStart?: number;
  additiveModifierAtEnd?: number;
}

export interface CraftingIngredient {
  type: string;
  resource: string;
  quantity: number;
  minQuality?: number;
  qualityModifiers?: QualityModifier[];
}

export interface CraftingRecipe {
  className: string;
  itemName: string;
  category: string;
  subtype: string;
  tier: number;
  craftTimeSeconds: number;
  ingredients: CraftingIngredient[];
}

/** A single live stat effect derived from the current quality-slider values. */
export interface QualityEffect {
  property: string;
  /** 'multiplicative' uses `combined` (product of ingredient mods, identity 1.0).
   *  'additive' uses `summed` (sum of ingredient mods, identity 0). */
  kind: 'multiplicative' | 'additive';
  combined: number;
  /** Sum of additive contributions; only meaningful when kind === 'additive'. */
  summed: number;
  /** Per-ingredient breakdown so the UI can show e.g.
   *  "Voltage Regulator: -1, Stator Cores: +1, total: 0" instead of just
   *  the combined number. `modifier` is multiplicative, `additive` is the
   *  per-ingredient delta. Caller can pick the field that matches `kind`. */
  contributions: { resource: string; modifier: number; additive: number }[];
  baseValue: number | null;
  modifiedValue: number | null;
  unit: string;
  invertComparison: boolean;
  colorClass: 'positive' | 'negative' | 'cold' | '';
  description: string;
}

/** A map of loose property-name fragments → base stat values, case-insensitive.
 *  The simulator uses `includes` matching to wire a recipe's modifier "property"
 *  string (e.g. "Damage Mitigation") to a numeric base. Callers pass whatever
 *  base stats they have for the item being crafted. */
export type BaseStats = Record<string, number | null | undefined>;

@Component({
  selector: 'app-quality-simulator',
  standalone: true,
  templateUrl: './quality-simulator.html',
  styleUrl: './quality-simulator.scss',
})
export class QualitySimulatorComponent {
  /** Recipe to simulate. Driven as a signal input. */
  recipe = input.required<CraftingRecipe>();
  /** Base stats lookup for the "before → after" preview column. */
  baseStats = input<BaseStats>({});

  /** Fired whenever the user moves a slider — parent components can react
   *  to the current quality roll + derived effects (e.g. feed into a DPS
   *  panel or save into loadout state). */
  qualityEffectsChange = output<QualityEffect[]>();

  qualityValues = signal<Record<string, number>>({});

  constructor() {
    // Reset sliders when the recipe changes — each recipe has its own set of
    // ingredient keys. Default every quality-bearing ingredient to 500 (base).
    effect(() => {
      const r = this.recipe();
      if (!r) { this.qualityValues.set({}); return; }
      const qv: Record<string, number> = {};
      r.ingredients.forEach((ing, i) => {
        if (ing.qualityModifiers?.length) qv[`${i}_${ing.resource}`] = 500;
      });
      this.qualityValues.set(qv);
    });

    // Re-emit whenever the effects change. Parents get a live stream.
    effect(() => {
      this.qualityEffectsChange.emit(this.qualityEffects());
    });
  }

  hasQualityMods(recipe: CraftingRecipe): boolean {
    return recipe.ingredients.some(i => i.qualityModifiers?.length);
  }

  ingredientsWithQuality(recipe: CraftingRecipe): { ing: CraftingIngredient; key: string }[] {
    return recipe.ingredients
      .map((ing, i) => ({ ing, key: `${i}_${ing.resource}` }))
      .filter(x => !!x.ing.qualityModifiers?.length);
  }

  setQuality(key: string, value: number): void {
    this.qualityValues.update(qv => ({ ...qv, [key]: value }));
  }

  setAllQuality(value: number): void {
    const r = this.recipe();
    const entries = this.ingredientsWithQuality(r);
    const updated: Record<string, number> = {};
    for (const e of entries) updated[e.key] = value;
    this.qualityValues.update(qv => ({ ...qv, ...updated }));
  }

  isOre(ing: CraftingIngredient): boolean {
    return ing.type === 'resource' && ing.quantity < 1;
  }
  isGem(ing: CraftingIngredient): boolean {
    return ing.type === 'item' || (ing.type === 'resource' && ing.quantity >= 1);
  }

  fmtMod(val: number): string {
    const pct = (val - 1) * 100;
    return pct >= 0 ? `+${pct.toFixed(1)}%` : `${pct.toFixed(1)}%`;
  }

  /** Top-line "% change" cell. Multiplicative renders as a signed
   *  percent off identity (1.0); additive renders as a signed integer
   *  with the unit (e.g. "+2 SEG"). */
  fmtChange(eff: QualityEffect): string {
    if (eff.kind === 'additive') {
      const sign = eff.summed > 0 ? '+' : '';
      return `${sign}${eff.summed}${eff.unit}`;
    }
    return this.fmtMod(eff.combined);
  }

  /** Per-ingredient row label. Renders multiplicative as a signed
   *  percent and additive as a signed integer. */
  fmtContribution(kind: 'multiplicative' | 'additive', c: { modifier: number; additive: number }): string {
    if (kind === 'additive') {
      const sign = c.additive > 0 ? '+' : '';
      return `${sign}${c.additive}`;
    }
    const pct = (c.modifier - 1) * 100;
    const sign = pct >= 0 ? '+' : '';
    return `${sign}${pct.toFixed(1)}%`;
  }

  /** Recipe data ships some opaque property names (CIG-internal terms);
   *  rewrite them to user-facing labels for the effects table. The raw
   *  string still flows through to the parent's stat-layering code,
   *  which matches on `.toLowerCase().includes(...)` — display rename
   *  has no functional effect. */
  private static readonly PROPERTY_DISPLAY_NAMES: Record<string, string> = {
    'integrity': 'Component HP',
    'max. shield strength': 'Max Shield HP',
    'coolant rating': 'Coolant Generation',
  };
  displayProperty(raw: string): string {
    return QualitySimulatorComponent.PROPERTY_DISPLAY_NAMES[raw.toLowerCase()] ?? raw;
  }

  /** Case-insensitive "any fragment matches" lookup against the caller's
   *  baseStats map. Lets callers provide aliases like "recoilPitch" OR "Recoil
   *  Kick" and the simulator finds the right field. */
  private lookupBase(propertyLower: string): number | null {
    const map = this.baseStats();
    for (const key of Object.keys(map)) {
      if (propertyLower.includes(key.toLowerCase())) {
        const v = map[key];
        if (v !== null && v !== undefined) return v;
      }
    }
    return null;
  }

  qualityEffects = computed<QualityEffect[]>(() => {
    const r = this.recipe();
    if (!r) return [];
    const qv = this.qualityValues();

    // Aggregate by property. The skip-out-of-range guard ensures only
    // the active band per (ingredient, property) contributes — recipes
    // ship non-overlapping bands (e.g. Power Pips at 0-399 / 400-899 /
    // 900-1000), so each ingredient lands exactly one contribution row.
    type Agg = {
      kind: 'multiplicative' | 'additive';
      combined: number;
      summed: number;
      contributions: { resource: string; modifier: number; additive: number }[];
    };
    const propMap: Record<string, Agg> = {};

    for (let idx = 0; idx < r.ingredients.length; idx++) {
      const ing = r.ingredients[idx];
      const mods = ing.qualityModifiers ?? [];
      const quality = qv[`${idx}_${ing.resource}`] ?? 500;

      for (const m of mods) {
        if (quality < m.startQuality || quality > m.endQuality) continue;
        const range = m.endQuality - m.startQuality;
        if (range <= 0) continue;
        const t = (quality - m.startQuality) / range;

        const isAdditive = m.kind === 'additive';
        const startVal = isAdditive ? (m.additiveModifierAtStart ?? 0) : (m.modifierAtStart ?? 1);
        const endVal   = isAdditive ? (m.additiveModifierAtEnd ?? 0)   : (m.modifierAtEnd ?? 1);
        const value = startVal + t * (endVal - startVal);

        if (!propMap[m.property]) {
          propMap[m.property] = {
            kind: isAdditive ? 'additive' : 'multiplicative',
            combined: 1.0,
            summed: 0,
            contributions: [],
          };
        }
        const agg = propMap[m.property];
        agg.contributions.push({
          resource: ing.resource,
          modifier: isAdditive ? 1 : value,
          additive: isAdditive ? value : 0,
        });
        if (isAdditive) agg.summed += value;
        else            agg.combined *= value;
      }
    }

    return Object.entries(propMap).map(([prop, data]) => {
      const pl = prop.toLowerCase();
      let baseValue: number | null = null;
      let modifiedValue: number | null = null;
      let unit = '';

      if (pl.includes('mitigation') || pl.includes('damage reduction')) {
        baseValue = this.lookupBase('damage reduction');
        if (baseValue != null) { modifiedValue = Math.round(baseValue * data.combined * 100) / 100; unit = '%'; }
      } else if (pl.includes('max temp')) {
        baseValue = this.lookupBase('max temp');
        if (baseValue != null) { modifiedValue = Math.round(baseValue * data.combined * 10) / 10; unit = '°C'; }
      } else if (pl.includes('min temp')) {
        baseValue = this.lookupBase('min temp');
        if (baseValue != null) { modifiedValue = Math.round(baseValue * data.combined * 10) / 10; unit = '°C'; }
      } else if (pl.includes('fire rate')) {
        baseValue = this.lookupBase('fire rate');
        if (baseValue != null) { modifiedValue = Math.round(baseValue * data.combined * 10) / 10; unit = ' RPM'; }
      } else if (pl.includes('impact force')) {
        baseValue = this.lookupBase('impact force') ?? this.lookupBase('alpha');
        if (baseValue != null) { modifiedValue = Math.round(baseValue * data.combined * 100) / 100; unit = ' dmg'; }
      } else if (pl.includes('recoil') && pl.includes('kick')) {
        baseValue = this.lookupBase('recoil kick') ?? this.lookupBase('recoilpitch');
        if (baseValue != null) { modifiedValue = Math.round(baseValue * data.combined * 1000) / 1000; unit = '°'; }
      } else if (pl.includes('recoil') && pl.includes('handling')) {
        baseValue = this.lookupBase('recoil handling') ?? this.lookupBase('recoilyaw');
        if (baseValue != null) { modifiedValue = Math.round(baseValue * data.combined * 1000) / 1000; unit = '°'; }
      } else if (pl.includes('recoil') && pl.includes('smooth')) {
        baseValue = this.lookupBase('recoil smooth') ?? this.lookupBase('recoilsmooth');
        if (baseValue != null) { modifiedValue = Math.round(baseValue * data.combined * 1000) / 1000; unit = 's'; }
      }
      // ── Ship-component branches ───────────────────────────────────────
      // Integrity is universal — ship recipes apply it to whatever the
      // component's "health" stat is (componentHp for most, hp for shields/QDs).
      // The baseStats lookup tries both aliases.
      else if (pl.includes('integrity')) {
        baseValue = this.lookupBase('integrity');
        if (baseValue != null) { modifiedValue = Math.round(baseValue * data.combined); unit = ' HP'; }
      }
      // Cooler: coolingRate.
      else if (pl.includes('coolant')) {
        baseValue = this.lookupBase('coolant') ?? this.lookupBase('cooling');
        if (baseValue != null) { modifiedValue = Math.round(baseValue * data.combined); unit = ''; }
      }
      // Shield HP (the user-facing pool, not componentHp).
      else if (pl.includes('shield strength') || pl.includes('shield hp')) {
        baseValue = this.lookupBase('shield strength') ?? this.lookupBase('shield hp') ?? this.lookupBase('hp');
        if (baseValue != null) { modifiedValue = Math.round(baseValue * data.combined); unit = ' HP'; }
      }
      // Power Pips — additive integer modifier (per-ingredient -1/0/+1
      // across stepped quality bands; with two ingredients combined,
      // the rolled-up range is -2..+2). Layered onto powerOutput as
      // base+sum, not base×product.
      else if (pl.includes('power pips') || pl.includes('power output')) {
        baseValue = this.lookupBase('power pips') ?? this.lookupBase('power output');
        if (baseValue != null) { modifiedValue = baseValue + data.summed; unit = ' SEG'; }
      }
      // Radar aim distances.
      else if (pl.includes('min') && pl.includes('assist')) {
        baseValue = this.lookupBase('aim min') ?? this.lookupBase('min assist');
        if (baseValue != null) { modifiedValue = Math.round(baseValue * data.combined); unit = ' m'; }
      }
      else if (pl.includes('max') && pl.includes('assist')) {
        baseValue = this.lookupBase('aim max') ?? this.lookupBase('max assist');
        if (baseValue != null) { modifiedValue = Math.round(baseValue * data.combined); unit = ' m'; }
      }
      // Quantum drive — speed + fuel-burn (lower is better).
      else if (pl.includes('quantum speed')) {
        baseValue = this.lookupBase('quantum speed') ?? this.lookupBase('qd speed');
        if (baseValue != null) { modifiedValue = Math.round(baseValue * data.combined); unit = ' m/s'; }
      }
      else if (pl.includes('quantum') && pl.includes('fuel')) {
        baseValue = this.lookupBase('quantum fuel') ?? this.lookupBase('fuel rate') ?? this.lookupBase('fuel burn');
        if (baseValue != null) { modifiedValue = Math.round(baseValue * data.combined * 10000) / 10000; unit = ' SCU/Mm'; }
      }

      // Lower-is-better metrics flag invertComparison so the colour /
      // CRAFTED indicator treat downward shifts as buffs.
      const invertComparison =
        pl.includes('min temp') ||
        pl.includes('recoil') ||
        (pl.includes('quantum') && pl.includes('fuel'));

      let description = '';
      if (pl.includes('recoil') && pl.includes('kick')) description = 'Vertical recoil (pitch)';
      else if (pl.includes('recoil') && pl.includes('handling')) description = 'Horizontal recoil (yaw)';
      else if (pl.includes('recoil') && pl.includes('smooth')) description = 'Convergence time';

      let colorClass: 'positive' | 'negative' | 'cold' | '' = '';
      if (pl.includes('min temp') && modifiedValue != null && baseValue != null) {
        if (modifiedValue < baseValue) colorClass = 'positive';
        else if (modifiedValue > baseValue) colorClass = 'negative';
      } else if (data.kind === 'additive') {
        // Additive — buff/nerf judged by sign of the summed delta.
        if (invertComparison) {
          if (data.summed < 0) colorClass = 'positive';
          else if (data.summed > 0) colorClass = 'negative';
        } else {
          if (data.summed > 0) colorClass = 'positive';
          else if (data.summed < 0) colorClass = 'negative';
        }
      } else if (invertComparison) {
        if (data.combined < 0.999) colorClass = 'positive';
        else if (data.combined > 1.001) colorClass = 'negative';
      } else {
        if (data.combined > 1.001) colorClass = 'positive';
        else if (data.combined < 0.999) colorClass = 'negative';
      }

      return {
        property: prop,
        kind: data.kind,
        combined: data.combined,
        summed: data.summed,
        contributions: data.contributions,
        baseValue,
        modifiedValue,
        unit,
        invertComparison,
        colorClass,
        description,
      };
    }).sort((a, b) => a.property.localeCompare(b.property));
  });
}
