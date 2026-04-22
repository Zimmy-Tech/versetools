# Quality Simulator — shared crafting-preview integration

This document describes how the FPS loadout's **CRAFT** button works,
and — more importantly — **how to wire the same pattern onto ship
components** when CIG's next patch ships the ship-side crafting
revamp. Everything about the quality-slider math, the recipe shape,
and the stat-override layering already exists; hooking it onto a new
item type is three calls and a matching modal.

**Audience:** anyone (Claude or human) adding a CRAFT affordance to
a new item category. Read the "Three-step integration" section and
copy the FPS implementation as a template.

---

## Table of contents

1. [Mental model](#mental-model)
2. [Component API](#component-api)
3. [Three-step integration](#three-step-integration)
4. [Data contracts](#data-contracts)
5. [How effectiveStats() layers the overrides](#how-effectivestats-layers-the-overrides)
6. [Key design decisions](#key-design-decisions)
7. [Extending to ship components](#extending-to-ship-components)
8. [File map](#file-map)

---

## Mental model

Crafting in SC lets players roll quality sliders on the ingredients
of a recipe. Every ingredient can declare a set of
`qualityModifiers` that scale the output item's stats (damage +10%,
fire rate +15%, recoil kick −20%, etc.) along a quality-value curve.
Different ore + gem combinations can improve the same stat
simultaneously, and the scaling multiplies.

`QualitySimulatorComponent` is a **standalone, headless simulator**
for that math. It takes:

- **A recipe** (the set of ingredients + their quality modifiers).
- **A BaseStats map** (the item's current stat values).

It renders:

- Quality sliders (one per quality-bearing ingredient).
- A live "before → after" preview column showing the new stat values
  at the current slider position.

It emits:

- A **`QualityEffect[]` stream** any time the user moves a slider.
  Each effect names a property and its combined multiplier across all
  contributing ingredients.

The parent component stores that emitted array in a signal and layers
it onto whatever stat pipeline the item uses for display (DPS panel,
shield bar, whatever). One component instance per open crafting
modal; the parent controls when to open / close / reset.

---

## Component API

**Selector:** `app-quality-simulator`
**Location:** `app/src/app/components/quality-simulator/quality-simulator.ts`

### Inputs

| Input       | Type                  | Required | Notes |
|-------------|-----------------------|----------|-------|
| `recipe`    | `CraftingRecipe`      | yes      | The recipe to simulate. Changing the input resets slider state to 500 (base quality). |
| `baseStats` | `BaseStats`           | no       | A `Record<string, number \| null \| undefined>` used for the before/after preview column. Keys are loose property-name fragments and matched case-insensitively via `includes`. You can pass multiple aliases for the same stat (`"fire rate"`, `"fireRate"`, `"rpm"`) — the simulator tries each until it finds a match. |

### Output

| Output                 | Type                 | Fires on |
|------------------------|----------------------|----------|
| `qualityEffectsChange` | `QualityEffect[]`    | Any slider move + every `recipe` or `baseStats` change |

### Types (all exported from `quality-simulator.ts`)

```ts
interface QualityModifier {
  property: string;          // "Fire Rate", "Recoil Kick", "Damage Mitigation", …
  unit: string;              // Display unit hint ("%", "°", "s", " RPM")
  startQuality: number;      // Quality value where modifierAtStart applies
  endQuality: number;        // Quality value where modifierAtEnd applies
  modifierAtStart: number;   // Multiplier at startQuality (e.g. 1.0)
  modifierAtEnd: number;     // Multiplier at endQuality (e.g. 1.15)
}

interface CraftingIngredient {
  type: string;              // 'resource' | 'item'
  resource: string;          // Display name — e.g. "Aphorite"
  quantity: number;
  minQuality?: number;
  qualityModifiers?: QualityModifier[];
}

interface CraftingRecipe {
  className: string;         // Recipe key ("behr_rifle_ballistic_01")
  itemName: string;          // Display name
  category: string;
  subtype: string;
  tier: number;
  craftTimeSeconds: number;
  ingredients: CraftingIngredient[];
}

interface QualityEffect {
  property: string;                                    // Property name (untouched from the recipe)
  combined: number;                                    // Final multiplier (product of all contributing modifiers)
  contributions: { resource: string; modifier: number }[];
  baseValue: number | null;                            // From baseStats lookup
  modifiedValue: number | null;                        // baseValue × combined (rounded per unit)
  unit: string;
  invertComparison: boolean;                           // true for lower-is-better stats (recoil, min temp)
  colorClass: 'positive' | 'negative' | 'cold' | '';
  description: string;                                 // Optional prose hint (e.g. "Vertical recoil (pitch)")
}

type BaseStats = Record<string, number | null | undefined>;
```

---

## Three-step integration

### 1. Load recipes into a signal on the parent component

Recipes live in `app/public/live/versedb_crafting.json` as
`{ recipes: CraftingRecipe[] }`. Parent components load them with the
HttpClient the same way any other data file is loaded.

```ts
recipes = signal<CraftingRecipe[]>([]);

constructor(private http: HttpClient) {
  this.http.get<{ recipes: CraftingRecipe[] }>('live/versedb_crafting.json')
    .subscribe(d => this.recipes.set(d.recipes));
}
```

Adding two helper methods for a given item type:

```ts
/** The recipe for this item, if it's craftable. */
recipeForItem(item: MyItem | null): CraftingRecipe | null {
  if (!item) return null;
  return this.recipes().find(r => r.className === item.className) ?? null;
}

/** BaseStats map the simulator reads for the before→after preview.
 *  Use loose aliases so the simulator's fragment-matching can find
 *  the right field regardless of how a recipe names it. */
baseStatsForItem(item: MyItem | null): BaseStats {
  if (!item) return {};
  return {
    'fire rate':       item.fireRate ?? null,
    'impact force':    item.alphaDamage ?? null,
    'alpha':           item.alphaDamage ?? null,
    // … one entry per stat the recipe might reference.
  };
}
```

### 2. Store the emitted effects keyed by slot

Multiple crafts can coexist (one per slot in the loadout), so the
parent stores effects in a `Record<slotKey, QualityEffect[]>` signal:

```ts
craftEffects = signal<Record<string, QualityEffect[]>>({});

onCraftEffectsChange(slotKey: string, effects: QualityEffect[]): void {
  this.craftEffects.update(m => ({ ...m, [slotKey]: effects }));
}

resetCraft(slotKey: string): void {
  this.craftEffects.update(m => {
    const next = { ...m };
    delete next[slotKey];
    return next;
  });
}

/** Has the player rolled any non-identity quality? */
isCrafted(slotKey: string | null | undefined): boolean {
  if (!slotKey) return false;
  const effects = this.craftEffects()[slotKey];
  if (!effects) return false;
  return effects.some(e => Math.abs(e.combined - 1.0) > 1e-4);
}
```

### 3. Render the modal with the simulator + apply effects in your stat pipeline

```html
<!-- In the stat panel for each slot -->
<button class="craft-btn"
        [class.crafted]="isCrafted(slotKey)"
        (click)="openCraft(slotKey)">
  {{ isCrafted(slotKey) ? 'CRAFTED' : 'CRAFT' }}
</button>

<!-- One modal at page level -->
@if (craftModalTarget(); as tgt) {
  <div class="picker-overlay" (click)="closeCraft()">
    <div class="craft-modal" (click)="$event.stopPropagation()">
      <div class="picker-header">
        <div class="picker-title">Craft → {{ tgt.item.name }}</div>
        <button class="picker-close" (click)="closeCraft()">×</button>
      </div>
      <div class="craft-body">
        @if (recipeForItem(tgt.item); as recipe) {
          <app-quality-simulator
            [recipe]="recipe"
            [baseStats]="baseStatsForItem(tgt.item)"
            (qualityEffectsChange)="onCraftEffectsChange(tgt.slotKey, $event)" />
          <div class="craft-actions">
            <button class="craft-reset" (click)="resetCraft(tgt.slotKey)">Reset to base</button>
            <button class="craft-done" (click)="closeCraft()">Done</button>
          </div>
        } @else {
          <div class="craft-empty">No crafting recipe for this item.</div>
        }
      </div>
    </div>
  </div>
}
```

Then in the parent's `effectiveStats()` (or whatever computes
display values), layer the craft effects **last** so they stack on
top of attachments / buffs / everything else:

```ts
effectiveStats(item: MyItem, slotKey: string | null): MyStats {
  // … base pipeline: extractor values → attachment mods → buffs …

  if (slotKey) {
    const effects = this.craftEffects()[slotKey];
    if (effects) {
      for (const eff of effects) {
        const p = eff.property.toLowerCase();
        const m = eff.combined;
        if (p.includes('fire rate'))                            fireRate     *= m;
        else if (p.includes('impact force'))                    alpha        *= m;
        else if (p.includes('recoil') && p.includes('kick'))    recoilPitch  *= m;
        // … one branch per property the recipe might touch.
      }
    }
  }

  return { ... };
}
```

That's it. The simulator handles the UI, math, reset-on-recipe-change,
and the live re-emit; the parent just consumes the emitted array.

---

## Data contracts

### BaseStats: loose alias keys are intentional

Recipes ship with display-oriented property names (`"Fire Rate"`,
`"Recoil Kick"`, `"Damage Mitigation"`). The simulator's internal
switch (see `qualityEffects()` computed) uses `pl.includes(...)`
against those names to decide which unit to render and which base
stat to look up.

Your BaseStats map should include **all the aliases a given stat
might be known by**. For example, the FPS loadout passes both:

```ts
'recoil kick':     w.recoilPitch ?? null,
'recoilpitch':     w.recoilPitch ?? null,
```

The simulator tries each key in the map via `.toLowerCase().includes`
and takes the first non-null hit. Redundancy is cheap and saves you
from debugging silent "base value missing" holes in the preview.

### Supported property name fragments (as of today)

The simulator's built-in switch handles:

- `damage reduction` / `mitigation` — unit `%`
- `max temp` / `min temp` — unit `°C` (min temp is lower-is-better)
- `fire rate` — unit ` RPM`
- `impact force` / `alpha` — unit ` dmg`
- `recoil kick` — unit `°` (lower-is-better)
- `recoil handling` — unit `°` (lower-is-better)
- `recoil smooth` — unit `s` (lower-is-better)

When CIG adds ship-side stats with new property names (shield HP,
regen rate, quantum-fuel-efficiency, etc.), add a new `else if`
branch to `qualityEffects()` in the simulator and pick the right
unit + rounding. Same pattern every time.

---

## How effectiveStats() layers the overrides

**Order matters.** The FPS loadout layers in this sequence:

1. **Base extractor values** — what the weapon's class shipped with.
2. **Attachment modifiers** — barrel/optics/underbarrel mod deltas
   applied multiplicatively.
3. **Crafting quality effects** — layered last, so a 1.10× fire-rate
   roll stacks on top of a Tweaker compensator's 1.125× fire rate
   (net 1.235× from base).

Keep this order when adapting to ship components. Crafting should
always be the outermost layer so the displayed "CRAFTED" number
reflects the full pipeline, not just the base.

Magazine size + magAlpha are also computed from the crafted fire
rate / alpha pair, not the base — look at
`fps-loadout.ts::effectiveStats()` for the exact wiring.

---

## Key design decisions

Recorded here so they don't have to be re-derived:

- **Slider default = 500.** SC's quality scale is 0..1000; 500 is the
  neutral midpoint where `modifierAtStart` to `modifierAtEnd`
  linear-interpolation lands on the base value for most recipes.
- **Effect reset on recipe change.** The simulator's constructor has
  an `effect()` that resets `qualityValues` whenever `recipe()`
  changes — so switching the equipped item starts the new modal with
  fresh sliders instead of carrying over the previous item's rolls.
- **`combined = 1.0` = identity.** The parent's `isCrafted()` check
  treats anything within `1e-4` of 1.0 as not-crafted, which is how
  the CRAFT button knows when to flip to the "CRAFTED" label.
- **Emit on every slider move.** The simulator re-emits the entire
  effect array on every drag — not just on mouse-up — because the
  DPS panel updates live. This is cheap because `qualityEffects()`
  is a Signal `computed`; only dirty ingredients recompute.
- **Property-name matching is case-insensitive + fragment-based.**
  Recipes ship with human names; the parent's stats use camelCase.
  `includes()` matching with both the recipe property and your
  BaseStats keys lowercased lets loose aliases work without a
  mapping table.

---

## Extending to ship components

The pattern is identical. When the ship-component crafting revamp
lands, the integration is:

1. **Confirm `versedb_crafting.json` contains ship-component recipes.**
   The extractor already produces this file — it may already include
   them, check the `category` field on existing entries.
2. **Identify the stat surface.** Ship components have richer stat
   sets than FPS weapons (shield HP + regen + resists, power plant
   draw + efficiency, quantum drive fuel rate, etc.). Decide which
   stats should participate in crafting display.
3. **Follow the three-step integration above** on the
   `HardpointSlotComponent` (or wherever the ship loadout renders
   per-hardpoint stats). Add:
   - `craftEffects = signal<Record<string, QualityEffect[]>>({})`
     keyed by hardpoint ID.
   - `onCraftEffectsChange(hpId, effects)` handler.
   - A CRAFT button on each component card that opens a modal
     containing `<app-quality-simulator>`.
4. **Extend the simulator's property-name switch** to cover any new
   stat fragments the ship recipes use that aren't in the FPS set
   (`shield hp`, `regen rate`, `fuel rate`, `quantum accel`, etc.).
   Each branch is ~3 lines — pick the baseStats alias and the
   display unit.
5. **Layer the effects onto ship stats in `effectiveStats()`** for
   the loadout, matching the FPS pattern but with ship-stat property
   names. Crafting is the **last** layer.

The simulator itself needs no new logic for the ship case — only
new property-name branches to cover new units/aliases.

### Open questions for the ship side (bridge when crossed)

- **Do ship components have multiple crafting tiers?** If so, the
  recipe shape is already tier-ready (`tier: number` field). No
  schema change needed.
- **Are crafted ship components curated?** Probably yes — the
  player's rolled component should survive re-extraction. The
  existing curation protection on the `items` table handles this
  automatically once a crafted component is persisted via the admin
  editor.
- **Persistence of craft rolls.** The FPS loadout holds craft state
  in component signal memory only — page reload loses it. Ship
  crafting may want to persist rolls to localStorage or the DB. Not
  required for the first cut; add later.

---

## File map

| File | Role |
|------|------|
| `app/src/app/components/quality-simulator/quality-simulator.ts` | The standalone component. ~225 lines total, the `qualityEffects()` computed is the math core. |
| `app/src/app/components/quality-simulator/quality-simulator.html` | Slider UI + before/after preview table. |
| `app/src/app/components/quality-simulator/quality-simulator.scss` | Slider styles + preview cell colors (`.positive` / `.negative` / `.cold`). |
| `app/src/app/components/fps-loadout/fps-loadout.ts` | Reference consumer. See `craftEffects`, `onCraftEffectsChange`, `recipeForWeapon`, `baseStatsForWeapon`, `isCrafted`, the crafting block in `effectiveStats()`. |
| `app/src/app/components/fps-loadout/fps-loadout.html` | Reference modal rendering (`<app-quality-simulator>` wired to the CRAFT modal). |
| `app/src/app/components/crafting-view/crafting-view.ts` | Original consumer (the standalone Crafting page). Pre-dates the simulator extraction; passes a curated recipe from a dropdown. Kept for discoverability — not needed for a new ship-side integration. |
| `app/public/live/versedb_crafting.json` | Recipe data. `{ recipes: CraftingRecipe[] }` shape. |

---

## The single most important thing

**Don't reinvent the simulator.** If a new item category needs
crafting UI, the answer is the three-step integration above, not a
parallel component. The simulator has real edge cases baked in
(slider reset on recipe change, case-insensitive base-stat lookup,
identity-detection for the CRAFTED flag) that would be painful to
re-derive.
