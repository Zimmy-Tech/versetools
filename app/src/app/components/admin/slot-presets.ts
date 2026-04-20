// Shared slot-preset catalog used by the item editor (Module Config section)
// and the hardpoint editor (ship [+ Add Hardpoint] flow).
//
// A preset maps a human-friendly category + size ("Shield (S2)") to the
// structured slot shape the data model expects. The admin never types raw
// JSON — they click a button and get a valid slot.
//
// Slot output is used two ways:
//   - As an entry in an item's `subPorts` (for modules or turrets)
//   - As an entry in a ship's `hardpoints` (for ship-level hardpoints)
// The shapes are *almost* identical; hardpoints carry extra metadata (label,
// controllerTag, portTags) that gets filled in by the caller.

export type SlotCategory = 'shield' | 'weapon' | 'missile' | 'cooler' | 'power' | 'quantum' | 'module';

export interface SlotEntry {
  id: string;
  type: string;
  subtypes?: string;
  minSize: number;
  maxSize: number;
  flags?: string;
  allTypes: Array<{ type: string; subtypes?: string }>;
}

export interface SlotPreset {
  id: string;                       // preset key
  label: string;                    // button text
  category: SlotCategory;
  size: number;
  /** Human-readable label that fits ship-hardpoint naming conventions
   *  (e.g. "Shield Generator", "Weapon Slot"). Unused for item sub-ports. */
  hardpointLabel: string;
}

/** Deterministic id generator: base name + increment until unique. */
export function uniqueId(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  for (let i = 1; i < 100; i++) {
    const cand = `${base}_${i + 1}`;
    if (!existing.has(cand)) return cand;
  }
  return `${base}_${Date.now()}`;
}

/** Build the structured slot entry for a given category + size. */
export function buildSlot(category: SlotCategory, size: number, existingIds: Set<string>): SlotEntry {
  switch (category) {
    case 'shield':
      return {
        id: uniqueId(`hardpoint_shield_generator_${size}`, existingIds),
        type: 'Shield',
        minSize: size, maxSize: size,
        allTypes: [{ type: 'Shield' }],
      };
    case 'weapon':
      return {
        id: uniqueId(`hardpoint_weapon_s${size}`, existingIds),
        type: 'WeaponGun',
        subtypes: 'Gun',
        minSize: size, maxSize: size,
        allTypes: [{ type: 'WeaponGun', subtypes: 'Gun' }],
      };
    case 'missile':
      return {
        id: uniqueId(`hardpoint_missile_rack_s${size}`, existingIds),
        type: 'MissileLauncher',
        subtypes: 'MissileRack',
        minSize: size, maxSize: size,
        allTypes: [{ type: 'MissileLauncher', subtypes: 'MissileRack' }],
      };
    case 'cooler':
      return {
        id: uniqueId(`hardpoint_cooler_s${size}`, existingIds),
        type: 'Cooler',
        minSize: size, maxSize: size,
        allTypes: [{ type: 'Cooler' }],
      };
    case 'power':
      return {
        id: uniqueId(`hardpoint_power_s${size}`, existingIds),
        type: 'PowerPlant',
        minSize: size, maxSize: size,
        allTypes: [{ type: 'PowerPlant' }],
      };
    case 'quantum':
      return {
        id: uniqueId(`hardpoint_quantum_drive_s${size}`, existingIds),
        type: 'QuantumDrive',
        subtypes: 'QDrive',
        minSize: size, maxSize: size,
        allTypes: [{ type: 'QuantumDrive', subtypes: 'QDrive' }],
      };
    case 'module':
      return {
        id: uniqueId(`hardpoint_module_s${size}`, existingIds),
        type: 'Module',
        minSize: size, maxSize: size,
        allTypes: [{ type: 'Module' }],
      };
  }
}

/** Default human-readable label to apply to a ship-level hardpoint based on
 *  its category. Stored alongside the hardpoint so the player UI can show a
 *  friendly name without reading the raw id. */
export function defaultHardpointLabel(category: SlotCategory, size: number): string {
  switch (category) {
    case 'shield':  return `Shield Generator (S${size})`;
    case 'weapon':  return `Weapon Slot (S${size})`;
    case 'missile': return `Missile Rack (S${size})`;
    case 'cooler':  return `Cooler (S${size})`;
    case 'power':   return `Power Plant (S${size})`;
    case 'quantum': return `Quantum Drive (S${size})`;
    case 'module':  return `Module Slot (S${size})`;
  }
}

/** Build the preset list as a flat array for the button grid. */
const SLOT_CATEGORIES: ReadonlyArray<{ key: SlotCategory; label: string; sizes: number[] }> = [
  { key: 'shield',  label: 'Shield',          sizes: [1, 2, 3, 4] },
  { key: 'weapon',  label: 'Weapon Slot',     sizes: [1, 2, 3, 4, 5, 6, 7, 8] },
  { key: 'missile', label: 'Missile Rack',    sizes: [1, 2, 3, 4, 5] },
  { key: 'cooler',  label: 'Cooler',          sizes: [1, 2, 3] },
  { key: 'power',   label: 'Power Plant',     sizes: [1, 2, 3] },
  { key: 'quantum', label: 'Quantum Drive',   sizes: [1, 2, 3, 4] },
  { key: 'module',  label: 'Module Slot',     sizes: [1, 2, 3, 4, 5, 6] },
];

/** Subset of categories that make sense inside a module's sub-ports. Module
 *  slots don't contain other module slots; quantum drives aren't things a
 *  module typically nests either. */
export const MODULE_SUBPORT_CATEGORIES: SlotCategory[] = ['shield', 'weapon', 'missile', 'cooler', 'power'];

/** Subset for ship-level hardpoints. Ships can have anything. */
export const SHIP_HARDPOINT_CATEGORIES: SlotCategory[] = ['shield', 'weapon', 'missile', 'cooler', 'power', 'quantum', 'module'];

/** Build the full preset list. Consumers filter by the category subset they
 *  care about (modules or ships). */
export const SLOT_PRESETS: ReadonlyArray<SlotPreset> = SLOT_CATEGORIES.flatMap(cat =>
  cat.sizes.map(size => ({
    id: `${cat.key}_s${size}`,
    label: `${cat.label} (S${size})`,
    category: cat.key,
    size,
    hardpointLabel: defaultHardpointLabel(cat.key, size),
  }))
);

/** Group metadata for rendering button grids. Consumers pass in the category
 *  subset (MODULE_SUBPORT_CATEGORIES or SHIP_HARDPOINT_CATEGORIES) and get
 *  back display rows each with label + button list. */
export function groupedPresets(categories: SlotCategory[]): Array<{ key: SlotCategory; label: string; presets: SlotPreset[] }> {
  return SLOT_CATEGORIES
    .filter(c => categories.includes(c.key))
    .map(c => ({
      key: c.key,
      label: c.label,
      presets: SLOT_PRESETS.filter(p => p.category === c.key),
    }));
}
