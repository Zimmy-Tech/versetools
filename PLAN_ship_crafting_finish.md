# Ship-Component Crafting — Finishing Instructions

**Audience:** the Claude Code instance that picks this up tomorrow (or
later) once CIG's PTU patch lands in LIVE. Read this end-to-end before
touching any code. Everything here was set up assuming **you start from
a fresh session with no conversation context.**

> **Status as of 2026-04-24 EOD:**
> - Today's PTU/tech-preview forge dump contains the new ship-component
>   crafting blueprints (377 of them across 9 categories).
> - We have an XML-walker (`PY SCRIPTS/extract_ship_crafting.py`) that
>   produces partial recipes from those blueprints today — just
>   className + display name + craft time + category. **Ingredients
>   and qualityModifiers are empty arrays.**
> - The `/crafting` page already shows ship-component dropdowns
>   (Cooler / Power Plant / Shield / Radar / Quantum Drive / Mining
>   Laser / Ship Weapon / Tractor Beam / Salvage). Each is auto-
>   populated from the recipes JSON.
> - **Not done:** ingredient + qualityModifier extraction (needs the
>   DCB binary parser, which fails against TP's DCB v8 schema), and
>   the loadout-side `CRAFT` / `NO RECIPE` button + modal + DPS-panel
>   routing.

---

## Phase 1 — Re-extract recipes from LIVE DCB

CIG is shipping ship-component crafting to LIVE in this patch (DCB v6,
which our existing binary parser handles). The XML-walker we used today
is a stop-gap — the binary parser produces FULL recipes (with
ingredients + qualityModifiers).

### 1.1 — Run the existing binary extractor

```bash
cd /home/bryan/projects/versedb
python3 "PY SCRIPTS/crafting_extract.py"
```

Output goes to `app/public/live/versedb_crafting.json` automatically.

**Expected:** the run completes without the `KeyError: 'CraftingBlueprint'`
that today's TP run produced. If it does fail with that error, the
patch hasn't fully shipped yet — check the build version stamp on
`SC FILES/sc_data_live/.build_version`.

### 1.2 — Verify what categories the binary extractor produces

The script's `_infer_subtype()` (around line 518 of `crafting_extract.py`)
currently only knows `FPSWeapons` and `FPSArmours`. The actual `category`
field on a recipe comes from the blueprint's category GUID, looked up
via the script's category resolver (the GUID maps to a display string in
DCB).

**You need to find out what category strings ship recipes are emitted
under.** Run:

```bash
python3 -c "
import json
c = json.load(open('app/public/live/versedb_crafting.json'))
from collections import Counter
print(Counter(r['category'] for r in c['recipes']))
"
```

If you see categories like `VehicleCooler`, `VehiclePowerPlant`, etc.,
**they need to be renamed to `ShipCooler`, `ShipPowerPlant`, etc.** to
match the names today's `/crafting` dropdowns expect (see
`crafting-view.ts:shipCoolers`, `shipPowerPlants`, etc.). Two options:

- **(a)** Modify `crafting_extract.py` to rename categories on emit
  (simplest — find the category-write site and add a mapping).
- **(b)** Modify `crafting-view.ts` `shipItemsForCategory()` calls to
  match the actual category strings (less code churn but ties the UI
  to CIG's naming).

**Recommendation: (a).** Keep the UI vocabulary stable.

### 1.3 — Sanity-check a sample recipe

Pick something you can verify by name (e.g. Glacier cooler):

```bash
python3 -c "
import json
c = json.load(open('app/public/live/versedb_crafting.json'))
g = next(r for r in c['recipes'] if 'glacier' in r['className'])
import json
print(json.dumps(g, indent=2))
"
```

You should see:
- `className`: `cool_aegs_s01_glacier_scitem` (lowercase, matches live items)
- `itemName`: `Glacier`
- `category`: `ShipCooler` (after rename)
- `craftTimeSeconds`: a non-zero number (~90 seconds based on TP data)
- `ingredients`: **NON-EMPTY ARRAY** with at least one resource entry
- `ingredients[].qualityModifiers`: at least one modifier object on
  some ingredients

If `ingredients` is still empty, something went wrong with the binary
extraction — investigate before proceeding.

### 1.4 — Retire the XML-walker fallback

Once the binary extractor produces complete data, today's
`PY SCRIPTS/extract_ship_crafting.py` is no longer needed. Either:

- Delete it.
- Or leave it as documentation — it's a useful XML-only fallback if a
  future schema break recurs.

If you keep it, add a note at the top: "XML-only fallback — the
DCB binary parser at `crafting_extract.py` is the production path."

---

## Phase 2 — Loadout-side CRAFT button + modal + DPS routing

This is the user-facing feature: every ship-component slot gets a
`CRAFT` button (or `NO RECIPE` if no recipe exists), opens the
`QualitySimulatorComponent` modal, and crafted stat upgrades flow
through to the DPS panel.

**Read first:** `CRAFTING_INTEGRATION_GUIDE.md` at the repo root. The
FPS Loadout already implements this exact pattern; the section
"Three-step integration" is the recipe.

### 2.1 — Confirm the integration target

The user said:

> "We add a 'dual state' button to the components part of the loadout.
> The button will either be clickable and say CRAFT or, unclickable and
> say NO RECIPE. This CRAFT button needs to be tied into the crafting
> UI just like the FPS Loadout was, where the craft button 'spawns' the
> modal 'in place' on the ship loadout screen."

The FPS Loadout's CRAFT button lives **inside the DPS panel card** for
each weapon. Look at:

- `app/src/app/components/fps-loadout/fps-loadout.html` — search for
  `dps-craft-btn` (around line 25). That's the placement template.
- `app/src/app/components/fps-loadout/fps-loadout.ts:925-995` —
  `openCraft`, `closeCraft`, `recipeForWeapon`, `baseStatsForWeapon`,
  `isCrafted`, `craftEffects`, `craftModalTarget`.

For ships, the equivalent surface is the DPS panel cards in the ship
loadout. The key file is `app/src/app/components/loadout-view/` — look
for the component that renders the per-slot stat cards (probably the
DPS panel sub-component or a stats-strip component).

### 2.2 — Where to place the button

**Two viable spots:**

1. **DPS panel card per slot** — mirrors FPS exactly. Lives next to
   each component's stat readout. Best for visibility when comparing
   stats.
2. **Hardpoint slot (`hardpoint-slot.html`)** — closer to where the
   item is selected. More intuitive UX but more template variation
   to handle.

**Recommendation: DPS panel card.** Same place FPS already does it,
keeps the visual pattern consistent.

### 2.3 — Implementation steps (mirror the FPS pattern)

**File:** `app/src/app/components/loadout-view/loadout-view.ts`
(or whichever component owns the ship-loadout state — confirm by
opening the component and looking for the existing `loadout` /
`equipped` signals)

**Step A — Load recipes**

Add to the parent component:

```ts
import { CraftingRecipe, BaseStats, QualityEffect } from '../quality-simulator/quality-simulator';

// Inside the class:
recipes = signal<CraftingRecipe[]>([]);
craftEffects = signal<Record<string, QualityEffect[]>>({});
craftModalSlotKey = signal<string | null>(null);

constructor(private http: HttpClient, ...) {
  // ... existing constructor body ...
  this.http.get<{ recipes: CraftingRecipe[] }>(`${prefix}versedb_crafting.json`)
    .subscribe(d => this.recipes.set(d.recipes ?? []));
}
```

**Step B — Helper functions per ship component type**

```ts
recipeForItem(item: Item | null): CraftingRecipe | null {
  if (!item) return null;
  return this.recipes().find(r => r.className === item.className) ?? null;
}

baseStatsForItem(item: Item | null): BaseStats {
  if (!item) return {};
  // Loose aliases — the simulator does fragment-matching with includes().
  // Cover every stat a ship-component recipe might modify. Look at
  // what qualityModifier "property" strings the recipes actually emit
  // (sample a few recipes after Phase 1.3) — you may need more keys.
  return {
    'damage':         (item as any).alphaDamage ?? null,
    'fire rate':      (item as any).fireRate ?? null,
    'recoil':         null,  // fill in once recipe property names are confirmed
    // Cooler-specific:
    'cooling rate':   (item as any).coolingRate ?? null,
    // Shield-specific:
    'hp':             (item as any).hp ?? null,
    'regen':          (item as any).regenRate ?? null,
    // Power plant:
    'power output':   (item as any).powerOutput ?? null,
    // Quantum drive:
    'speed':          (item as any).speed ?? null,
    'fuel rate':      (item as any).fuelRate ?? null,
    'spool time':     (item as any).spoolTime ?? null,
  };
}

isCrafted(slotKey: string | null | undefined): boolean {
  if (!slotKey) return false;
  const effects = this.craftEffects()[slotKey];
  if (!effects) return false;
  return effects.some(e => Math.abs(e.combined - 1.0) > 1e-4);
}

openCraft(slotKey: string | null): void {
  if (!slotKey) return;
  this.craftModalSlotKey.set(slotKey);
}
closeCraft(): void { this.craftModalSlotKey.set(null); }

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

craftModalTarget = computed(() => {
  const key = this.craftModalSlotKey();
  if (!key) return null;
  // You'll need to look up the equipped item by slotKey here.
  // The exact lookup depends on how loadout-view tracks slots — find
  // where the existing UI resolves slotKey → item and reuse that.
  const item = this.itemBySlotKey(key);  // <- write this helper
  if (!item) return null;
  return { slotKey: key, item };
});
```

**Step C — Add the button to the DPS panel template**

In the DPS panel sub-component or the stats card (find by searching
for where individual ship components render their stat readouts):

```html
@if (recipeForItem(card.item); as recipe) {
  <button class="craft-btn"
          [class.crafted]="isCrafted(card.slotKey)"
          (click)="openCraft(card.slotKey)">
    {{ isCrafted(card.slotKey) ? 'CRAFTED' : 'CRAFT' }}
  </button>
} @else {
  <button class="craft-btn craft-btn-disabled" disabled>
    NO RECIPE
  </button>
}
```

**SCSS hint:** copy `.dps-craft-btn` styles from
`app/src/app/components/fps-loadout/fps-loadout.scss` for the active
state. For the disabled `NO RECIPE` state, use a dimmed gray treatment:

```scss
.craft-btn-disabled {
  opacity: 0.4;
  color: var(--text3);
  border-color: rgba(255, 255, 255, 0.06);
  cursor: not-allowed;
  &:hover { /* no hover effect */ }
}
```

**Step D — Modal at page level**

Once per loadout-view template, near the bottom of the file:

```html
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
        }
      </div>
    </div>
  </div>
}
```

Don't forget to import `QualitySimulatorComponent` in the component
`imports` array.

### 2.4 — DPS panel craftEffects routing

This is the heaviest lift. Find the function that computes effective
stats for a ship component (likely `effectiveStats()`, `displayStats()`,
or similar — search for `alphaDamage`, `dps`, `coolingRate` etc.
mentions in the loadout-view or DPS panel TS).

Add a final layer that applies `craftEffects` after attachments + buffs:

```ts
effectiveStats(item: Item, slotKey: string | null): EffectiveStats {
  // ... existing pipeline: extractor values → attachment mods → buffs ...
  let damage = item.alphaDamage ?? 0;
  let dps = item.dps ?? 0;
  let coolingRate = (item as any).coolingRate ?? 0;
  // ... etc

  if (slotKey) {
    const effects = this.craftEffects()[slotKey];
    if (effects) {
      for (const eff of effects) {
        const p = eff.property.toLowerCase();
        const m = eff.combined;
        if (p.includes('damage'))            damage *= m;
        else if (p.includes('fire rate'))    {/* if applicable */}
        else if (p.includes('cooling'))      coolingRate *= m;
        else if (p.includes('hp'))           {/* if applicable */}
        // ... add a branch per property string the recipes actually use
      }
    }
  }

  return { damage, dps, coolingRate, ... };
}
```

**Critical:** check what exact `property` strings the simulator emits
for ship recipes. Sample by opening the modal on a real recipe and
inspecting `craftEffects()` in the browser console — the strings come
straight from CIG's localization and will match the simulator's input.

### 2.5 — Per-component baseStats coverage

Different ship components will need different `baseStats` keys. Sample
one recipe from each category and look at its `qualityModifiers[].property`
values:

```bash
python3 -c "
import json
c = json.load(open('app/public/live/versedb_crafting.json'))
for cat in ['ShipCooler','ShipPowerPlant','ShipShield','ShipRadar',
            'ShipQuantumDrive','ShipMiningLaser','ShipWeapon',
            'ShipTractorBeam','ShipSalvage']:
    rs = [r for r in c['recipes'] if r['category']==cat]
    if not rs: continue
    props = set()
    for r in rs:
        for ing in r.get('ingredients', []):
            for qm in ing.get('qualityModifiers', []):
                props.add(qm['property'])
    print(f'{cat}:')
    for p in sorted(props):
        print(f'  {p}')
"
```

Use the output to populate `baseStatsForItem()` with the right aliases.

---

## Phase 3 — Testing checklist

Before committing:

- [ ] `/crafting` page shows ship recipes with full ingredient lists
      (not empty arrays)
- [ ] Sort + filter dropdowns still work (Cooler, Power Plant, etc.)
- [ ] Open ship loadout, equip a Glacier cooler, see `CRAFT` button
- [ ] Click `CRAFT` → modal opens with quality sliders
- [ ] Move a slider → before/after preview shows new values
- [ ] Close modal → DPS panel reflects the crafted upgrades
- [ ] Equip a component without a recipe (if any exist) → button
      shows `NO RECIPE` and is disabled
- [ ] Reset button on the modal clears the effect
- [ ] Switch ships, switch back → craft state persists per-slot
- [ ] No console errors

---

## Phase 4 — Ship it

```bash
cd /home/bryan/projects/versedb
git status
# Stage the data + code:
git add app/public/live/versedb_crafting.json \
        app/src/app/components/loadout-view/ \
        app/src/app/components/<dps-panel-component>/
# (plus any extractor changes if you renamed categories)
git commit -m "Ship crafting: complete loadout integration

CIG shipped component crafting in patch <X.Y.Z>. Re-extracted
versedb_crafting.json against LIVE DCB to pull full recipes
(ingredients + qualityModifiers). Wired CRAFT/NO RECIPE button into
ship loadout DPS panel cards mirroring the FPS pattern; modal opens
the existing QualitySimulatorComponent; effects layer through
effectiveStats() into the DPS readouts.

Co-Authored-By: Claude <noreply@anthropic.com>"
git push origin main
```

**Crafting JSON does NOT go through the admin diff/import.** It's a
static file — preview AND prod read it directly via HTTP fetch. So
push = both surfaces update immediately.

If you also touched extractor scripts, mention which in the commit
message.

---

## Common gotchas

1. **Casing** — recipe `className` must be lowercase to match live
   item classNames. The XML-walker today does `.lower()` explicitly;
   verify the binary extractor does the same. If recipes don't match
   items by className, no CRAFT button will ever activate.

2. **Category strings** — today's `/crafting` page expects categories
   prefixed with `Ship` (`ShipCooler`, `ShipPowerPlant`, etc.). If the
   binary extractor emits different strings (`VehicleCooler`?), either
   rename in the extractor or update `crafting-view.ts`. See Phase 1.2.

3. **Empty ingredients today** — the partial recipes I committed have
   `ingredients: []`. The binary extractor will overwrite the file
   entirely, so this isn't a merge concern, just don't be surprised
   by the diff size.

4. **QualitySimulator property matching** — the simulator does
   substring matching on `property` keys. Don't be too specific in
   `baseStatsForItem()` — `'fire rate'` matches `'Fire Rate'` and
   `'fireRate'`. Cast a wide net.

5. **slotKey uniqueness** — the FPS pattern uses `'primary' | 'secondary'
   | 'pistol'`. Ship loadout has many more slots. Use the existing
   ship loadout's slot identifiers (probably hardpoint className or
   path-based keys). DON'T invent new ones — find what the loadout
   already uses for state tracking.

6. **DataService vs. component-local state** — FPS Loadout keeps
   recipes + craftEffects local to the component. Ship loadout might
   have recipes accessed from multiple sub-components (DPS panel,
   stats strip, etc.) — consider hoisting `recipes` to `DataService`
   if more than one consumer needs it. The DPS panel hooks need to
   read craftEffects somehow; pass them down via inputs or move the
   signal to a service.

7. **Saved Loadouts** — if loadouts can be saved (the `Stored
   Loadouts` feature), decide whether craft effects should persist
   in the save. **Recommend: no** — crafted upgrades are
   per-craft-roll, not per-loadout-spec. Document this choice in the
   commit if you go that way.

---

## File map (today's state)

```
PY SCRIPTS/
  extract_ship_crafting.py        ← XML-walker fallback (today's stop-gap)
  crafting_extract.py             ← THE production extractor (DCB binary, run tomorrow)
  versedb_crafting.json           ← regen target

app/public/live/versedb_crafting.json
  ← Currently has 1031 FPS + 377 partial ship recipes (empty ingredients)
  ← Will be fully replaced by tomorrow's crafting_extract.py run

app/src/app/components/
  crafting-view/
    crafting-view.ts              ← Today: added shipCoolers/shipPowerPlants/... computed dropdowns
    crafting-view.html            ← Today: added the dropdowns to the sidebar
  fps-loadout/
    fps-loadout.ts                ← Reference: the pattern to mirror
    fps-loadout.html              ← Reference: dps-craft-btn placement
    fps-loadout.scss              ← Reference: .dps-craft-btn styles
  quality-simulator/
    quality-simulator.ts          ← The shared modal — DO NOT modify
  loadout-view/                   ← Tomorrow's primary work area
  hardpoint-slot/                 ← Possible alternate placement
  ... (find the DPS panel sub-component)

CRAFTING_INTEGRATION_GUIDE.md      ← Read this end-to-end before starting Phase 2
```

---

## If something's not what you expect

- **No ship recipes at all after running `crafting_extract.py`** —
  the patch hasn't shipped yet, or it shipped to PTU not LIVE. Check
  build version. If only PTU has it, point the extractor at
  `--target ptu` (env var or arg, see `crafting_extract.py` top).

- **Recipes are there but `ingredients` arrays are still empty** —
  the binary parser found the blueprint records but couldn't resolve
  ingredient resources. This would be a real bug; capture a sample
  recipe and check whether `crafting_extract.py`'s ingredient-resolve
  loop ran. Could be a struct-name change in DCB v6.something. Bring
  it to the user before papering over.

- **`recipeForItem()` returns null for a known-craftable item** —
  className mismatch (casing, suffix). Compare:
  ```js
  console.log(item.className);
  console.log(recipes.map(r => r.className).filter(c => c.includes('glacier')));
  ```
  Fix at the extractor (preferred) — never lowercase at lookup time
  because that'd add per-call overhead.

- **DPS panel doesn't update when slider moves** — `effectiveStats()`
  isn't reading `craftEffects()` or isn't a computed signal that
  re-evaluates when the signal changes. Make sure it's a `computed()`
  that calls `this.craftEffects()`.

---

Good luck. Most of the heavy lifting is already done — Phase 2 is
the main task and the FPS pattern handles 90% of the design choices.
