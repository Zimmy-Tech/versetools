# Admin Editor Guide — Authoring Ships, Modules, and Sub-Ports

This document describes the admin-side workflow for creating and editing
ships, modules, and any item that carries sub-ports (turrets, missile
racks, mounts). It's the operating manual for the preset-driven editor.

The editor lives under `/admin` and is auth-gated. It writes directly to
the production Postgres database via the `PATCH /api/admin/items/:className`
and `PATCH /api/admin/ships/:className` endpoints. The extractor is NOT
involved in this workflow — edits survive re-extraction because items/ships
flagged with `source: 'curated'` are protected from import overwrites.

---

## Table of contents

1. [Overview and mental model](#overview-and-mental-model)
2. [Workflow 1 — Author a module from scratch](#workflow-1--author-a-module-from-scratch)
3. [Workflow 2 — Add hardpoints to a ship](#workflow-2--add-hardpoints-to-a-ship)
4. [Workflow 3 — Configure sub-ports on a turret/rack/mount](#workflow-3--configure-sub-ports-on-a-turretrackmount)
5. [Workflow 4 — Lock a slot so it can't be swapped](#workflow-4--lock-a-slot-so-it-cant-be-swapped)
6. [Workflow 5 — Build a new ship end-to-end](#workflow-5--build-a-new-ship-end-to-end)
7. [What each preset writes to the data model](#what-each-preset-writes-to-the-data-model)
8. [Troubleshooting](#troubleshooting)
9. [Code map](#code-map)
10. [Extending the editor](#extending-the-editor)

---

## Overview and mental model

The editor is **section-first**, not data-model-first. An admin thinks
in the same vocabulary a player uses: "Shields section", "Weapons section",
"Modules section". Every `[+ Add Hardpoint]` and `[+ Add Slot]` button is a
preset that generates a valid structured entry behind the scenes — the
admin never types raw JSON for `allTypes`, `minSize`, or `subPorts`.

Two data shapes the presets produce:

- **Ship hardpoint** — an entry in a ship's `hardpoints[]` array. Has
  extra metadata (`label`, `controllerTag`, `portTags`) on top of the
  slot fields.
- **Item sub-port** — an entry in an item's `subPorts[]` array. Modules
  and container items (turrets, racks, mounts) use sub-ports to declare
  what they can hold.

Both shapes share the same core fields: `id`, `type`, `subtypes`,
`minSize`, `maxSize`, `flags`, `allTypes`. A single preset catalogue
(`slot-presets.ts`) generates both.

### Why sub-ports auto-expand

When the player equips a turret (or any item with `subPorts`) into a ship
hardpoint, the loadout view recursively walks the sub-port tree and renders
the nested slots inline. This is the same recursion used by the hardpoint
editor's `slotsForHardpoint()` at
`app/src/app/components/admin/hardpoint-editor/hardpoint-editor.ts`
lines 181-251. So the admin doesn't have to build a deep tree — they equip
a turret, and the turret's own sub-ports appear as children automatically.

---

## Workflow 1 — Author a module from scratch

### Scenario

CIG ships a new Aurora combat module and you need to mirror it in the DB.
The module provides 8 S1 missile racks and one S1 shield slot.

### Steps

1. **Admin → Items → `+ New Item`**
2. Fill in the required fields:
   - **className**: `rsi_aurora_mk2_module_missile` (CIG's class name,
     lowercase, underscore-separated)
   - **type**: `Module`
   - **Display name**: `Aurora Mk II DM Module` (or whatever CIG localizes it as)
3. Click **Create**. The item is created with no sub-ports.
4. The right panel now shows the item editor. At the top you'll see a
   **Module Configuration** card with:
   - **Cargo Bonus (SCU)** — leave blank for non-cargo modules
   - **Slots provided by this module** — empty initially
   - **+ Add Shield / Weapon Slot / Missile Rack / Cooler / Power Plant**
     button rows, each with S1/S2/S3/… size buttons
5. Click **+ Add Missile Rack → S1** eight times. Eight rows appear, each
   labeled `S1 MissileRack` with an auto-generated id
   (`hardpoint_missile_rack_s1`, `_2`, `_3`, …).
6. Click **+ Add Shield → S1** once. One shield row appears.
7. (Optional) Rename any row's id inline by editing the text field.
8. Click **Save Changes**. The `subPorts` array is PATCHed to the DB.

### What the DB sees after save

```json
{
  "className": "rsi_aurora_mk2_module_missile",
  "type": "Module",
  "name": "Aurora Mk II DM Module",
  "subPorts": [
    { "id": "hardpoint_missile_rack_s1",   "type": "MissileLauncher", "subtypes": "MissileRack", "minSize": 1, "maxSize": 1, "allTypes": [{"type": "MissileLauncher", "subtypes": "MissileRack"}] },
    { "id": "hardpoint_missile_rack_s1_2", "type": "MissileLauncher", "subtypes": "MissileRack", "minSize": 1, "maxSize": 1, "allTypes": [{"type": "MissileLauncher", "subtypes": "MissileRack"}] },
    ...
    { "id": "hardpoint_shield_generator_1", "type": "Shield", "minSize": 1, "maxSize": 1, "allTypes": [{"type": "Shield"}] }
  ]
}
```

### What the player sees

The module is now pickable in any ship's Module hardpoint. When equipped,
the Modules section expands to show all 9 sub-ports as empty slots. The
player can pick missiles/shield via the standard item picker (auto-filtered
to matching size + type).

---

## Workflow 2 — Add hardpoints to a ship

### Scenario

You're starting a new ship and need to give it the usual kit: 2 shields,
2 wing guns, a missile rack, a power plant, a cooler, a quantum drive.

### Steps

1. **Admin → Hardpoints → pick the ship**
2. Click **+ Add Hardpoint**. A preset picker panel slides open at the top,
   with categories and size buttons:
   - Shield · S1 S2 S3 S4
   - Weapon Slot · S1 S2 S3 S4 S5 S6 S7 S8
   - Missile Rack · S1 S2 S3 S4 S5
   - Cooler · S1 S2 S3
   - Power Plant · S1 S2 S3
   - Quantum Drive · S1 S2 S3 S4
   - Module Slot · S1 S2 S3 S4 S5 S6
3. Click any size button. A hardpoint is created with:
   - Auto-generated unique id (e.g. `hardpoint_shield_generator_2`)
   - A friendly label (`Shield Generator (S2)`)
   - Correct `type`, `subtypes`, `allTypes`, `minSize`, `maxSize`
   - The row expands so you can rename the id or tweak fields
4. Repeat for each hardpoint you need. Nothing is persisted yet — this is
   a working copy.
5. Click **Save Changes** at the bottom when done.

### Advanced escape hatch

The preset picker has an **Advanced… (manual id)** link. Use it only when
the preset catalogue doesn't cover your need. It opens a prompt for a raw
id; after creation, you manually set `type`/`size` in the hardpoint's
expanded field editor.

### Notes

- Each preset button is idempotent: clicking the same one twice produces
  two hardpoints with different auto-ids (`hardpoint_shield_generator_2`,
  `hardpoint_shield_generator_2_2`).
- The id can be renamed inline after creation. If you use a duplicate id,
  the save will succeed but the loadout view may get confused.

---

## Workflow 3 — Configure sub-ports on a turret/rack/mount

### Scenario

You created a bespoke turret item that should have two S3 gun sub-slots
and one S1 missile sub-slot. Or, CIG shipped a turret that the extractor
doesn't know about, and you're defining its shape by hand.

### Steps

1. **Admin → Items → pick the turret item** (any item of type `Turret`,
   `TurretBase`, `WeaponMount`, `MissileLauncher`, `BombLauncher`, or
   `Module`)
2. The right panel shows the item editor with a **Slot Configuration**
   card at the top (named "Module Configuration" for modules specifically).
3. Add the slots via the same preset button rows you used for modules:
   - **+ Add Weapon Slot → S3** twice
   - **+ Add Missile Rack → S1** once
4. Rename ids if you want (e.g. `turret_left`, `turret_right`,
   `missile_back`). Each id must be unique within this item.
5. Click **Save Changes**. The item's `subPorts` array is PATCHed.

### How the ship sees it

When the player equips this turret in any ship hardpoint, the loadout view
automatically renders the turret's three new sub-slots inline (under the
turret's row in the Weapons section). The hardpoint editor does the same
via its recursive `slotsForHardpoint()` walk.

### Cargo bonus

For `type: 'Module'` items, an extra **Cargo Bonus (SCU)** field appears
at the top of the Slot Configuration card. This writes to the `cargoBonus`
field, which ships add into their cargo capacity when the module is
equipped. Non-module items (turrets, racks) don't show this field.

---

## Workflow 4 — Lock a slot so it can't be swapped

### Scenario

The Vanguard Harbinger has bespoke rocket pods that CIG doesn't let the
player swap. You want to replicate that on a new ship's turret.

### Steps

1. **Admin → Items → pick the turret item**
2. Find the sub-port row you want locked
3. Click the **🔓 (open lock)** button on that row. It turns into **🔒
   (closed lock)** and the row background tints gold.
4. Click **Save Changes**

### What happens behind the scenes

The row's `flags` field gets set to `$uneditable`. In the loadout view,
the player's hardpoint slot picks up that flag and renders as locked — no
swap button, no picker dropdown. The equipped item (whatever the
defaultLoadout specifies) stays put.

### What the flag means in CIG's data model

CIG's XML has `Flags="$uneditable"` on two distinct concepts:
1. **Engine-structural lock** — "attachment is rigidly mounted at the
   simulation level." Hammerhead upper guns, Polaris top turrets. Still
   player-swappable in-game.
2. **User-customisation lock** — slot is bespoke to a specific item;
   player cannot swap. Harbinger rockets, Polaris lower Maris cannons.

The extractor's heuristic distinguishes the two by looking for a
non-empty `RequiredPortTags` alongside the flag (case 2). When you set
the lock via this editor, you're explicitly declaring case 2 — the slot
is user-locked. That's almost always the right call for bespoke ship
configurations.

### Visual cue

Locked rows get a thin gold left accent and a slightly warmer background
so you can see at a glance which slots are locked when reviewing an
item with many sub-ports.

---

## Workflow 5 — Build a new ship end-to-end

### Scenario

CIG announces a new ship and you want to get it into VerseTools before
the extractor can parse it. You have the marketing copy: size-2 hull,
2× S3 wing guns (pilot), 1× S4 turret (crew) with 2× S3 gun sub-slots,
2× S2 shields, S2 power, S2 cooler, S2 quantum, 1× S3 missile rack.

### Steps

**Step 1 — Create the ship shell**

Admin → Ships → `+ New Ship`:
- className: `acme_new_hornet`
- type: `Ship`
- name: `ACME New Hornet`

**Step 2 — Add ship hardpoints**

Admin → Hardpoints → pick `ACME New Hornet` → `+ Add Hardpoint`:
- Weapon Slot → S3 (twice) — wing guns
- Module Slot → S4 — becomes the turret mount
- Shield → S2 (twice)
- Power Plant → S2
- Cooler → S2
- Quantum Drive → S2
- Missile Rack → S3

Rename ids if you like. Save.

**Step 3 — Create the bespoke turret item**

Admin → Items → `+ New Item`:
- className: `acme_turret_s4`
- type: `Turret`
- name: `ACME S4 Turret`

In the Slot Configuration card:
- + Add Weapon Slot → S3 (twice) — the turret's gun sub-slots

Save.

**Step 4 — Equip items on the ship**

Back to Admin → Hardpoints → `ACME New Hornet`:
- Equip a real S3 gun (e.g. `klwe_laserrepeater_s3`) on each wing slot
- Equip your new `acme_turret_s4` on the S4 module hardpoint
- The turret's two sub-slots appear as virtual rows under it
- Equip S3 guns in each sub-slot
- Equip a shield/power/cooler/quantum/missile-rack on the corresponding
  hardpoints

Save.

**Step 5 — Verify in the public loadout view**

Navigate to `/loadout` → pick `ACME New Hornet` → verify every slot
renders in its correct section, equipped items are displayed, and
stats (DPS, shield HP, power budget) compute sensibly.

If the turret sub-slots don't appear, it means step 3 didn't save
correctly or the turret className in the ship's default loadout
doesn't match — check spelling.

---

## What each preset writes to the data model

Reference for when you're debugging why a slot isn't behaving as expected.

### Shield preset (any size N)

```json
{
  "id": "hardpoint_shield_generator_N",
  "type": "Shield",
  "minSize": N,
  "maxSize": N,
  "allTypes": [{ "type": "Shield" }]
}
```
Item picker at equip time auto-filters to `type === 'Shield' && size === N`.

### Weapon Slot preset

```json
{
  "id": "hardpoint_weapon_sN",
  "type": "WeaponGun",
  "subtypes": "Gun",
  "minSize": N,
  "maxSize": N,
  "allTypes": [{ "type": "WeaponGun", "subtypes": "Gun" }]
}
```
Picker filters to `type === 'WeaponGun'`.

### Missile Rack preset

```json
{
  "id": "hardpoint_missile_rack_sN",
  "type": "MissileLauncher",
  "subtypes": "MissileRack",
  "minSize": N,
  "maxSize": N,
  "allTypes": [{ "type": "MissileLauncher", "subtypes": "MissileRack" }]
}
```
Picker filters to `type === 'MissileLauncher'`. Missile racks have their
own sub-ports for individual missile attach nodes, but you don't usually
add those manually — CIG ships racks with the attach nodes pre-defined
on the rack item itself.

### Cooler / Power Plant / Quantum Drive

Same shape as Shield — single `type` in `allTypes`, size constraint.

### Module Slot preset (ship hardpoint only)

```json
{
  "id": "hardpoint_module_sN",
  "type": "Module",
  "minSize": N,
  "maxSize": N,
  "allTypes": [{ "type": "Module" }]
}
```
Player picks a Module item at equip time. When equipped, the module's
sub-ports render under it in the Modules section.

### Ship hardpoint extras

Ship hardpoints get extra fields beyond the sub-port shape:
- **label** — auto-filled with `Shield Generator (SN)`, `Weapon Slot (SN)`,
  etc. via `defaultHardpointLabel()` in slot-presets.ts. Visible to the
  player.
- **controllerTag** — blank by default. Pilot vs. crew vs. remote turret
  attribution. Fill in manually if needed.
- **portTags** — blank by default. Compatibility tags for per-ship
  item restrictions.

### Lock flag

Setting the lock toggle on a sub-port adds `"flags": "$uneditable"`. The
loadout view at `hardpoint-slot.ts:21` checks for this flag and
disables the picker for the slot.

---

## Troubleshooting

### "I added a hardpoint but it's not in the loadout view"

1. Confirm the ship was saved (Save Changes button). The working copy
   doesn't persist until you save.
2. Hard-refresh the loadout view (Ctrl+Shift+R). The data.service caches
   the ship data and service worker may serve the old version.
3. Check `/api/db?mode=live` in the browser — does the ship's
   `hardpoints` array include your addition?

### "The picker for a slot shows the wrong items"

The picker filters by `type`, `size` (within minSize..maxSize), and
`allTypes`. Open the item editor for the slot's parent (ship or container)
and verify the sub-port's `type` and size constraints. Mismatched `type`
is the #1 cause — e.g. if you accidentally named a shield slot with
`type: 'WeaponGun'`, it'll try to show guns.

### "A locked slot isn't locking in the loadout view"

Check that the sub-port's `flags` field contains exactly `$uneditable`
(no spaces, no commas, no other tokens). The match at
`hardpoint-slot.ts:21` uses `flags.includes('uneditable')` so partial
matches work, but other values in the same field may conflict.

### "Saved the item but the loadout shows the old data"

The public app caches data.service reads with a service worker. The
admin save PATCH bypasses the cache, but the next loadout-view load may
still serve the cached copy. Force-refresh with Ctrl+Shift+R, or
navigate away and back.

### "A module's sub-slots aren't showing up under the module in the loadout view"

1. Confirm `subPorts` array on the module item contains the entries
   (check via the item editor — they should be listed in the Slot
   Configuration section)
2. Confirm the module is actually equipped in a ship hardpoint whose
   `type` is `Module`
3. Verify the ship's defaultLoadout key matches the equipped module's
   className (case-sensitive)

### "I deleted a hardpoint but the default loadout still has entries"

`removeHardpoint()` in hardpoint-editor.ts strips loadout keys that
start with the deleted hardpoint id. If entries linger, they were
keyed under a slightly-different id (casing, typo). Scan the loadout
entries manually — the admin page shows them under "orphan slots."

### "The dirty-changes indicator won't clear even after I save"

The dirty check compares form state to a JSON snapshot taken at load.
If the save succeeded but the indicator persists, the server may have
rejected part of the patch (check status message). Reset and retry, or
reload the item.

---

## Code map

Where everything lives, for when you need to find the logic behind a
specific behavior:

### Shared

- `app/src/app/components/admin/slot-presets.ts` — preset catalogue,
  `buildSlot()` generator, `groupedPresets()` helper,
  `MODULE_SUBPORT_CATEGORIES` / `SHIP_HARDPOINT_CATEGORIES` constants.

### Item editor

- `app/src/app/components/admin/item-editor/item-editor.ts`
  - `CONTAINER_TYPES` constant — which item types show the Slot Config card
  - `isContainerItem()` / `isModule()` / `slotConfigTitle()` computeds
  - `moduleSubPorts`, `moduleCargoBonus` signals (state)
  - `addModulePreset()` / `removeModuleSubPort()` / `renameModuleSubPort()`
  - `toggleSubPortLock()` / `isSubPortLocked()`
  - `save()` patches `subPorts` + `cargoBonus` alongside other dirty fields
- `app/src/app/components/admin/item-editor/item-editor.html` —
  Slot Configuration card is the first item in the `.sections` list,
  gated on `isContainerItem()`
- `app/src/app/components/admin/item-editor/item-editor.scss` —
  `.module-config`, `.module-slot-row`, `.slot-lock`, `.module-preset-*`

### Hardpoint editor

- `app/src/app/components/admin/hardpoint-editor/hardpoint-editor.ts`
  - `hardpointPresetGroups` constant
  - `presetPickerOpen` signal
  - `addHardpointFromPreset()` — preset path
  - `addHardpointManual()` — legacy prompt path (Advanced escape hatch)
  - `slotsForHardpoint()` — recursive walker that surfaces equipped
    items' sub-ports as virtual rows
- `app/src/app/components/admin/hardpoint-editor/hardpoint-editor.html` —
  Preset picker panel is conditional under the page header
- `app/src/app/components/admin/hardpoint-editor/hardpoint-editor.scss` —
  `.preset-picker`, `.preset-group`, `.preset-btn`

### Loadout view (read-only — what the player sees)

- `app/src/app/components/loadout-view/loadout-view.ts`
  - `subSlotsMap()` — per-hardpoint list of sub-slots inferred from
    equipped items' subPorts
  - `subSlotsForModules()` — module sub-ports for the Modules section
  - `moduleReserveShieldCount()` — drives the "+N reserve via module"
    header annotation on the Shields section
- `app/src/app/components/hardpoint-slot/hardpoint-slot.ts` — the
  `isLocked()` check on `hp.flags` is where `$uneditable` becomes
  visible as a locked slot in the UI

### API

- `api/server.js` — `PATCH /api/admin/items/:className` merges arbitrary
  fields into the DB item blob (JSONB), including `subPorts`, `cargoBonus`,
  and the `source: 'curated'` flag on first curation.
- `PATCH /api/admin/ships/:className` — same pattern for ship fields,
  including `hardpoints[]` and `defaultLoadout{}`.

---

## Extending the editor

### Adding a new preset category

Example: CIG ships a new "Beacon" component type with sizes 1-3.

1. Open `slot-presets.ts`
2. Add `'beacon'` to the `SlotCategory` type
3. Add the case to `buildSlot()` and `defaultHardpointLabel()`
4. Add an entry to `SLOT_CATEGORIES` array:
   `{ key: 'beacon', label: 'Beacon', sizes: [1, 2, 3] }`
5. Decide whether it belongs in `MODULE_SUBPORT_CATEGORIES` (can be inside
   a module) and/or `SHIP_HARDPOINT_CATEGORIES` (can be a ship hardpoint).
   Add to the relevant arrays.

The preset buttons auto-appear in both editors without further template
changes.

### Adding a new container-type item

Example: CIG introduces a new `DockingMount` type that can hold two
sub-ports of type `DockingCollar`.

1. Open `item-editor.ts`
2. Add `'DockingMount'` to `ItemEditorComponent.CONTAINER_TYPES`
3. That's it — items of that type will now show the Slot Configuration
   card.

If `DockingCollar` isn't already a preset category, add it first via the
extension above.

### Changing what a preset writes

Edit `buildSlot()` in `slot-presets.ts`. One function, one obvious place.
The output shape is validated implicitly by the data model — if your edit
produces a slot the loadout view can't render, you'll see an empty picker
or a missing section in the UI.

### Debugging data flow

The PATCH handler logs every admin save to the server console. Tail the
API server logs while clicking Save Changes to confirm the payload
matches expectations.
