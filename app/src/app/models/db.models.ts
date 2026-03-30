export interface HardpointAllType {
  type: string;
  subtypes: string;
}

export interface Hardpoint {
  id: string;
  label: string;
  type: string;
  subtypes: string;
  minSize: number;
  maxSize: number;
  flags: string;
  allTypes: HardpointAllType[];
  controllerTag?: string;
  portTags?: string;
  sourceModuleHpId?: string;
}

export interface Ship {
  className: string;
  name: string;
  manufacturer: string;
  mass: number;
  size: string;
  role: string;
  career: string;
  crew: number;
  hardpoints: Hardpoint[];
  defaultLoadout?: Record<string, string>;
  // Flight stats
  scmSpeed?: number;
  navSpeed?: number;
  boostSpeedFwd?: number;
  boostSpeedBwd?: number;
  boostRampUp?: number;
  boostRampDown?: number;
  pitch?: number;
  yaw?: number;
  roll?: number;
  pitchBoosted?: number;
  yawBoosted?: number;
  rollBoosted?: number;
  qdSpoolDelay?: number;
  flightSpoolDelay?: number;
  accelFwd?: number;
  accelRetro?: number;
  accelStrafe?: number;
  accelUp?: number;
  accelDown?: number;
  accelAbFwd?: number;
  accelAbRetro?: number;
  accelAbStrafe?: number;
  accelAbUp?: number;
  accelAbDown?: number;
  accelTestedDate?: string;
  accelCheckedBy?: string;
  // Hull
  totalHp?: number;
  bodyHp?: number;
  vitalParts?: Record<string, number>;
  dimWidth?: number;
  dimLength?: number;
  dimHeight?: number;
  // Armor
  armorHp?: number;
  armorDeflectPhys?: number;
  armorDeflectEnrg?: number;
  hullDmgPhys?: number;
  hullDmgEnrg?: number;
  hullDmgDist?: number;
  durabilityPhys?: number;
  durabilityEnrg?: number;
  durabilityDist?: number;
  signalEM?: number;
  signalCrossSection?: number;
  signalIR?: number;
  fusePenetrationMult?: number;
  componentPenetrationMult?: number;
  weaponPowerPoolSize?: number;
  ammoLoadMultiplier?: number;
  thrusterPowerBars?: number;
  cargoCapacity?: number;
  cmDecoys?: number;
  cmNoise?: number;
  oreCapacity?: number;
  salvageSpeedMult?: number;
  salvageRadiusMult?: number;
  salvageEfficiency?: number;
  // Fuel
  hydrogenFuelCapacity?: number;
  quantumFuelCapacity?: number;
  // Insurance
  insuranceStandardMinutes?: number;
  insuranceExpediteMinutes?: number;
  insuranceExpediteCost?: number;
  // Shop prices
  shopPrices?: ShopPrice[];
}

export interface ShopPrice {
  price: number;
  shop: string;
}

export interface CartEntry {
  item: Item;
  quantity: number;
}

export interface ItemDamage {
  physical?: number;
  energy?: number;
  distortion?: number;
  thermal?: number;
}

export interface Item {
  className: string;
  name: string;
  type: string;
  subType?: string;
  manufacturer?: string;
  size?: number;
  grade?: string;
  itemClass?: string;
  // Weapon
  isBallistic?: boolean;
  ammoCount?: number;
  regenCooldown?: number;
  costPerBullet?: number;
  requestedAmmoLoad?: number;
  maxAmmoLoad?: number;
  maxRegenPerSec?: number;
  maxRestockCount?: number;
  dps?: number;
  alphaDamage?: number;
  fireRate?: number;
  range?: number;
  projectileSpeed?: number;
  powerDraw?: number;
  damage?: ItemDamage;
  // Shield pool
  hp?: number;
  regenRate?: number;
  damagedRegenDelay?: number;
  downedRegenDelay?: number;
  // Shield resistance (fraction, e.g. 0.25 = 25%)
  resistPhysMax?: number; resistPhysMin?: number;
  resistEnrgMax?: number; resistEnrgMin?: number;
  resistDistMax?: number; resistDistMin?: number;
  // Shield absorption
  absPhysMax?: number; absPhysMin?: number;
  absEnrgMax?: number; absEnrgMin?: number;
  absDistMax?: number; absDistMin?: number;
  // Component health & distortion
  componentHp?: number;
  selfRepairTime?: number;
  selfRepairRatio?: number;
  distortionMax?: number;
  distortionDecayDelay?: number;
  distortionDecayRate?: number;
  emMax?: number;
  emDecayRate?: number;
  // PowerPlant
  powerOutput?: number;
  emSignature?: number;
  misfireCountdown?: number;
  misfireCancelRatio?: number;
  // Cooler
  coolingRate?: number;
  irSignature?: number;
  // QuantumDrive
  speed?: number;
  calTime?: number;
  spoolTime?: number;
  cooldownTime?: number;
  stageOneAccel?: number;
  stageTwoAccel?: number;
  interdictionTime?: number;
  calDelay?: number;
  fuelRate?: number;
  splineSpeed?: number;
  // EMP
  chargeTime?: number;
  distortionDamage?: number;
  empRadius?: number;
  // FlightController (blade)
  scmSpeed?: number;
  navSpeed?: number;
  boostSpeedFwd?: number;
  boostSpeedBwd?: number;
  pitch?: number;
  yaw?: number;
  roll?: number;
  pitchBoosted?: number;
  yawBoosted?: number;
  rollBoosted?: number;
  // Power segments (Shields, Coolers, QDs)
  powerMin?: number;
  powerMax?: number;
  powerBands?: { start: number; mod: number }[];
  minConsumptionFraction?: number;
  // Heat/overheat (ballistic weapons)
  heatPerShot?: number;
  moduleSlots?: number;
  // Penetration — all weapons
  penetrationDistance?: number;
  penetrationMinRadius?: number;
  penetrationMaxRadius?: number;
  // Detonation (proximity) params — distortion/scatter weapons
  detonationMinRadius?: number;
  detonationMaxRadius?: number;
  // Explosion radius — missiles/torpedoes
  explosionMinRadius?: number;
  explosionMaxRadius?: number;
  // Mining laser stats
  optimalRange?: number;
  maxRange?: number;
  throttleMin?: number;
  miningMinPower?: number;
  miningMaxPower?: number;
  // Mining laser modifiers (percentage adjustments)
  miningInstability?: number;
  miningOptimalWindow?: number;
  miningResistance?: number;
  // Mining module modifiers
  miningOptimalRate?: number;
  miningShatterDamage?: number;
  miningInertMaterials?: number;
  miningOvercharge?: number;
  miningPowerMult?: number;
  charges?: number;
  // Salvage modifier stats
  salvageSpeed?: number;
  salvageRadius?: number;
  salvageEfficiency?: number;
  maxHeat?: number;
  coolingDelay?: number;
  overheatCooldown?: number;
  // Radar
  aimMin?: number;
  aimMax?: number;
  aimBuffer?: number;
  irSensitivity?: number;
  emSensitivity?: number;
  csSensitivity?: number;
  rsSensitivity?: number;
  // Turret
  weaponLock?: string;
  itemTags?: string[];
  // Module (configurable ship modules like Aurora MK II cargo/combat)
  subPorts?: { id: string; type: string; minSize: number; maxSize: number; allTypes: { type: string }[] }[];
  cargoBonus?: number;
  // MissileLauncher (rack)
  capacity?: number;
  missileSize?: number;
  // Missile targeting
  armTime?: number;
  igniteTime?: number;
  lockTime?: number;
  lockAngle?: number;
  lockRangeMin?: number;
  lockRangeMax?: number;
  acquisition?: string;
  // Shop prices
  shopPrices?: ShopPrice[];
}

export interface DbMeta {
  game: string;
  version?: string;
  extractedBy: string;
  shipCount: number;
  itemCount: number;
  weapons: number;
  weaponsWithDPS: number;
  shields: number;
  powerPlants: number;
  coolers: number;
  quantumDrives: number;
}

export interface VerseDb {
  meta: DbMeta;
  ships: Ship[];
  items: Item[];
}

/**
 * Calculate energy weapon ammo at a given pip level.
 * Formula: ammo(N) = min(round(N × effBase / sumPower), cap)
 * effBase = maxAmmoLoad × ammoLoadMultiplier (from ship engineering buff)
 */
export function calcWeaponAmmo(weapon: Item, pips: number, poolSize: number, allWeapons: Item[], ammoLoadMultiplier = 1): number | null {
  if (!weapon || weapon.isBallistic) return weapon?.ammoCount ?? null;
  if (!weapon.powerDraw) return weapon?.ammoCount ?? null;
  const sumPower = allWeapons.reduce((s, w) => s + (w?.powerDraw ?? 0), 0);
  if (sumPower <= 0) return weapon.ammoCount ?? null;
  const effBase = (weapon.maxAmmoLoad ?? 75) * ammoLoadMultiplier;
  const cap = Math.ceil(effBase);
  const raw = pips * effBase / sumPower;
  return Math.min(Math.round(raw), cap);
}

/** Max weapon pips = min(poolSize, ceil(totalPowerDraw)). */
export function calcMaxPips(poolSize: number, allWeapons: Item[]): number {
  const sumPower = allWeapons.reduce((s, w) => s + (w?.powerDraw ?? 0), 0);
  return Math.min(poolSize, Math.ceil(sumPower));
}

/**
 * Get the band modifier for a component at a given pip allocation.
 * Walks bands from highest to lowest, returning the modifier for the
 * highest band whose start <= pips. Returns 0 if pips is 0 (off).
 */
export function bandModAt(item: Item, pips: number): number {
  if (pips <= 0) return 0;
  const bands = item.powerBands ?? [];
  if (bands.length === 0) return 1;
  let mod = bands[0].mod;
  for (const b of bands) {
    if (b.start <= pips) mod = b.mod;
    else break;
  }
  return mod;
}

/**
 * Calculate cooling supply from a single cooler at its current pip allocation.
 * supply = coolingRate × pips × bandMod(pips) / maxPips
 *
 * The band modifier represents efficiency at a given power level, while
 * pips/maxPips represents the fraction of power the cooler is receiving.
 * Total output = rate × efficiency × power_fraction.
 * Validated against Aurora MR II (8 configs) and Guardian MX (5 configs).
 */
export function coolerSupply(cooler: Item, pips: number): number {
  if (!cooler.coolingRate || pips <= 0) return 0;
  const maxPips = Math.max(1, (cooler.powerMax ?? 1) - 1);
  return cooler.coolingRate * pips * bandModAt(cooler, pips) / maxPips;
}

/**
 * Global maxPowerToCoolantRatio from ItemResourceNetworkGlobal.
 * Cooling demand = power consumed × this ratio for all non-PP components.
 */
const POWER_TO_COOLANT_RATIO = 2.5;

/**
 * Calculate cooling demand from a component at its current pip allocation.
 * Each component's cooling demand = power_consumed × maxPowerToCoolantRatio (2.5).
 * Power plants: flat demand = powerOutput (no ratio, bands disabled).
 */
export function componentCoolingDemand(item: Item, pips: number): number {
  if (pips <= 0) return 0;
  // Power plants: flat demand = powerOutput + 1 (base segment offset, no ratio)
  if (item.type === 'PowerPlant') return (item.powerOutput ?? 0) + 1;
  const psru = item.powerDraw ?? 0;
  if (psru <= 0) return 0;
  // Radar/QD: pips = power consumed directly
  if (item.type === 'Radar' || item.type === 'QuantumDrive') return pips * POWER_TO_COOLANT_RATIO;
  // Shields/Coolers/LS: PSRU × band_modifier × ratio
  return psru * bandModAt(item, pips) * POWER_TO_COOLANT_RATIO;
}
