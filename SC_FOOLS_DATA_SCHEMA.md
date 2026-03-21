# SC Fools — Data Schema Reference

Reference doc for understanding the ship/component data model, entity relationships, and file locations.

---

## File Locations

### TypeScript Types
- **Entity models**: `web/src/app/models/entities.ts`

### JSON Data (client-side, pipeline output)
All at `web/public/assets/data/`:

| File | Key Field | Description |
|------|-----------|-------------|
| `ships.json` | `id` | Ship entity records |
| `components.json` | `entityClassName` | Component entity records |
| `ship_hardpoints.json` | `id` (composite) | Hardpoint slots on ships |
| `hardpoint_compat.json` | `id` (composite) | Junction: which components fit which hardpoints |
| `ship_variants.json` | `id` (composite) | Junction: base ship ↔ variant ship |
| `paint_mappings.json` | `id` (composite) | Junction: paint ↔ ship |
| `dashboard_mappings.json` | `id` (composite) | Junction: dashboard ↔ ship |
| `manufacturers.json` | `ref` | Manufacturer lookup |

### Pipeline Scripts
All at `sc-data-extracted/`:
- `parse_vehicles.py` — extracts ships & hardpoints from Vehicle Implementation XML
- `parse_components.py` — extracts components from DCB XML
- `build_relationships.py` — matches components to hardpoints (tag/type/size logic)
- `export_for_stdb.py` — filters, deduplicates, prunes bespoke, exports final JSON

### Client Services
- **IndexedDB layer**: `web/src/app/services/indexeddb.service.ts`
- **In-memory data store**: `web/src/app/services/data-store.service.ts`

---

## Raw Data Sources (Data.p4k / Game2.dcb)

This section describes where each entity type lives inside the game archive and what to look for when manually inspecting the files.

### Ships — Vehicle Implementation XML (from Data.p4k)

**P4K path**: `Data/Scripts/Entities/Vehicles/Implementations/Xml/`
**Extracted to**: `sc-data-extracted/vehicles-all/`
**File pattern**: `*.xml` (one per ship/vehicle definition)
**Parser**: `parse_vehicles.py`

Each file is a Vehicle Implementation XML. The root element contains ship-level attributes:

```xml
<Vehicle
  name="AEGS_Avenger"              <!-- entity class name = Ship.id -->
  displayname="Avenger Stalker"    <!-- display name (may be loc key) -->
  subType="Vehicle_Spaceship"
  size="2"
  itemPortTags="$tag1 $tag2"       <!-- ship-level tags, inherited by ALL hardpoints -->
  requiredItemTags=""              <!-- ship-level restrictions (rare) -->
>
```

**Lookup reference**: The `name` attribute on the root element is the ship's entity class name and primary key.

**Hardpoints** are nested inside `<Parts>` → `<Part>` hierarchy as `<ItemPort>` elements:

```xml
<Part name="hardpoint_weapon_class2_nose">
  <ItemPort
    name="hardpoint_weapon_class2_nose"
    minSize="4"
    maxSize="4"
    portTags="$some_tag"           <!-- hardpoint-specific tags -->
    requiredTags=""                <!-- bespoke detection flag -->
    display_name="port_NameWeaponNose"
  >
    <Types>
      <Type type="WeaponGun" subtypes="" />
      <Type type="Turret" subtypes="" />
    </Types>
  </ItemPort>
</Part>
```

**Variants** are defined in `<Modifications>` sections within the same file or in separate files following the pattern `{BaseShip}_{VariantSuffix}.xml`.

### Components — DCB Records (from Game2.dcb)

Components are extracted from `Game2.dcb` (the DataForge binary) using unp4k/unforge. After conversion they land as XML files.

**DCB base path**: `libs/foundry/records/entities/scitem/ships/`
**Extracted to**: `sc-data-extracted/dcb-output/libs/foundry/records/entities/scitem/ships/`
**File pattern**: `**/*.xml.xml` (double extension from DCB→XML conversion)
**Parser**: `parse_components.py`

#### Component Subdirectories by Type

| DCB Subdirectory | Component Type(s) | Notes |
|---|---|---|
| `armor/` | Armor | Ship armor variants |
| `cooler/` | Cooler | Heat management |
| `powerplant/` | PowerPlant | Power generation |
| `shieldgenerator/` | Shield | Shield generators |
| `quantumdrive/` | QuantumDrive | QT drives |
| `radar/` | Radar | Detection systems |
| `weapons/` | WeaponGun | Guns, laser repeaters, cannons, etc. |
| `turret/` | Turret, TurretBase | Turret housings with sub-ports |
| `missile_racks/` | MissileLauncher | Missile rack assemblies |
| `bombcompartments/` | BombLauncher | Bomb delivery systems |
| `countermeasures/` | WeaponDefensive | Chaff/flare launchers |
| `thrusters/` | MainThruster, ManeuverThruster | Note: CIG misspells as "ManneuverThruster" |
| `controller/` | FlightController | Flight computers |
| `computers/` | Computer | Blade-hosting computers |
| `blades/` | Blade | Computer blade modules |
| `paints/` | Paints | Ship paint skins |
| `scanners/` | Scanner | Scanning equipment |
| `fuel_intakes/` | FuelIntake | Hydrogen scoops |
| `fueltanks/` | FuelTank | Hydrogen/quantum fuel storage |
| `batteries/` | Battery | Power storage |
| `cargogrid/` | Cargo | Cargo grid definitions |
| `gravitygenerator/` | GravityGenerator | Artificial gravity |
| `landingsystem/` | LandingSystem | Landing gear |
| `lifesupport/` | LifeSupport | Atmosphere management |
| `relay/` | Relay | Signal relay |
| `utility/` | TractorBeam, Utility | Utility attachments |
| `weapon_mounts/` | WeaponMount | Gimbal/fixed mounts |
| `quantumenforcementdevice/` | QuantumInterdictionGenerator | QED jammers |

#### Component XML Structure

Every component file has the same core structure:

```xml
<SomeComponentType>
  <AttachDef
    Type="Shield"                  <!-- component type -->
    SubType=""                     <!-- component subtype -->
    Size="4"                       <!-- size class -->
    Grade="2"                      <!-- quality grade -->
    Manufacturer="cf4a74bf-..."    <!-- manufacturer GUID ref -->
    Tags="$tag1 $tag2"            <!-- general component tags (space-delimited, $ prefix) -->
    RequiredTags="$bespoke_tag"   <!-- tags required to fit (bespoke matching) -->
    DisplayType=""
  />
  <Localization
    Name="@item_NameSHLD_Gemini_S4"    <!-- loc key for name -->
    ShortName="@item_ShortSHLD_Gemini_S4"
    Description="@item_DescSHLD_Gemini_S4"
  />
  <SCItemPurchasableParams displayName="Gemini Shield Generator" />
  <SHealthComponentParams Health="500" />

  <!-- Type-specific params (varies by component type): -->
  <SCItemShieldGeneratorParams MaxShieldHealth="5000" MaxShieldRegen="50" ... />
  <!-- OR -->
  <SCItemCoolerParams CoolingRate="100" ... />
  <!-- OR -->
  <SCItemPowerPlantParams PowerDraw="100" ... />
  <!-- etc. -->
</SomeComponentType>
```

**Lookup reference**: The file name (minus `.xml.xml`) is the component's entity class name (`entityClassName`), which is the primary key. You can also find it in the `<Localization Name="@item_Name{ECN}">` pattern.

### Turret Sub-Ports — DCB Turret Records

**DCB path**: `libs/foundry/records/entities/scitem/ships/turret/`
**Extracted to**: `sc-data-extracted/dcb-output/libs/foundry/records/entities/scitem/ships/turret/`
**Parser**: `parse_turret_ports.py`

Turrets define weapon sub-ports via `<SItemPortDef>` elements inside the turret XML:

```xml
<SItemPortDef
  Name="gun_01"                    <!-- sub-port name -->
  MinSize="3"
  MaxSize="3"
  PortTags="$tag"                  <!-- sub-port tags -->
  RequiredPortTags=""              <!-- sub-port restrictions -->
>
  <SItemPortDefTypes>
    <Type type="WeaponGun" />
  </SItemPortDefTypes>
</SItemPortDef>
```

**Lookup reference**: The turret's file name (ECN) is matched to ships via longest ECN prefix overlap with ship entity names and hardpoint name location tokens.

### Weapon Damage — DCB Binary + Ammo XML

Weapon damage values are NOT in the weapon XML itself. They require chaining through ammo records to binary DCB structs.

**Ammo XML path**: `libs/foundry/records/ammoparams/vehicle/`
**Extracted to**: `sc-data-extracted/dcb-output/libs/foundry/records/ammoparams/vehicle/`
**Parser**: `parse_damage_data.py`

**Lookup chain**:
1. **Weapon XML** → `<SAmmoContainerComponentParams ammoParamsRecord="...">` → ammo reference
2. **Ammo XML** → root attributes `speed`, `lifetime`, and `projectileParams="BulletProjectileParams[007C]"` — the hex value in `[...]` is a 0-based index into the BPP instance array in the DCB binary
3. **DCB binary** (`Game2.dcb`) → `BulletProjectileParams` struct (index 502) → polymorphic `damage` pointer at offset 16 → if variant is `DamageInfo` (index 1955), read 6×f32:

```
DamageInfo layout (24 bytes):
  offset 0:  DamagePhysical   (f32)
  offset 4:  DamageEnergy     (f32)
  offset 8:  DamageDistortion (f32)
  offset 12: DamageThermal    (f32)
  offset 16: DamageBiochemical (f32)
  offset 20: DamageStun       (f32)
```

**Parser**: `dcb_parser.py::get_all_weapon_damage()` chains: weapon ECN → ammo ECN → BPP index → DamageInfo floats.

**Fire rate**: From weapon XML `<SWeaponSequenceEntryParams delay="..." unit="RPM|Seconds">`.

### Localization — global.ini (from Data.p4k)

**P4K path**: `Data/Localization/english/global.ini`
**Extracted to**: `sc-data-extracted/global.ini`
**Parser**: `parse_localization.py`
**Format**: `key=value` pairs, one per line (~87K entries)

Key patterns:
- Ship names: `vehicle_Name{ShipEntityName}=Display Name` (329+ entries)
- Component names: `item_Name{ComponentECN}=Display Name` (8307+ entries)
- Manufacturer names: `manufacturer_Name{Code}=Display Name`
- Hardpoint names: `port_Name{PortName}=Display Name`

### Manufacturers — DCB Records

**DCB path**: `libs/foundry/records/entities/scitem/manufacturers/`
**Lookup reference**: Manufacturer `ref` is a UUID. Components reference manufacturers by this GUID in the `Manufacturer` attribute of `<AttachDef>`.

---

## Entity Schemas

### Ship
```typescript
interface Ship {
  id: string;            // Entity class name — e.g. "AEGS_Avenger"
  name: string;          // Same as id
  displayName: string;   // Localized — e.g. "Aegis Avenger Stalker"
  shortName: string;     // Abbreviated — e.g. "Avenger Stalker"
  subType: string;       // Always "Vehicle_Spaceship"
  size: string;          // "0"-"6" (XS through XXL)
  thrusters: ShipThruster[];
}

interface ShipThruster {
  componentId: string;   // Generic thruster ECN — e.g. "generic_MainThruster_FixedThruster_S4"
  count: number;
}
```

Example:
```json
{
  "id": "AEGS_Avenger",
  "name": "AEGS_Avenger",
  "displayName": "Aegis Avenger Stalker",
  "shortName": "Avenger Stalker",
  "subType": "Vehicle_Spaceship",
  "size": "2",
  "thrusters": [
    { "componentId": "generic_MainThruster_FixedThruster_S4", "count": 1 },
    { "componentId": "generic_ManeuverThruster_JointThruster_S1", "count": 2 }
  ]
}
```

### Component
```typescript
interface Component {
  entityClassName: string;  // Primary key — e.g. "SHLD_Gemini_S4"
  name: string;             // Loc key — e.g. "@item_NameSHLD_Gemini_S4"
  displayName: string;      // Localized display name
  shortName: string;        // Abbreviated display name
  type: string;             // Component type (see list below)
  subType: string;          // Subtype within type
  size: number;             // Size class (1-6)
  grade: string;            // Quality grade
  manufacturerCode: string; // Manufacturer code (GODI, ORIG, etc.)
  manufacturerName: string; // Manufacturer display name

  // Weapon-only fields (WeaponGun type)
  damagePhysical?: number;
  damageEnergy?: number;
  damageDistortion?: number;
  damageTotal?: number;
  fireRateRpm?: number;
  ammoSpeed?: number;
  ammoLifetime?: number;
}
```

**Component types**: WeaponGun, Turret, TurretBase, MissileLauncher, BombLauncher, PowerPlant, QuantumDrive, Cooler, Shield, Radar, FlightController, MainThruster, ManeuverThruster, QuantumInterdictionGenerator, TractorBeam, WeaponDefensive, Armor, Paints, SeatDashboard, Cargo, Misc

Example:
```json
{
  "entityClassName": "SHLD_Gemini_S4",
  "name": "@item_NameSHLD_Gemini_S4",
  "displayName": "Gemini Shield Generator",
  "shortName": "Gemini",
  "type": "Shield",
  "subType": "",
  "size": 4,
  "grade": "2",
  "manufacturerCode": "GODI",
  "manufacturerName": "Gorgon Defender Industries"
}
```

### ShipHardpoint
```typescript
interface ShipHardpoint {
  id: string;            // Composite: "shipId::hardpointName"
  shipId: string;        // FK → Ship.id
  name: string;          // Hardpoint name — e.g. "hardpoint_weapon_class2_nose"
  displayName: string;   // Loc key
  minSize: number;       // Min component size accepted
  maxSize: number;       // Max component size accepted
  types: string[];       // Allowed component types — e.g. ["WeaponGun", "Turret"]
  categories: string[];  // Derived category — e.g. ["weapon"]
}
```

Example:
```json
{
  "id": "AEGS_Avenger::hardpoint_weapon_class2_nose",
  "shipId": "AEGS_Avenger",
  "name": "hardpoint_weapon_class2_nose",
  "displayName": "port_NameWeaponNose",
  "minSize": 4,
  "maxSize": 4,
  "types": ["Turret", "WeaponGun"],
  "categories": ["weapon"]
}
```

### HardpointCompatibility (junction table)
```typescript
interface HardpointCompatibility {
  id: string;            // Composite: "hardpointId::componentId"
  hardpointId: string;   // FK → ShipHardpoint.id
  componentId: string;   // FK → Component.entityClassName
}
```

Example:
```json
{
  "id": "AEGS_Avenger::hardpoint_controller_flight::Controller_Flight_AEGS_Avenger_Stalker",
  "hardpointId": "AEGS_Avenger::hardpoint_controller_flight",
  "componentId": "Controller_Flight_AEGS_Avenger_Stalker"
}
```

### ShipVariant (junction table)
```typescript
interface ShipVariant {
  id: string;            // Composite: "baseShipId::variantShipId"
  baseShipId: string;    // FK → Ship.id (parent)
  variantShipId: string; // FK → Ship.id (variant)
}
```

### PaintMapping / DashboardMapping (junction tables)
```typescript
interface PaintMapping {
  id: string;            // "paintId::shipId"
  paintId: string;       // FK → Component.entityClassName
  shipId: string;        // FK → Ship.id
}

interface DashboardMapping {
  id: string;            // "dashboardId::shipId"
  dashboardId: string;   // FK → Component.entityClassName
  shipId: string;        // FK → Ship.id
}
```

---

## Entity Relationship Graph

```
Ship
 ├── ShipHardpoint[] ──(via shipId)
 │    └── HardpointCompatibility[] ──(via hardpointId)
 │         └── Component ──(via componentId / entityClassName)
 ├── ShipVariant[] ──(via baseShipId → variantShipId, both FK to Ship)
 ├── PaintMapping[] ──(via shipId → paintId, paintId FK to Component)
 └── DashboardMapping[] ──(via shipId → dashboardId, dashboardId FK to Component)

Component
 ├── HardpointCompatibility[] ──(via componentId → hardpointId → Ship)
 ├── PaintMapping[] ──(if type=Paints, via paintId → shipId)
 └── DashboardMapping[] ──(if type=SeatDashboard, via dashboardId → shipId)
```

**Key traversal patterns:**
- Ship → its hardpoints: filter `ship_hardpoints` where `shipId` matches
- Hardpoint → compatible components: filter `hardpoint_compat` where `hardpointId` matches, then look up each `componentId` in `components`
- Component → ships that can use it: filter `hardpoint_compat` where `componentId` matches, extract `shipId` from `hardpointId` (before first `::`)
- Ship → variants: filter `ship_variants` where `baseShipId` matches
- Ship → paints: filter `paint_mappings` where `shipId` matches

---

## Composite Key Format

All junction table IDs use `::` as delimiter:

| Table | ID Format |
|-------|-----------|
| ShipHardpoint | `{shipId}::{hardpointName}` |
| HardpointCompatibility | `{shipId}::{hardpointName}::{componentId}` |
| ShipVariant | `{baseShipId}::{variantShipId}` |
| PaintMapping | `{paintId}::{shipId}` |
| DashboardMapping | `{dashboardId}::{shipId}` |

To extract a shipId from a hardpoint ID: split on `::` and take index 0.
To extract the hardpoint name: split on `::` and take index 1.

---

## IndexedDB Stores

Database name: `sc-fools-data` (version 5)

| Store | Key Path | Content |
|-------|----------|---------|
| `_meta` | auto | Version hash for data sync |
| `manufacturers` | `ref` | Manufacturer records |
| `ships` | `id` | Ship records |
| `ship_variants` | `id` | Variant junction records |
| `components` | `entityClassName` | Component records |
| `ship_hardpoints` | `id` | Hardpoint records |
| `hardpoint_compatibility` | `id` | Compat junction records |
| `paint_mappings` | `id` | Paint junction records |
| `dashboard_mappings` | `id` | Dashboard junction records |

---

## In-Memory Derived Indexes (DataStoreService)

The client builds these reverse-lookup maps at load time:

```
hardpointsByShip:    Map<shipId, ShipHardpoint[]>
compatByHardpoint:   Map<hardpointId, componentId[]>
compatByComponent:   Map<componentId, hardpointId[]>
variantsByBase:      Map<baseShipId, variantShipId[]>
baseByVariant:       Map<variantShipId, baseShipId>
paintsByShip:        Map<shipId, paintId[]>
shipsByPaint:        Map<paintId, shipId[]>
dashboardsByShip:    Map<shipId, dashboardId[]>
shipsByDashboard:    Map<dashboardId, shipId[]>
```

---

## Compatibility Matching Logic

A component fits a hardpoint when ALL of:
1. **Type match**: component `type` is in hardpoint `types[]`
2. **Size match**: component `size` is within `[minSize, maxSize]`
3. **Tag match** (if tags exist):
   - Effective tags = hardpoint `portTags` ∪ ship `itemPortTags`
   - Component `requiredTags` ∩ effective tags → fits (bespoke)
   - Component `tags` ∩ effective tags → fits (overlap)
   - Component has `requiredTags` but no intersection → rejected
   - Non-editable hardpoint with no tag match → rejected

**Bespoke pruning** (post-matching, in export):
- ECN pattern `TYPE_MFR_SIZE_MODEL[_SCItem]` checked for ship model name
- If model matches a known ship, edges to OTHER ships are removed bidirectionally
- Exception list (`BESPOKE_IGNORE`): Centurion, Eclipse, Blizzard, Nova, Snowblind, etc. — never pruned

---

## Paint & Dashboard Matching (separate from hardpoints)

**Paints**: ECN pattern `Paint_{ModelName}_{Color}`. Model extracted and matched to ships using aliases and fuzzy patterns. Stored in `paint_mappings.json`, NOT in `hardpoint_compat.json`.

**Dashboards**: ECN pattern `SoftLock_EngineeringScreen_{Model}`. Generic tokens (StandardShip, Template) skipped. Ship-specific ones matched by model name. Stored in `dashboard_mappings.json`.
