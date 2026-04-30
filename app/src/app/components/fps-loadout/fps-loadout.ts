import { Component, computed, signal, inject, effect } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import {
  QualitySimulatorComponent,
  CraftingRecipe,
  QualityEffect,
  BaseStats,
} from '../quality-simulator/quality-simulator';
import { DataService } from '../../services/data.service';

interface Port {
  name: string;
  displayName: string;
  minSize: number;
  maxSize: number;
  types: string[];
  flags: string;
  selectTag: string;
}

interface WeaponPort {
  name: string;
  attachSlot: string;          // optics | barrel | underbarrel | magazine
  minSize: number;
  maxSize: number;
  requiredPortTags: string[];
}

interface FpsWeaponRaw {
  className: string; name: string; manufacturer: string;
  type: string; subType?: string; size: number; mass?: number;
  fireRate?: number; isCharged?: boolean | null;
  fireModes?: string[]; magazineSize?: number;
  projectileSpeed?: number; range?: number;
  damage?: { physical: number; energy: number; distortion: number; thermal: number; biochemical: number; stun: number };
  alphaDamage?: number; dps?: number;
  sequenceEntries?: number | null;
  pelletCount?: number | null;
  isBeam?: boolean | null;
  recoilPitch?: number | null;
  recoilYaw?: number | null;
  recoilSmooth?: number | null;
  adsTime?: number;
  adsZoomScale?: number;
  ports?: WeaponPort[];
}

/** Stats as the DPS panel displays them — this is the type that future
 *  attachment + crafting modifiers will produce. Build the panel against
 *  this shape so we can plug modifiers in without rewiring. */
interface EffectiveStats {
  alphaDamage: number;
  dps: number;
  realDps: number | null;       // tick-quantized (sequence weapons), null if N/A
  fireRate: number;
  isCharged: boolean;
  magazineSize: number;
  range: number;
  projectileSpeed: number;
  damageType: string;           // "Physical" | "Energy" | "Mixed" | ...
  damageBreakdown: { physical: number; energy: number; distortion: number; thermal: number; biochemical: number; stun: number };
  recoilPitch: number;          // degrees of vertical kick per shot
  recoilYaw: number;            // degrees of horizontal kick per shot
  recoilSmooth: number;         // seconds of recovery before next shot lands clean
  // Relative-only mults (no absolute base value on the weapon). 1.0 = unchanged.
  firstShotKickMult: number;    // how hard the FIRST shot hits (vs subsequent)
  visualRecoilMult: number;     // screen-shake amplitude when firing
  spreadMult: number;           // bullet dispersion random cone
  recoilTimeMult: number;       // duration of each recoil impulse
  magAlpha: number;             // total damage per full mag (before reload)
  mass: number;
  adsTime: number;              // seconds to enter aim-down-sights
  adsZoomScale: number;         // magnification when aiming
}
interface OpticSpec {
  zoomScale?: number;
  secondZoomScale?: number;
  zoomTimeScale?: number;
  scopeType?: 'Zoom' | 'Nightvision' | 'None' | string;
}
interface FpsAttachRaw {
  className: string; name: string; manufacturer: string;
  attachSlot: string; attachType: string; subType: string;
  size: number; mass: number;
  tags: string[]; requiredTags: string[];
  modifiers?: Record<string, number>;
  opticSpec?: OpticSpec;
}
interface FpsMagRaw {
  className: string; name: string; manufacturer: string;
  weaponTag: string; ammoCount: number; mass: number; size: number;
  subType: string; ammoType: string;
}
interface FpsGearRaw {
  className: string; name: string; manufacturer: string;
  attachType: string; subType: string; size: number; mass: number;
  category: string;
}

// Unified item view surfaced to the picker. `attachType` is the key that
// matches against port.types[] — weapons default to WeaponPersonal, mags to
// WeaponAttachment, gear already carries its own.
interface Equippable {
  className: string;
  name: string;
  manufacturer: string;
  attachType: string;
  subType: string;
  size: number;
  mass: number;
  source: 'weapon' | 'magazine' | 'gear' | 'attachment';
  detail: string;        // one-liner shown in picker row
  category?: string;     // gear only — drives hip/utility slot eligibility
  // Attachment-specific fields (only populated when source === 'attachment').
  attachSlot?: string;   // optics | barrel | underbarrel | magazine
  tags?: string[];
  modifiers?: Record<string, number>;
  opticSpec?: OpticSpec;
  // Weapon-specific: its own ports for nested attachment slots.
  ports?: WeaponPort[];
}

interface ArmorPiece {
  className: string;
  name: string;
  setName: string;
  manufacturer: string;
  weight: string;  // light | medium | heavy | undersuit
  slot: string;    // core | arms | legs | backpack | undersuit | helmet
  damageReduction: number | null;
  mass: number | null;
  // 4.8 PTU only — null on LIVE extracts. Working hypothesis is that
  // outfit total = sum of equipped pieces' gForceResistance values
  // (see research_armor_flight_performance.md). Sum surfaces as a
  // G-Tol summary row in the loadout panel; when every equipped
  // piece is null (LIVE mode), the row hides.
  gForceResistance: number | null;
  ports: Port[];
}

type WeightTier = 'light' | 'medium' | 'heavy';
type SourceTag = 'core' | 'legs' | 'arms' | 'backpack' | 'undersuit';

// Anchor positions for port classes on a front-view body (percentage coords).
// When we see a port name we don't recognise we fall through to a generic
// placement so it still renders, just flagged for refinement.
interface Anchor { x: number; y: number; label: string; }

function anchorFor(portName: string, index: number): Anchor {
  const n = portName.toLowerCase();

  // Stocked weapons: back-left / back-right (shown to the sides of the body).
  if (n === 'wep_stocked_2') return { x: 12, y: 32, label: 'BACK L' };
  if (n === 'wep_stocked_3') return { x: 88, y: 32, label: 'BACK R' };

  // Sidearm: hip right.
  if (n === 'wep_sidearm')   return { x: 66, y: 58, label: 'HIP' };

  // Grenades: chest row, centered three-slot cluster with a touch of
  // breathing room so the slot boxes don't kiss at hover scale.
  if (n.startsWith('grenade_attach_')) {
    const xs = [40, 50, 60];
    return { x: xs[index % xs.length], y: 30, label: 'GREN' };
  }

  // Mag pouches: one wide belt row, 8 evenly spaced positions
  // symmetric around x=50 (10-unit gaps, 15..85 range).
  if (n.startsWith('magazine_attach_')) {
    const xs = [15, 25, 35, 45, 55, 65, 75, 85];
    return { x: xs[index % xs.length], y: 42, label: 'MAG' };
  }

  // MedPens: left thigh.
  if (n.startsWith('medpen_attach_')) {
    return { x: 40, y: 70 + index * 5, label: 'MED' };
  }

  // OxyPens: right thigh.
  if (n.startsWith('oxypen_attach_')) {
    return { x: 60, y: 70 + index * 5, label: 'OXY' };
  }

  // Utility / chip: belt row.
  if (n.startsWith('utility_attach_')) {
    const xs = [34, 66];
    return { x: xs[index % xs.length], y: 52, label: 'UTIL' };
  }

  // Gadgets: chest center/top.
  if (n.startsWith('gadget_attach_')) {
    return { x: 50, y: 38, label: 'GAD' };
  }

  // Backpack receptacle on the core: mark offset on the back (upper right).
  if (n === 'backpack') return { x: 92, y: 48, label: 'PACK' };

  // Armor socket ports (torso/helmet) — skip for now (user said ignore helmet).
  if (n.startsWith('armor_') || n.includes('helmethook') || n.includes('necksock')) {
    return { x: -100, y: -100, label: '' };   // off-screen sentinel
  }

  // Fallback — park it at bottom so the user can see it exists and tell us
  // where it really belongs.
  return { x: 50 - 4 * index, y: 92, label: portName };
}


@Component({
  selector: 'app-fps-loadout',
  standalone: true,
  imports: [QualitySimulatorComponent],
  templateUrl: './fps-loadout.html',
  styleUrl: './fps-loadout.scss',
})
export class FpsLoadoutComponent {
  armor = signal<ArmorPiece[]>([]);
  loaded = signal(false);

  tier = signal<WeightTier>('medium');
  coreClass = signal<string | null>(null);
  armsClass = signal<string | null>(null);
  legsClass = signal<string | null>(null);
  backpackClass = signal<string | null>(null);
  undersuitClass = signal<string | null>(null);

  // Item catalog for the picker.
  weapons = signal<FpsWeaponRaw[]>([]);
  magazines = signal<FpsMagRaw[]>([]);
  gear = signal<FpsGearRaw[]>([]);
  attachments = signal<FpsAttachRaw[]>([]);

  // equipped: map from slot.key → item.className
  equipped = signal<Record<string, string>>({});

  // Crafting state — keyed by the weapon's armor-slot key, stores the live
  // QualityEffect[] array the shared QualitySimulatorComponent emits when
  // the user drags sliders. Applied in effectiveStats() after attachments.
  craftEffects = signal<Record<string, QualityEffect[]>>({});
  recipes = signal<CraftingRecipe[]>([]);

  // Picker state.
  pickerSlotKey = signal<string | null>(null);
  pickerSearch = signal('');
  // Sort state for the columnar weapon picker. Default: highest DPS
  // first, since that's the most common "what should I pick?" lens.
  pickerSortKey = signal<string>('dps');
  pickerSortDir = signal<'asc' | 'desc'>('desc');

  private data = inject(DataService);

  constructor(private http: HttpClient) {
    // DB-first path: read the FPS arrays off DataService's db() signal.
    // Fires any time the mode toggles, so live/ptu switches rehydrate.
    effect(() => {
      const db = this.data.db();
      const fpsArmor = db?.fpsArmor as ArmorPiece[] | undefined;
      const fpsItems = db?.fpsItems as any[] | undefined;
      const fpsGear  = db?.fpsGear  as FpsGearRaw[] | undefined;
      // Require non-empty so a fresh DB (empty FPS tables before the
      // first import) doesn't leave the loadout page stranded —
      // static-JSON fallback still runs and populates the doll.
      if (fpsArmor?.length && fpsItems?.length && fpsGear?.length) {
        this.hydrateFromDb(fpsArmor, fpsItems, fpsGear);
      }
    });
    // Armor JSON: mode-aware fallback so the G-Tol summary reflects the
    // active mode's gForceResistance values (4.8 PTU only). The other
    // three static fallbacks (weapons / gear / crafting) stay hardcoded
    // to live/ for now — the full mode-aware refactor is tracked in
    // project_mode_aware_db_pages.md.
    //
    // Always overwrite this.armor() on mode flip — equipped slot
    // computeds resolve by className, so a user's selections persist
    // across modes when the className exists in both, and gracefully
    // degrade to "no piece" when it doesn't.
    effect(() => {
      const prefix = this.data.dataPrefix();
      this.http.get<{ armor: ArmorPiece[] }>(`${prefix}versedb_fps_armor.json`).subscribe({
        next: d => {
          this.armor.set(d.armor);
          if (!this.loaded()) {
            this.seedArmorDefaults(d.armor);
            this.loaded.set(true);
          }
        },
      });
    });
    // JSON-first path (preview / GitHub Pages): no-op once DB has won
    // but keeps the preview deployment populated without an API.
    this.loadFromStaticJson();
  }

  private hydrateFromDb(fpsArmor: ArmorPiece[], fpsItems: any[], fpsGear: FpsGearRaw[]): void {
    this.armor.set(fpsArmor);
    this.seedArmorDefaults(fpsArmor);
    this.weapons.set(fpsItems.filter((x) => x._kind === 'weapon') as FpsWeaponRaw[]);
    this.magazines.set(fpsItems.filter((x) => x._kind === 'magazine') as FpsMagRaw[]);
    this.attachments.set(fpsItems.filter((x) => x._kind === 'attachment') as FpsAttachRaw[]);
    this.gear.set(fpsGear);
    this.loaded.set(true);
  }

  private seedArmorDefaults(armor: ArmorPiece[], force = false): void {
    if (!force && this.undersuitClass() !== null) return; // don't clobber user pick
    const pickFirst = (slot: string, weight: string) =>
      armor.find(a => a.slot === slot && a.weight === weight)?.className ?? null;
    this.undersuitClass.set(pickFirst('undersuit', 'undersuit'));
    this.coreClass.set(pickFirst('core', 'medium'));
    this.legsClass.set(pickFirst('legs', 'medium'));
    this.armsClass.set(pickFirst('arms', 'medium'));
    this.backpackClass.set(pickFirst('backpack', 'medium'));
  }

  /** Wipe the entire loadout back to the medium-tier armor defaults.
   *  Clears every equipped item, every crafting override, and any
   *  open picker/focus state. User gets a confirm prompt first since
   *  this is destructive to in-flight work. */
  resetToDefault(): void {
    const ok = window.confirm(
      'Reset the loadout?\n\n' +
      'This clears every equipped weapon, magazine, attachment, grenade, ' +
      'medpen, and utility item, plus any crafting quality rolls. Armor ' +
      'reverts to the default medium set. This cannot be undone.'
    );
    if (!ok) return;
    this.equipped.set({});
    this.craftEffects.set({});
    this.tier.set('medium');
    this.seedArmorDefaults(this.armor(), true);
    this.pickerSlotKey.set(null);
    this.focusedSlotKey.set(null);
    this.craftModalSlotKey.set(null);
  }

  private loadFromStaticJson(): void {
    // NOTE: armor JSON is loaded via the mode-aware effect in the
    // constructor — not here. The other three URLs (fps weapons, gear,
    // crafting) are still hardcoded to live/ pending the full
    // mode-aware refactor (see project_mode_aware_db_pages.md).
    this.http.get<{ weapons: FpsWeaponRaw[]; magazines: FpsMagRaw[]; attachments?: FpsAttachRaw[] }>('live/versedb_fps.json').subscribe({
      next: d => {
        if (this.weapons().length > 0) return;
        this.weapons.set(d.weapons);
        this.magazines.set(d.magazines ?? []);
        this.attachments.set(d.attachments ?? []);
      },
    });
    this.http.get<{ items: FpsGearRaw[] }>('live/versedb_fps_gear.json').subscribe({
      next: d => {
        if (this.gear().length > 0) return;
        this.gear.set(d.items);
      },
    });
    // Crafting recipes stay JSON-only for now — they're not part of the
    // FPS DB promotion. A follow-up can move them once the schema
    // stabilizes around the upcoming CIG crafting revamp.
    this.http.get<{ recipes: CraftingRecipe[] }>('live/versedb_crafting.json').subscribe(d => {
      this.recipes.set(d.recipes);
    });
  }

  // Flattened, typed catalog of everything equippable.
  catalog = computed<Equippable[]>(() => {
    const out: Equippable[] = [];
    for (const w of this.weapons()) {
      out.push({
        className: w.className, name: w.name, manufacturer: w.manufacturer,
        attachType: 'WeaponPersonal', subType: w.type, size: w.size,
        mass: w.mass ?? 0, source: 'weapon',
        detail: `${w.type} · S${w.size}${w.alphaDamage ? ` · α${w.alphaDamage}` : ''}${w.dps ? ` · ${w.dps} DPS` : ''}`,
        ports: w.ports ?? [],
      });
    }
    for (const m of this.magazines()) {
      out.push({
        className: m.className, name: m.name, manufacturer: m.manufacturer,
        attachType: 'WeaponAttachment', subType: 'Magazine', size: m.size,
        mass: m.mass, source: 'magazine',
        detail: `Magazine · ${m.ammoCount} rd · ${m.ammoType}`,
        // Allow mags to flow through the weapon-port rule too: they declare
        // attachSlot='magazine' and carry the weapon-class tag so each mag
        // only fits its own weapon's magazine_attach port.
        attachSlot: 'magazine',
        tags: [m.weaponTag],
      });
    }
    for (const g of this.gear()) {
      out.push({
        className: g.className, name: g.name, manufacturer: g.manufacturer,
        attachType: g.attachType, subType: g.subType, size: g.size,
        mass: g.mass, source: 'gear',
        detail: g.category,
        category: g.category,
      });
    }
    for (const a of this.attachments()) {
      const modCount = a.modifiers ? Object.keys(a.modifiers).length : 0;
      out.push({
        className: a.className, name: a.name, manufacturer: a.manufacturer,
        attachType: a.attachType, subType: a.subType, size: a.size,
        mass: a.mass, source: 'attachment',
        detail: `${a.attachSlot} · S${a.size}${modCount ? ` · ${modCount} mods` : ''}`,
        attachSlot: a.attachSlot,
        tags: a.tags,
        modifiers: a.modifiers,
        opticSpec: a.opticSpec,
      });
    }
    return out;
  });

  // Compatibility test. We handle two shapes of "port":
  //   - Armor ports (Port): matched by accepted attachType + size.
  //   - Weapon-attachment ports (projected): matched by attachSlot + size
  //     + port.requiredPortTags ⊆ item.tags.
  private portAccepts(port: Port | (Port & { attachSlot?: string; requiredPortTags?: string[] }), item: Equippable): boolean {
    const wp = port as any;
    if (wp.attachSlot) {
      // Weapon-level port (optics_attach / barrel_attach / underbarrel_attach / magazine_attach).
      if (item.attachSlot !== wp.attachSlot) return false;
      if (item.size < port.minSize) return false;
      if (port.maxSize > 0 && item.size > port.maxSize) return false;
      const need: string[] = wp.requiredPortTags ?? [];
      const have = item.tags ?? [];
      for (const t of need) if (!have.includes(t)) return false;
      return true;
    }
    // Armor port.
    if (!port.types.includes(item.attachType)) return false;
    if (item.size < port.minSize) return false;
    if (port.maxSize > 0 && item.size > port.maxSize) return false;

    const portName = port.name.toLowerCase();
    const cat = item.category ?? '';

    // Armor mag pouches physically hold magazines only — don't let optics,
    // barrels, or underbarrels bleed in even though they share attachType.
    if (portName.startsWith('magazine_attach') && item.subType !== 'Magazine') {
      return false;
    }

    // Hip slot (wep_sidearm): game-rule-restricted to pistols + medguns.
    // ParaMed variants and the LifeGuard multitool-head all count as "pistol"
    // for the purposes of this slot — you can only have ONE equipped.
    if (portName === 'wep_sidearm') {
      if (item.source === 'weapon') return item.subType === 'Pistol';
      if (item.source === 'gear')   return cat.startsWith('Tool / Medical');
      return false;
    }

    // Utility slots: multi-tools + tractor beams, plus anything flagged
    // RemovableChip (utility chips). Pistols & medguns are explicitly NOT
    // allowed here — they belong on the hip.
    if (portName.startsWith('utility_attach')) {
      if (item.source === 'weapon') return false;
      if (item.source === 'gear') {
        return cat === 'Tool / Multi-Tool' || cat === 'Tool / Tractor Beam';
      }
      return item.attachType === 'RemovableChip';
    }

    return true;
  }

  // Picker state: the slot currently being equipped. Searches both armor
  // slots and nested weapon-attachment slots.
  activeSlot = computed(() => {
    const key = this.pickerSlotKey();
    if (!key) return null;
    return this.allSlots().find(s => s.key === key) ?? null;
  });

  pickerOptions = computed<Equippable[]>(() => {
    const slot = this.activeSlot();
    if (!slot) return [];
    const q = this.pickerSearch().toLowerCase().trim();
    let list = this.catalog().filter(it => this.portAccepts(slot.port, it));
    if (q) list = list.filter(it =>
      it.name.toLowerCase().includes(q) ||
      it.manufacturer.toLowerCase().includes(q) ||
      it.className.toLowerCase().includes(q)
    );

    // Columnar-table pickers (weapons + attachments) use the user-
    // selected column sort. Everything else keeps the existing
    // source-then-name order.
    if (this.pickerIsColumnarTable()) {
      const key = this.pickerSortKey();
      const dir = this.pickerSortDir() === 'desc' ? -1 : 1;
      return [...list].sort((a, b) => {
        const va = this.columnarSortValue(a, key);
        const vb = this.columnarSortValue(b, key);
        if (typeof va === 'number' && typeof vb === 'number') {
          return (va - vb) * dir;
        }
        return String(va).localeCompare(String(vb)) * dir;
      });
    }
    return list.sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
  });

  /** Extract the sortable value for a given (item, column) pair. Covers
   *  both weapon-picker columns (dps/alpha/rpm/…) and attachment-picker
   *  columns (mod multipliers, optic zoom/ADS/scope). Numeric columns
   *  return 0 when absent; string columns return '' so em-dash rows
   *  don't crash sort. */
  private columnarSortValue(item: Equippable, key: string): number | string {
    // Common across all table pickers.
    if (key === 'name')         return item.name;
    if (key === 'manufacturer') return item.manufacturer;
    if (key === 'size')         return item.size;
    if (key === 'mass')         return item.mass ?? 0;

    // Weapon-specific.
    if (this.pickerIsWeapon()) {
      const w = this.weaponForItem(item);
      if (!w) return key === 'type' ? '' : 0;
      if (key === 'type')            return w.type ?? '';
      if (key === 'dps')             return w.dps ?? 0;
      if (key === 'alphaDamage')     return w.alphaDamage ?? 0;
      if (key === 'fireRate')        return w.fireRate ?? 0;
      if (key === 'range')           return w.range ?? 0;
      if (key === 'projectileSpeed') return w.projectileSpeed ?? 0;
      if (key === 'magazineSize')    return w.magazineSize ?? 0;
      return 0;
    }

    // Optic-specific.
    if (this.pickerIsOptics()) {
      const s = item.opticSpec;
      if (key === 'zoomScale')       return s?.zoomScale       ?? 0;
      if (key === 'secondZoomScale') return s?.secondZoomScale ?? 0;
      if (key === 'zoomTimeScale')   return s?.zoomTimeScale   ?? 1;
      if (key === 'scopeType')       return s?.scopeType       ?? '';
    }

    // Barrel / underbarrel-specific: any mod key like
    // 'damageMultiplier' is looked up on item.modifiers. Missing =
    // identity (1 for multiplicative, 0 for additive) — push to sort
    // neutral.
    const mult = item.modifiers?.[key];
    if (mult !== undefined) {
      const ADDITIVE = new Set(['fireRate','pellets','burstShots','ammoCost']);
      return ADDITIVE.has(key) ? mult : mult;  // raw value sorts fine either way
    }
    return key === 'scopeType' || key === 'type' ? '' : 0;
  }

  /** Click a weapon-picker column header to (re-)sort. Same column
   *  toggles direction; different column resets to sensible defaults
   *  — desc for numeric columns (biggest = best at a glance), asc
   *  for string columns (alphabetical). */
  toggleWeaponSort(col: string): void {
    if (this.pickerSortKey() === col) {
      this.pickerSortDir.set(this.pickerSortDir() === 'desc' ? 'asc' : 'desc');
      return;
    }
    this.pickerSortKey.set(col);
    const NUMERIC = new Set([
      'size','mass','dps','alphaDamage','fireRate','range',
      'projectileSpeed','magazineSize',
      'zoomScale','secondZoomScale','zoomTimeScale',
      // Every barrel/underbarrel mod key is numeric — default to desc.
      'damageMultiplier','fireRateMultiplier','projectileSpeedMultiplier',
      'recoil_fireRecoilStrengthMultiplier','recoil_fireRecoilStrengthFirstMultiplier',
      'recoil_randomnessMultiplier','recoil_animatedRecoilMultiplier',
      'recoil_fireRecoilTimeMultiplier','recoil_decayMultiplier',
      'recoil_endDecayMultiplier','recoil_angleRecoilStrengthMultiplier',
      'recoil_randomnessBackPushMultiplier',
      'heatGenerationMultiplier','soundRadiusMultiplier',
      'ammoCostMultiplier','chargeTimeMultiplier',
    ]);
    this.pickerSortDir.set(NUMERIC.has(col) ? 'desc' : 'asc');
  }

  weaponSortIndicator(col: string): string {
    if (this.pickerSortKey() !== col) return '';
    return this.pickerSortDir() === 'desc' ? ' \u25BE' : ' \u25B4';
  }

  /** Barrel picker columns: fixed priority list (label + data key). Only
   *  mods present on at least one filtered option render, so tables
   *  stay tight when a particular barrel family has few mods. */
  private static BARREL_COLS: Array<{ label: string; key: string; title?: string }> = [
    { label: 'DMG',   key: 'damageMultiplier',                         title: 'Damage multiplier' },
    { label: 'RPM',   key: 'fireRateMultiplier',                       title: 'Fire rate multiplier' },
    { label: 'VEL',   key: 'projectileSpeedMultiplier',                title: 'Projectile speed multiplier' },
    { label: 'KICK',  key: 'recoil_fireRecoilStrengthMultiplier',      title: 'Sustained kick multiplier' },
    { label: '1ST',   key: 'recoil_fireRecoilStrengthFirstMultiplier', title: 'First-shot kick multiplier' },
    { label: 'SPRD',  key: 'recoil_randomnessMultiplier',              title: 'Spread multiplier' },
    { label: 'VIS',   key: 'recoil_animatedRecoilMultiplier',          title: 'Visual recoil multiplier' },
    { label: 'TIME',  key: 'recoil_fireRecoilTimeMultiplier',          title: 'Recoil duration multiplier' },
    { label: 'DECAY', key: 'recoil_decayMultiplier',                   title: 'Recoil recovery-rate multiplier' },
    { label: 'HEAT',  key: 'heatGenerationMultiplier',                 title: 'Heat-per-shot multiplier' },
    { label: 'SND',   key: 'soundRadiusMultiplier',                    title: 'Sound-radius multiplier' },
  ];

  /** Prune the barrel column set to only those actually present on the
   *  filtered options. Empty columns otherwise just render em-dashes. */
  barrelColumns = computed<Array<{ label: string; key: string; title?: string }>>(() => {
    if (!this.pickerIsBarrel()) return [];
    const present = new Set<string>();
    for (const it of this.pickerOptions()) {
      if (!it.modifiers) continue;
      for (const k of Object.keys(it.modifiers)) present.add(k);
    }
    return FpsLoadoutComponent.BARREL_COLS.filter(c => present.has(c.key));
  });

  /** Render one (item × mod) cell for the barrel picker. Reuses the
   *  polarity table we already built for pickerModChips. */
  barrelModCell(item: Equippable, key: string): { text: string; positive: boolean; negative: boolean } {
    const v = item.modifiers?.[key];
    if (v === undefined) return { text: '\u2014', positive: false, negative: false };
    const higherBetter = FpsLoadoutComponent.HIGHER_IS_BETTER[key] ?? true;
    const ADDITIVE = new Set(['fireRate','pellets','burstShots','ammoCost']);
    let text: string, delta: number;
    if (ADDITIVE.has(key)) {
      text = (v > 0 ? '+' : '') + v;
      delta = v;
    } else {
      const pct = (v - 1) * 100;
      if (Math.abs(pct) < 0.1) return { text: 'base', positive: false, negative: false };
      text = (pct > 0 ? '+' : '') + pct.toFixed(Math.abs(pct) < 10 ? 1 : 0) + '%';
      delta = pct;
    }
    if (Math.abs(delta) < 1e-6) return { text, positive: false, negative: false };
    const isBetter = higherBetter ? delta > 0 : delta < 0;
    return { text, positive: isBetter, negative: !isBetter };
  }

  /** Optic picker cells (Zoom / Alt Zoom / ADS / Scope). */
  opticCell(item: Equippable, key: 'zoomScale' | 'secondZoomScale' | 'zoomTimeScale' | 'scopeType'):
    { text: string; positive: boolean; negative: boolean; kind?: 'nv' | 'zoom' } {
    const dash = '\u2014';
    const s = item.opticSpec;
    if (!s) return { text: dash, positive: false, negative: false };
    if (key === 'zoomScale') {
      const v = s.zoomScale ?? 0;
      return { text: v > 0 ? `${v}x` : dash, positive: false, negative: false };
    }
    if (key === 'secondZoomScale') {
      const useable = s.scopeType === 'Zoom' && s.secondZoomScale && s.secondZoomScale > 0
        && Math.abs((s.secondZoomScale ?? 0) - (s.zoomScale ?? 0)) > 1e-6;
      return { text: useable ? `${s.secondZoomScale}x` : dash, positive: false, negative: false };
    }
    if (key === 'zoomTimeScale') {
      const v = s.zoomTimeScale;
      if (v == null) return { text: dash, positive: false, negative: false };
      const pct = (v - 1) * 100;
      if (Math.abs(pct) < 0.1) return { text: 'base', positive: false, negative: false };
      // ADS-time polarity — user confirmed + is good, − is bad.
      return {
        text: (pct > 0 ? '+' : '') + pct.toFixed(Math.abs(pct) < 10 ? 1 : 0) + '%',
        positive: pct > 0, negative: pct < 0,
      };
    }
    // scopeType
    if (s.scopeType === 'Nightvision') return { text: 'Nightvision', positive: false, negative: false, kind: 'nv' };
    if (s.scopeType === 'Zoom')        return { text: 'Variable',    positive: false, negative: false, kind: 'zoom' };
    return { text: dash, positive: false, negative: false };
  }

  openPicker(slotKey: string): void {
    this.pickerSlotKey.set(slotKey);
    this.pickerSearch.set('');
  }
  closePicker(): void { this.pickerSlotKey.set(null); }

  equipItem(item: Equippable): void {
    const key = this.pickerSlotKey();
    if (!key) return;
    this.equipped.update(m => ({ ...m, [key]: item.className }));
    this.closePicker();
  }
  unequipSlot(key: string): void {
    this.equipped.update(m => {
      const next = { ...m };
      delete next[key];
      return next;
    });
  }

  itemFor(key: string): Equippable | null {
    const cls = this.equipped()[key];
    if (!cls) return null;
    return this.catalog().find(c => c.className === cls) ?? null;
  }

  // Full equipped item name — sidecar has room for it, and CSS ellipsis
  // handles anything that still overflows.
  equippedLabel(key: string): string | null {
    const it = this.itemFor(key);
    return it?.name ?? null;
  }

  totalLoadoutMass = computed(() => {
    let m = this.totalMass();
    for (const key of Object.keys(this.equipped())) {
      const it = this.itemFor(key);
      if (it) m += it.mass;
    }
    return Math.round(m * 100) / 100;
  });

  // Encumbrance constants.
  // Stamina side — from actorstaminacomponent.playerstamina.xml.
  private static SPRINT_BASE = 0.0768;
  private static RUN_BASE    = 0.06;
  private static COST_PER_KG = 0.005;
  private static USABLE_POOL = 0.85;   // 1.0 (full) − 0.15 (interrupt floor)

  // Velocity side — empirically derived from in-game stopwatch tests
  // (9 runs, fits to within 0.5% of observed). Model:
  //   velocity_mult = (1 - 0.00325 × armor_mass_kg)
  //                   × Π(per-stocked-weapon penalty by size tier)
  // Sidearm-slot weapons incur no penalty; stocked-slot weapons scale by
  // their own Size rating.
  private static BASE_SPRINT_MS = 7.2;   // stand_ready / stand_noweapon sprintSpeed
  private static BASE_RUN_MS    = 5.58;  // runFastSpeed
  private static ARMOR_PER_KG   = 0.00325;

  /** Per-weapon-slot multiplier when the weapon is in a stocked (back-mount) slot. */
  private static stockedSlotPenalty(size: number): number {
    if (size <= 1) return 1.000;        // sidearm-class (free)
    if (size <= 3) return 0.944;        // rifle / sniper / shotgun
    return 0.887;                        // LMG and larger (size 4+)
  }

  // Velocity multiplier from the empirically-validated model.
  velocityMultiplier = computed(() => {
    const armorMass = this.totalMass();   // armor-only mass
    let mult = 1 - FpsLoadoutComponent.ARMOR_PER_KG * armorMass;

    // Each equipped weapon — sidearm-slot items (S1) contribute nothing;
    // stocked-slot items multiply by the size-tier penalty.
    for (const key of Object.keys(this.equipped())) {
      const it = this.itemFor(key);
      if (!it || it.source !== 'weapon') continue;
      // Determine the slot this weapon is in. If the slot's port name starts
      // with "wep_sidearm", no penalty regardless of size.
      const slot = this.slots().find(s => s.key === key);
      const portName = slot?.port.name.toLowerCase() ?? '';
      if (portName.startsWith('wep_sidearm')) continue;
      mult *= FpsLoadoutComponent.stockedSlotPenalty(it.size);
    }
    return Math.max(0.2, mult);   // safety floor so we never go to zero
  });

  effectiveSprintSpeed = computed(() => FpsLoadoutComponent.BASE_SPRINT_MS * this.velocityMultiplier());
  effectiveRunSpeed    = computed(() => FpsLoadoutComponent.BASE_RUN_MS    * this.velocityMultiplier());

  sprintSeconds = computed(() => {
    const w = this.totalLoadoutMass();
    const rate = FpsLoadoutComponent.SPRINT_BASE + FpsLoadoutComponent.COST_PER_KG * w;
    return FpsLoadoutComponent.USABLE_POOL / rate;
  });

  runSeconds = computed(() => {
    const w = this.totalLoadoutMass();
    const rate = FpsLoadoutComponent.RUN_BASE + FpsLoadoutComponent.COST_PER_KG * w;
    return FpsLoadoutComponent.USABLE_POOL / rate;
  });

  // How far a single full-pool sprint actually carries you.
  sprintDistance = computed(() => this.sprintSeconds() * this.effectiveSprintSpeed());

  sprintSecondsBase = computed(() => FpsLoadoutComponent.USABLE_POOL / FpsLoadoutComponent.SPRINT_BASE);

  velocityPct = computed(() => Math.round(this.velocityMultiplier() * 100));
  sprintPct = computed(() => Math.round((this.sprintSeconds() / this.sprintSecondsBase()) * 100));

  /** Heuristic category for colouring the encumbrance readout, based on
      total velocity lost vs baseline. */
  encumbranceLevel = computed<'light' | 'moderate' | 'heavy' | 'overload'>(() => {
    const m = this.velocityMultiplier();
    if (m >= 0.95) return 'light';
    if (m >= 0.85) return 'moderate';
    if (m >= 0.75) return 'heavy';
    return 'overload';
  });

  fmt1(v: number): string { return v.toFixed(1); }
  fmt2(v: number): string { return v.toFixed(2); }

  /** Pick the equipped weapon + its slot key for a given armor-port name. */
  private weaponEntryInPort(portName: string): { weapon: FpsWeaponRaw; slotKey: string } | null {
    for (const s of this.slots()) {
      if (s.port.name !== portName) continue;
      const cls = this.equipped()[s.key];
      if (!cls) continue;
      const w = this.weapons().find(ww => ww.className === cls);
      if (w) return { weapon: w, slotKey: s.key };
    }
    return null;
  }

  primaryEntry   = computed(() => this.weaponEntryInPort('wep_stocked_2'));
  secondaryEntry = computed(() => this.weaponEntryInPort('wep_stocked_3'));
  pistolEntry    = computed(() => this.weaponEntryInPort('wep_sidearm'));

  primaryWeapon   = computed(() => this.primaryEntry()?.weapon   ?? null);
  secondaryWeapon = computed(() => this.secondaryEntry()?.weapon ?? null);
  pistolWeapon    = computed(() => this.pistolEntry()?.weapon    ?? null);

  /** All attachments equipped on a given weapon-slot. */
  private attachmentsForWeaponSlot(weaponSlotKey: string | null): Equippable[] {
    if (!weaponSlotKey) return [];
    const out: Equippable[] = [];
    const prefix = weaponSlotKey + '/';
    for (const [key, cls] of Object.entries(this.equipped())) {
      if (!key.startsWith(prefix)) continue;
      const item = this.catalog().find(c => c.className === cls);
      if (item && item.source === 'attachment') out.push(item);
    }
    return out;
  }

  /** Compute the effective stats the DPS panel reads. This is the hook point
   *  for attachment mods + crafting quality mods — attachment layer is wired;
   *  crafting layer is stubbed for now. */
  effectiveStats(w: FpsWeaponRaw | null, weaponSlotKey?: string | null): EffectiveStats | null {
    if (!w) return null;

    let fireRate = w.fireRate ?? 0;
    let alpha    = w.alphaDamage ?? 0;
    const mag    = w.magazineSize ?? 0;
    let range    = w.range ?? 0;
    let speed    = w.projectileSpeed ?? 0;
    let recoilPitch  = w.recoilPitch  ?? 0;
    let recoilYaw    = w.recoilYaw    ?? 0;
    let recoilSmooth = w.recoilSmooth ?? 0;
    let adsTime      = w.adsTime      ?? 0;
    let adsZoomScale = w.adsZoomScale ?? 0;

    // ─── Attachment modifier composition ─────────────────────────────
    // Each attachment's modifier record is applied multiplicatively onto
    // the base weapon stats. Identity (×1.0) mods were dropped at extract,
    // so only real deltas land here.
    // Relative-only recoil mults seeded at 1.0 — multiplied by attachment
    // mods, never applied to an absolute base (since the weapon doesn't
    // publish one). Surfaced in the DPS card so users see "−40% spread"
    // etc. even when we can't give them a degree/second number.
    let firstShotKickMult = 1;
    let visualRecoilMult  = 1;
    let spreadMult        = 1;
    let recoilTimeMult    = 1;

    const attachments = this.attachmentsForWeaponSlot(weaponSlotKey ?? null);
    for (const att of attachments) {
      const m = att.modifiers ?? {};
      // Weapon-stat mults (absolute base values exist → apply directly)
      const dMul  = m['damageMultiplier'];
      const fMul  = m['fireRateMultiplier'];
      const pMul  = m['projectileSpeedMultiplier'];
      // Recoil mults split into "has base" (pitch/yaw/smooth) and
      // "relative only" (visual, spread, first-shot, time).
      const rStr  = m['recoil_fireRecoilStrengthMultiplier'];
      const rDec  = m['recoil_decayMultiplier'];
      const rFst  = m['recoil_fireRecoilStrengthFirstMultiplier'];
      const rVis  = m['recoil_animatedRecoilMultiplier'];
      const rSpr  = m['recoil_randomnessMultiplier'];
      const rTim  = m['recoil_fireRecoilTimeMultiplier'];
      const frAdd = m['fireRate'];

      if (dMul) alpha    *= dMul;
      if (fMul) fireRate *= fMul;
      if (pMul) { speed *= pMul; range *= pMul; }
      if (rStr) { recoilPitch *= rStr; recoilYaw *= rStr; }
      if (rDec) recoilSmooth *= rDec;
      if (rFst) firstShotKickMult *= rFst;
      if (rVis) visualRecoilMult  *= rVis;
      if (rSpr) spreadMult        *= rSpr;
      if (rTim) recoilTimeMult    *= rTim;
      if (frAdd) fireRate += frAdd;

      // ADS time + zoom scale come from the attachment's opticSpec.
      // zoomTimeScale is a multiplier on the base ADS transition.
      // zoomScale is the optic's magnification — when any attachment
      // provides one, it overrides the iron-sight default. Multiple
      // attachments stack multiplicatively (rare; usually just one
      // optic equipped at a time, but a flashlight + reflex sight
      // combination would compose this way).
      const zts = att.opticSpec?.zoomTimeScale;
      const zs  = att.opticSpec?.zoomScale;
      if (zts && zts !== 1) adsTime      *= zts;
      if (zs  && zs  !== 1) adsZoomScale *= zs;
    }

    // ─── Crafting quality modifiers ──────────────────────────────────
    // Layered AFTER attachments — so a 1.10× fire-rate roll stacks on top of
    // a Tweaker compensator's 1.125× fire rate. Each QualityEffect's property
    // name is matched case-insensitively against known weapon stats.
    let magCrafted = mag;
    if (weaponSlotKey) {
      const effects = this.craftEffects()[weaponSlotKey];
      if (effects) {
        for (const eff of effects) {
          const p = eff.property.toLowerCase();
          const m = eff.combined;
          if (p.includes('fire rate'))                                    fireRate     *= m;
          else if (p.includes('impact force'))                            alpha        *= m;
          else if (p.includes('recoil') && p.includes('kick'))            recoilPitch  *= m;
          else if (p.includes('recoil') && p.includes('handling'))        recoilYaw    *= m;
          else if (p.includes('recoil') && p.includes('smooth'))          recoilSmooth *= m;
        }
      }
    }

    const dps = alpha * fireRate / 60;

    // Tick-quantised "real" DPS — only meaningful for sequence-fired repeaters
    // whose nominal rate doesn't land on the 30 Hz server tick boundary.
    let realDps: number | null = null;
    if (w.sequenceEntries && w.sequenceEntries >= 2 && fireRate > 0) {
      const ticks = Math.ceil(1800 / fireRate);
      const effRPM = 1800 / ticks;
      if (Math.abs(effRPM - fireRate) > 0.1) {
        realDps = alpha * effRPM / 60;
      }
    }

    const dmg = w.damage ?? { physical: 0, energy: 0, distortion: 0, thermal: 0, biochemical: 0, stun: 0 };
    let damageType: string;
    if (dmg.physical > 0 && dmg.energy === 0) damageType = 'Physical';
    else if (dmg.energy > 0 && dmg.physical === 0) damageType = 'Energy';
    else if (dmg.distortion > 0 && dmg.physical === 0 && dmg.energy === 0) damageType = 'Distortion';
    else if (dmg.physical > 0 && dmg.energy > 0) damageType = 'Mixed';
    else damageType = '—';

    return {
      alphaDamage: alpha,
      dps,
      realDps,
      fireRate,
      isCharged: !!w.isCharged,
      magazineSize: magCrafted,
      range,
      projectileSpeed: speed,
      damageType,
      damageBreakdown: dmg,
      recoilPitch,
      recoilYaw,
      recoilSmooth,
      firstShotKickMult,
      visualRecoilMult,
      spreadMult,
      recoilTimeMult,
      magAlpha: alpha * magCrafted,
      mass: w.mass ?? 0,
      adsTime,
      adsZoomScale,
    };
  }

  /** Format a multiplier as a ±% delta, or "—" when identity. */
  fmtMultPct(v: number): string {
    const pct = (v - 1) * 100;
    if (Math.abs(pct) < 0.05) return '\u2014';
    const sign = pct > 0 ? '+' : '';
    return `${sign}${pct.toFixed(Math.abs(pct) < 10 ? 1 : 0)}%`;
  }
  /** Polarity for colouring relative-only recoil mults — lower is better
   *  (less recoil / spread / visual shake). */
  multPolarity(v: number): 'positive' | 'negative' | '' {
    if (Math.abs(v - 1) < 1e-4) return '';
    return v < 1 ? 'positive' : 'negative';
  }

  // ─── Crafting modal state ─────────────────────────────────────────────
  craftModalSlotKey = signal<string | null>(null);

  openCraft(slotKey: string | null): void {
    if (!slotKey) return;
    this.craftModalSlotKey.set(slotKey);
  }
  closeCraft(): void { this.craftModalSlotKey.set(null); }

  /** Fed by QualitySimulatorComponent — stores the live QualityEffect[] per
   *  weapon slot so effectiveStats() can apply them. */
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

  /** Which weapon + which card-label goes with an open craft modal. */
  craftModalTarget = computed(() => {
    const key = this.craftModalSlotKey();
    if (!key) return null;
    for (const entry of [this.primaryEntry(), this.secondaryEntry(), this.pistolEntry()]) {
      if (entry?.slotKey === key) {
        const label =
          entry === this.primaryEntry()   ? 'Primary'   :
          entry === this.secondaryEntry() ? 'Secondary' : 'Pistol';
        return { slotKey: key, label, weapon: entry.weapon };
      }
    }
    return null;
  });

  /** The crafting recipe matching a weapon's className, if any. */
  recipeForWeapon(w: FpsWeaponRaw | null): CraftingRecipe | null {
    if (!w) return null;
    const rs = this.recipes();
    return rs.find(r => r.className === w.className) ?? null;
  }

  /** BaseStats map for the quality simulator's before→after preview. */
  baseStatsForWeapon(w: FpsWeaponRaw | null): BaseStats {
    if (!w) return {};
    return {
      'fire rate':       w.fireRate ?? null,
      'impact force':    w.alphaDamage ?? null,
      'alpha':           w.alphaDamage ?? null,
      'recoil kick':     w.recoilPitch ?? null,
      'recoilpitch':     w.recoilPitch ?? null,
      'recoil handling': w.recoilYaw ?? null,
      'recoilyaw':       w.recoilYaw ?? null,
      'recoil smooth':   w.recoilSmooth ?? null,
      'recoilsmooth':    w.recoilSmooth ?? null,
    };
  }

  /** Has the player actually rolled any non-identity quality on this slot? */
  isCrafted(slotKey: string | null | undefined): boolean {
    if (!slotKey) return false;
    const effects = this.craftEffects()[slotKey];
    if (!effects) return false;
    return effects.some(e => Math.abs(e.combined - 1.0) > 1e-4);
  }

  primaryStats   = computed(() => this.effectiveStats(this.primaryWeapon(),   this.primaryEntry()?.slotKey   ?? null));
  secondaryStats = computed(() => this.effectiveStats(this.secondaryWeapon(), this.secondaryEntry()?.slotKey ?? null));
  pistolStats    = computed(() => this.effectiveStats(this.pistolWeapon(),    this.pistolEntry()?.slotKey    ?? null));

  dpsCards = computed(() => [
    { key: 'primary',   label: 'Primary',   weapon: this.primaryWeapon(),   stats: this.primaryStats(),   slotKey: this.primaryEntry()?.slotKey   ?? null },
    { key: 'secondary', label: 'Secondary', weapon: this.secondaryWeapon(), stats: this.secondaryStats(), slotKey: this.secondaryEntry()?.slotKey ?? null },
    { key: 'pistol',    label: 'Pistol',    weapon: this.pistolWeapon(),    stats: this.pistolStats(),    slotKey: this.pistolEntry()?.slotKey    ?? null },
  ]);

  fmtRpm(s: EffectiveStats): string {
    if (s.isCharged) return 'Charged';
    if (!s.fireRate) return '—';
    return Math.round(s.fireRate).toLocaleString() + ' RPM';
  }

  // Piece lists filtered to the selected tier.
  piecesFor(slot: string, weight?: WeightTier | 'undersuit'): ArmorPiece[] {
    const w = weight ?? this.tier();
    return this.armor()
      .filter(a => a.slot === slot && a.weight === w)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  cores     = computed(() => this.piecesFor('core', this.tier()));
  arms      = computed(() => this.piecesFor('arms', this.tier()));
  legs      = computed(() => this.piecesFor('legs', this.tier()));
  backpacks = computed(() => this.piecesFor('backpack', this.tier()));
  undersuits= computed(() => this.piecesFor('undersuit', 'undersuit'));

  // Helper — find a piece by className.
  private find(cls: string | null): ArmorPiece | null {
    if (!cls) return null;
    return this.armor().find(a => a.className === cls) ?? null;
  }

  equippedCore      = computed(() => this.find(this.coreClass()));
  equippedArms      = computed(() => this.find(this.armsClass()));
  equippedLegs      = computed(() => this.find(this.legsClass()));
  equippedBackpack  = computed(() => this.find(this.backpackClass()));
  equippedUndersuit = computed(() => this.find(this.undersuitClass()));

  /** Sum of gForceResistance across the five equipped slots. Null when
   *  every equipped piece's gForceResistance is null (i.e. LIVE-mode
   *  data where the field hasn't shipped yet) — the template hides
   *  the summary row in that case. Working hypothesis is straight
   *  additive sum across the outfit; revisit when CIG documents the
   *  scaling factor or sum clamping. */
  totalGForceResistance = computed(() => {
    const pieces: Array<ArmorPiece | null> = [
      this.equippedUndersuit(),
      this.equippedCore(),
      this.equippedArms(),
      this.equippedLegs(),
      this.equippedBackpack(),
    ];
    let sum = 0;
    let anyValue = false;
    for (const p of pieces) {
      const v = p?.gForceResistance;
      if (v != null) { sum += v; anyValue = true; }
    }
    if (!anyValue) return null;
    // Guard against fp drift like 0.1 + 0.2 → 0.30000000000000004.
    return Math.round(sum * 1000) / 1000;
  });

  // Reset choices when tier changes (except undersuit — always full pool).
  setTier(t: WeightTier): void {
    this.tier.set(t);
    this.coreClass.set(null);
    this.armsClass.set(null);
    this.legsClass.set(null);
    this.backpackClass.set(null);
  }

  // Aggregated slot list — what the paper-doll actually draws.
  // Each entry carries its source piece so we can colour-code on the doll
  // and know which armor piece "provides" each port.
  slots = computed(() => {
    const out: Array<{
      source: SourceTag;
      port: Port;
      index: number;            // sibling index (for grenade_1 vs grenade_2)
      x: number;
      y: number;
      anchorLabel: string;
      key: string;
    }> = [];

    const pieces: Array<[SourceTag, ArmorPiece | null]> = [
      ['undersuit', this.equippedUndersuit()],
      ['core',      this.equippedCore()],
      ['legs',      this.equippedLegs()],
      ['arms',      this.equippedArms()],
      ['backpack',  this.equippedBackpack()],
    ];

    // Port-name → true if any equipped piece carries the PLAIN (non-transferable)
    // version of that port. In the SC engine, a port flagged `transferable`
    // on a parent piece is suppressed whenever a child piece provides the
    // same port without the flag. That's why core.wep_stocked_2 disappears
    // when you clip a backpack on (backpack owns the real back-mount), and
    // why the undersuit's mag/medpen/sidearm slots disappear when the core
    // and legs are equipped.
    const plainOwners = new Set<string>();
    for (const [, piece] of pieces) {
      if (!piece) continue;
      for (const p of piece.ports) {
        if (!p.flags.split(/\s+/).includes('transferable')) {
          plainOwners.add(p.name);
        }
      }
    }

    // Secondary suppression: outer-layer armor replaces the undersuit's base
    // slots regardless of flag. A handful of undersuits (Ace Interceptor,
    // Inmate Worksuit, racing flight suits) ship utility_attach_2 as PLAIN
    // in the game data instead of `transferable`, which would otherwise
    // render a duplicate UTIL 2 slot when legs are equipped. Treat any
    // port name shared with an outer piece as belonging to the outer piece.
    const outerPortNames = new Set<string>();
    for (const [source, piece] of pieces) {
      if (source === 'undersuit' || !piece) continue;
      for (const p of piece.ports) outerPortNames.add(p.name);
    }

    // Track how many of each port family we've seen so sibling ports get
    // distinct anchor positions.
    const familyCount = new Map<string, number>();

    for (const [source, piece] of pieces) {
      if (!piece) continue;
      for (const p of piece.ports) {
        // Armor-layer structural ports aren't player-facing slots.
        // `backpack` is the core's docking point for a backpack armor piece
        // — already owned by the left-panel dropdown, so don't re-expose it
        // as a sidecar. Nothing else (mines, mining gadgets) fits this port.
        const nLow = p.name.toLowerCase();
        if (nLow.startsWith('armor_') || nLow.includes('helmethook') || nLow.includes('necksock') || nLow === 'backpack') {
          continue;
        }

        // Transferable + a plain owner exists elsewhere → suppress this copy.
        const flagList = p.flags.split(/\s+/);
        if (flagList.includes('transferable') && plainOwners.has(p.name)) {
          continue;
        }
        // Undersuit port also provided by an outer layer → outer wins.
        if (source === 'undersuit' && outerPortNames.has(p.name)) {
          continue;
        }

        const family = p.name.replace(/_\d+$/, '');
        const idx = familyCount.get(family) ?? 0;
        familyCount.set(family, idx + 1);

        const a = anchorFor(p.name, idx);
        if (a.x < 0) continue;   // sentinel "hide"

        out.push({
          source,
          port: p,
          index: idx,
          x: a.x,
          y: a.y,
          anchorLabel: a.label,
          key: `${source}-${p.name}-${idx}`,
        });
      }
    }
    return out;
  });

  // Nested slots — weapon attachment ports surface when a weapon is equipped
  // in an armor slot. Each becomes a child sidecar row.
  weaponSlots = computed(() => {
    const out: Array<{
      key: string;
      parentKey: string;
      parentWeaponName: string;
      port: Port & { attachSlot?: string; requiredPortTags?: string[] };
      source: SourceTag;
      index: number;
      x: number;         // sentinel off-screen — nested slots don't render on the doll
      y: number;
      anchorLabel: string;
    }> = [];

    for (const s of this.slots()) {
      const it = this.itemFor(s.key);
      if (!it || it.source !== 'weapon') continue;
      const ports = it.ports ?? [];
      for (let i = 0; i < ports.length; i++) {
        const wp = ports[i];
        // Project WeaponPort into a Port-shape for picker reuse.
        const proj: any = {
          name: wp.name,
          displayName: wp.name,
          minSize: wp.minSize,
          maxSize: wp.maxSize,
          types: ['WeaponAttachment'],
          flags: '',
          selectTag: '',
          attachSlot: wp.attachSlot,
          requiredPortTags: wp.requiredPortTags,
        };
        out.push({
          key: `${s.key}/${wp.name}`,
          parentKey: s.key,
          parentWeaponName: it.name,
          port: proj,
          source: s.source,
          index: i,
          x: -100, y: -100,
          anchorLabel: wp.attachSlot.toUpperCase(),
        });
      }
    }
    return out;
  });

  // All slots — armor + nested. Used by activeSlot lookup and pickerOptions.
  allSlots = computed(() => [
    ...this.slots(),
    ...this.weaponSlots(),
  ]);

  // Every armor slot still renders on the doll as a navigation chip.
  dollSlots = computed(() => this.slots());

  // Sidecar groups keyed by port-name family. Each group is one panel in the
  // right column. Empty groups are dropped.
  slotGroups = computed(() => {
    type Slot = ReturnType<typeof this.slots>[number];
    const weapons:  Slot[] = [];
    const mags:     Slot[] = [];
    const grenades: Slot[] = [];
    const medpens:  Slot[] = [];
    const oxypens:  Slot[] = [];
    const utility:  Slot[] = [];
    const gadgets:  Slot[] = [];
    const backpack: Slot[] = [];
    const other:    Slot[] = [];

    for (const s of this.slots()) {
      const n = s.port.name.toLowerCase();
      if      (n.startsWith('wep_'))      weapons.push(s);
      else if (n.startsWith('magazine_')) mags.push(s);
      else if (n.startsWith('grenade_'))  grenades.push(s);
      else if (n.startsWith('medpen_'))   medpens.push(s);
      else if (n.startsWith('oxypen_'))   oxypens.push(s);
      else if (n.startsWith('utility_'))  utility.push(s);
      else if (n.startsWith('gadget_'))   gadgets.push(s);
      else if (n === 'backpack')          backpack.push(s);
      else                                other.push(s);
    }

    const groups: Array<{ key: string; label: string; slots: any[] }> = [
      { key: 'weapons',  label: 'Weapons',               slots: weapons  },
      { key: 'mags',     label: 'Magazines',             slots: mags     },
      { key: 'grenades', label: 'Grenades / Deployables', slots: grenades },
      { key: 'medpens',  label: 'MedPens',               slots: medpens  },
      { key: 'oxypens',  label: 'OxyPens',               slots: oxypens  },
      { key: 'utility',  label: 'Utility',               slots: utility  },
      { key: 'gadgets',  label: 'Gadgets',               slots: gadgets  },
      { key: 'backpack', label: 'Backpack Slot',         slots: backpack },
      { key: 'other',    label: 'Other',                 slots: other    },
    ];

    // One sidecar per equipped weapon, listing its attachment ports. Placed
    // after the armor groups so they read as "here's the weapon, here are
    // its slots".
    const wsByParent = new Map<string, typeof this.weaponSlots extends () => infer W ? W : never>();
    for (const ws of this.weaponSlots()) {
      const arr = (wsByParent.get(ws.parentKey) ?? []) as any[];
      arr.push(ws);
      wsByParent.set(ws.parentKey, arr as any);
    }
    for (const [, entries] of wsByParent) {
      const first = (entries as any[])[0];
      if (!first) continue;
      groups.push({
        key: 'weapon-' + first.parentKey,
        label: `${first.parentWeaponName} — Attachments`,
        slots: entries as any[],
      });
    }

    return groups.filter(g => g.slots.length > 0);
  });

  // Which slot is currently "focused" by clicking its doll chip. The matching
  // sidecar row gets an outline + scrolls into view.
  focusedSlotKey = signal<string | null>(null);

  focusSlot(key: string): void {
    this.focusedSlotKey.set(key);
    // Defer to next frame so the DOM is up-to-date before scrolling.
    queueMicrotask(() => {
      const el = document.getElementById('slot-row-' + key);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }

  totalMass = computed(() => {
    let m = 0;
    for (const p of [
      this.equippedUndersuit(),
      this.equippedCore(),
      this.equippedArms(),
      this.equippedLegs(),
      this.equippedBackpack(),
    ]) {
      if (p?.mass) m += p.mass;
    }
    return Math.round(m * 100) / 100;
  });

  // Short label shown inside each slot box.
  slotLabel(slot: { port: Port | any; anchorLabel: string; index: number }): string {
    const m = slot.port.name.match(/_(\d+)$/);
    const num = m ? m[1] : '';
    return num ? `${slot.anchorLabel}${num}` : slot.anchorLabel || slot.port.name;
  }

  // ─── Picker stat-preview helpers ─────────────────────────────────────
  // Mirror the logic from fps-items.ts so Barrel / Optics pickers show the
  // same mod polarity + formatting users see in the Items DB.

  private static MOD_CHIP_PRIORITY: Array<[string, string]> = [
    ['damageMultiplier',                         'DMG'],
    ['fireRateMultiplier',                       'RPM'],
    ['fireRate',                                 'RPM'],
    ['projectileSpeedMultiplier',                'VEL'],
    ['recoil_fireRecoilStrengthMultiplier',      'KICK'],
    ['recoil_fireRecoilStrengthFirstMultiplier', '1ST'],
    ['recoil_randomnessMultiplier',              'SPRD'],
    ['recoil_animatedRecoilMultiplier',          'VIS'],
    ['recoil_decayMultiplier',                   'DECAY'],
    ['recoil_fireRecoilTimeMultiplier',          'TIME'],
    ['recoil_endDecayMultiplier',                'END'],
    ['recoil_angleRecoilStrengthMultiplier',     'ANG'],
    ['recoil_randomnessBackPushMultiplier',      'PUSH'],
    ['heatGenerationMultiplier',                 'HEAT'],
    ['soundRadiusMultiplier',                    'SND'],
    ['ammoCostMultiplier',                       'AMMO'],
    ['chargeTimeMultiplier',                     'CHRG'],
    ['damageOverTimeMultiplier',                 'DoT'],
    ['pellets',                                  'PEL'],
    ['burstShots',                               'BRST'],
  ];

  private static HIGHER_IS_BETTER: Record<string, boolean> = {
    damageMultiplier: true, fireRateMultiplier: true, damageOverTimeMultiplier: true,
    projectileSpeedMultiplier: true, fireRate: true, pellets: true, burstShots: true,
    recoil_decayMultiplier: true, recoil_endDecayMultiplier: true,
    ammoCostMultiplier: false, heatGenerationMultiplier: false,
    soundRadiusMultiplier: false, chargeTimeMultiplier: false, ammoCost: false,
    recoil_fireRecoilTimeMultiplier: false, recoil_fireRecoilStrengthFirstMultiplier: false,
    recoil_fireRecoilStrengthMultiplier: false, recoil_angleRecoilStrengthMultiplier: false,
    recoil_randomnessMultiplier: false, recoil_randomnessBackPushMultiplier: false,
    recoil_animatedRecoilMultiplier: false,
  };

  /** True when the picker is currently open for a barrel-attach slot. */
  pickerIsBarrel = computed(() => (this.activeSlot()?.port as any)?.attachSlot === 'barrel');
  pickerIsOptics = computed(() => (this.activeSlot()?.port as any)?.attachSlot === 'optics');

  /** True when the picker is open for an armor-side weapon mount —
   *  stocked back slots (wep_stocked_*) or the sidearm hip slot. Used
   *  to swap the line-of-data rows for the columnar ship-style picker
   *  so weapon comparisons surface DPS/alpha/RPM side-by-side. */
  pickerIsWeapon = computed(() => {
    const n = this.activeSlot()?.port?.name?.toLowerCase() ?? '';
    return n.startsWith('wep_stocked_') || n === 'wep_sidearm';
  });

  /** Any "columnar table" picker — weapon + attachment pickers all
   *  render a sortable stat table, so the modal widens + layout flips
   *  away from the card style. */
  pickerIsColumnarTable = computed(() =>
    this.pickerIsWeapon() || this.pickerIsBarrel() || this.pickerIsOptics() || this.pickerIsUnderbarrel()
  );

  pickerIsUnderbarrel = computed(() => (this.activeSlot()?.port as any)?.attachSlot === 'underbarrel');

  /** Resolve an Equippable (catalog entry — trimmed fields) to its full
   *  FpsWeaponRaw record so the columnar picker can read fire rate,
   *  alpha, projectile speed, mag size, etc. without the catalog
   *  builder having to thread every weapon field through Equippable. */
  weaponForItem(item: Equippable): FpsWeaponRaw | null {
    if (item.source !== 'weapon') return null;
    return this.weapons().find(w => w.className === item.className) ?? null;
  }

  /** Short classification label for the Type column in the weapon
   *  picker. Falls back to `type`/`subType` as-is when we don't have
   *  a specific shortening rule. */
  fpsWeaponTypeLabel(w: FpsWeaponRaw): string {
    const t = (w.type || '').trim();
    if (!t) return w.subType ?? '—';
    return t;
  }

  /** Pre-format every cell for one row of the weapon picker table. Done
   *  in TS so the template stays readable and we don't wrestle Angular
   *  strict-template null-narrowing through a dozen `?` operators. */
  weaponPickerRow(item: Equippable, w: FpsWeaponRaw | null): {
    type: string; dps: string; alpha: string; rpm: string;
    range: string; vel: string; mag: string; mass: string;
  } {
    const dash = '\u2014';
    if (!w) {
      const mass = item.mass ? this.fmt1(item.mass) + ' kg' : dash;
      return { type: dash, dps: dash, alpha: dash, rpm: dash,
               range: dash, vel: dash, mag: dash, mass };
    }
    return {
      type:  this.fpsWeaponTypeLabel(w),
      dps:   w.dps          ? this.fmt1(w.dps)         : dash,
      alpha: w.alphaDamage  ? this.fmt1(w.alphaDamage) : dash,
      rpm:   w.fireRate     ? w.fireRate + ' rpm'      : dash,
      range: w.range        ? w.range + ' m'           : dash,
      vel:   w.projectileSpeed ? w.projectileSpeed + ' m/s' : dash,
      mag:   w.magazineSize ? String(w.magazineSize)   : dash,
      mass:  item.mass      ? this.fmt1(item.mass) + ' kg' : dash,
    };
  }

  /** Condensed stat chips for the barrel-attachment picker — one per
   *  non-identity modifier, in priority order, with +/− text and polarity. */
  pickerModChips(item: Equippable): Array<{ label: string; text: string; positive: boolean; negative: boolean }> {
    const mods = item.modifiers ?? {};
    const out: Array<{ label: string; text: string; positive: boolean; negative: boolean }> = [];
    const ADDITIVE = new Set(['fireRate', 'pellets', 'burstShots', 'ammoCost']);
    for (const [key, label] of FpsLoadoutComponent.MOD_CHIP_PRIORITY) {
      const v = mods[key];
      if (v === undefined) continue;
      const higherBetter = FpsLoadoutComponent.HIGHER_IS_BETTER[key] ?? true;
      let text: string, delta: number;
      if (ADDITIVE.has(key)) {
        text = (v > 0 ? '+' : '') + v;
        delta = v;
      } else {
        const pct = (v - 1) * 100;
        if (Math.abs(pct) < 0.1) continue;   // drop near-identity
        text = (pct > 0 ? '+' : '') + pct.toFixed(Math.abs(pct) < 10 ? 1 : 0) + '%';
        delta = pct;
      }
      if (Math.abs(delta) < 1e-6) continue;
      const isBetter = higherBetter ? delta > 0 : delta < 0;
      out.push({ label, text, positive: isBetter, negative: !isBetter });
    }
    return out;
  }

  /** Inline zoom / ADS / scope summary for the optics picker. */
  pickerOpticInfo(item: Equippable): Array<{ label: string; text: string; kind?: 'nv' | 'zoom' }> {
    const s = item.opticSpec;
    if (!s) return [];
    const out: Array<{ label: string; text: string; kind?: 'nv' | 'zoom' }> = [];
    if (s.zoomScale && s.zoomScale > 0) out.push({ label: 'ZOOM', text: `${s.zoomScale}x` });
    if (s.scopeType === 'Zoom' && s.secondZoomScale && s.secondZoomScale > 0
        && Math.abs((s.secondZoomScale ?? 0) - (s.zoomScale ?? 0)) > 1e-6) {
      out.push({ label: 'ALT', text: `${s.secondZoomScale}x` });
    }
    if (s.zoomTimeScale != null) {
      const pct = (s.zoomTimeScale - 1) * 100;
      if (Math.abs(pct) >= 0.1) {
        const sign = pct > 0 ? '+' : '';
        out.push({ label: 'ADS', text: `${sign}${pct.toFixed(Math.abs(pct) < 10 ? 1 : 0)}%` });
      }
    }
    if (s.scopeType === 'Nightvision') out.push({ label: 'NV', text: 'LAMP', kind: 'nv' });
    else if (s.scopeType === 'Zoom')   out.push({ label: 'VAR', text: 'Zoom', kind: 'zoom' });
    return out;
  }

  slotTitle(slot: { port: Port | any; source: SourceTag }): string {
    const p: any = slot.port;
    const size = p.minSize === p.maxSize ? `S${p.minSize}` : `S${p.minSize}-${p.maxSize}`;
    if (p.attachSlot) {
      // Weapon attachment port.
      const tagsPart = (p.requiredPortTags && p.requiredPortTags.length)
        ? `  req: ${p.requiredPortTags.join(',')}` : '';
      return `${p.name}  [${size}]  ${p.attachSlot}${tagsPart}`;
    }
    const t = (p.types || []).join(', ') || '—';
    return `${p.name}  [${size}]  types: ${t}  (from ${slot.source})`;
  }
}
