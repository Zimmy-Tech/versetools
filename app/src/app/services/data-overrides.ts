import { VerseDb, Item } from '../models/db.models';

// Display-layer overrides applied at DB hydration.
//
// The extractor reports faithful DCB values. Some fields need a convention
// translation for player-facing display — e.g. charged weapons store min-
// charge damage in DCB but players reference full-charge damage; some items
// have localization names that don't match community/marketing names;
// beam weapons don't extract cleanly through the standard ammo chain.
//
// Keeping these here (not in the extractor) means:
//  - Diffs against new CIG builds show exactly what CIG changed in DCB
//  - A single source of truth for "where display differs from DCB"
//  - Re-extractions never clobber hand-curated values

/** item.className → display name that overrides the loc-resolved name. */
const NAME_OVERRIDES: Record<string, string> = {
  // Community/marketing names that don't appear in DCB localization
  'bmbrck_s03_behr_single_s03':             'CST-313 "Castillo"',
  'bomb_s05_fski':                          'Stormburst Bomb',
  'cool_just_s02_coolcore_scitem':          'CoolCore',
  'mrck_s10_aegs_idris_nose_s12_torpedo':   'HMF-T12 "Hammerfall" Torpedo Launcher',
  'mrck_s05_rsi_perseus_torpedo_l':         '5105 Torpedo Rack',
  'mrck_s05_rsi_perseus_torpedo_r':         '5105 Torpedo Rack',
  'qdrv_acas_s01_foxfire_scitem':           'FoxFire Quantum Drive',
  'qdrv_acas_s01_lightfire_scitem':         'LightFire Quantum Drive',
  'shld_banu_s02_placeholder_scitem':       'Sukoran Shield',
  'shld_rsi_s04_polaris_scitem':            'Glacis Shield',
  'jdrv_tars_s01_explorer_scitem':          'Explorer Jump Module',
  'jdrv_tars_s02_excelsior_scitem':         'Excelsior Jump Module',
  'jdrv_tars_s03_exodus_scitem':            'Exodus Jump Module',
  'jdrv_tars_s04_c_explorer':               'Explorer Jump Module (Capital)',
  'jdrv_aegs_s04_javelin_scitem':           'Javelin Jump Module',
  'jdrv_orig_s04_890j_scitem':              '890 Jump Module',
  'jdrv_wetk_s04_idris_scitem':             'Exfiltrate Jump Module',
  'jdrv_rsi_s04_bengal_scitem':             'Bengal Jump Module',
};

/** item.className → multiplier applied to damage/alphaDamage/dps.
 *  DCB stores per-charge-tier damage for charged weapons; players cite the
 *  full-charge value. Multiplier captures that convention gap. Prefer
 *  VALUE_OVERRIDES when the weapon also needs a specific fireRate (DPS is
 *  derived and multiplying raw DPS won't produce the right number when the
 *  fireRate itself is off). */
const DAMAGE_MULTIPLIERS: Record<string, number> = {
  // (moved klwe_massdriver_s10 to VALUE_OVERRIDES — its fireRate needs
  //  overriding too, not just damage)
};

/** item.className → fields to set/overwrite wholesale. Used where DCB doesn't
 *  expose the field cleanly (beam weapons don't use the standard ammo→BPP→
 *  DamageInfo chain; charged weapons like the Destroyer Mass Driver have
 *  multiple charge tiers and the derived DPS is only correct at max charge). */
const VALUE_OVERRIDES: Record<string, Partial<Item>> = {
  'hrst_laserbeam_bespoke': {
    damage: { physical: 0, energy: 15000, distortion: 0, thermal: 0 },
    alphaDamage: 15000,
    dps: 15000,
    fireRate: 60,
    penetrationDistance: 29.4,
    penetrationMinRadius: 1.47,
    penetrationMaxRadius: 2.94,
  },
  // Destroyer Mass Driver (Idris-M nose): DCB base alpha is 144,160 at 1.5 RPM
  // (uncharged). maxChargeModifier damageMultiplier=2 doubles alpha on full
  // charge, which is the only way players actually fire this weapon.
  // Validated fireRate = 2.0 via Erkul/SPViewer (cycle = chargeTime +
  // cooldownTime = 10 + 20 = 30s, ignoring inner single-fire rate).
  'klwe_massdriver_s10': {
    damage: { physical: 288320, energy: 0, distortion: 0, thermal: 0 },
    alphaDamage: 288320,
    fireRate: 2.0,
    dps: 9610.67,
  },
};

/** Apply display overrides to a loaded VerseDb. Mutates in place — hydration
 *  is a one-shot transform, not reactive. */
export function applyDataOverrides(db: VerseDb): VerseDb {
  for (const item of db.items) {
    const cls = item.className;

    const nameOverride = NAME_OVERRIDES[cls];
    if (nameOverride) item.name = nameOverride;

    const mult = DAMAGE_MULTIPLIERS[cls];
    if (mult && mult !== 1) applyDamageMultiplier(item, mult);

    const valueOverride = VALUE_OVERRIDES[cls];
    if (valueOverride) Object.assign(item, valueOverride);
  }
  return db;
}

function applyDamageMultiplier(item: Item, mult: number): void {
  if (typeof item.alphaDamage === 'number') item.alphaDamage = round2(item.alphaDamage * mult);
  if (typeof item.dps === 'number')         item.dps         = round2(item.dps * mult);
  if (item.damage) {
    for (const k of Object.keys(item.damage) as (keyof typeof item.damage)[]) {
      const v = item.damage[k];
      if (typeof v === 'number') item.damage[k] = round2(v * mult);
    }
  }
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
