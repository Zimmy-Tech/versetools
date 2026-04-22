import { Component, signal, computed, inject, effect } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { DataService } from '../../services/data.service';

interface OpticSpec {
  zoomScale?: number;
  secondZoomScale?: number;
  zoomTimeScale?: number;
  fstopMultiplier?: number;
  adsNearClipPlaneMultiplier?: number;
  hideWeaponInADS?: boolean;
  forceIronSightSetup?: boolean;
  scopeType?: 'Zoom' | 'Nightvision' | 'None' | string;
  scopeDefault?: boolean;
}

interface MeleeSpec {
  bladeSizeCm?: number;
}

interface ThrowableSpec {
  triggerType?: 'Proximity' | 'Laser' | string;
  triggerRadiusM?: number;
  warningRadiusM?: number;
  laserLengthM?: number;
  minRadiusM?: number;
  maxRadiusM?: number;
  soundRadiusM?: number;
  damage?: Partial<Record<'physical'|'energy'|'distortion'|'thermal'|'biochemical'|'stun', number>>;
  alphaDamage?: number;
  fuseSec?: number;
  areaOfEffectM?: number;    // loc-Desc fallback
  damageType?: string;       // loc-Desc fallback
}

interface MiningSpec {
  instabilityPct?: number;    // signed % — lower (more negative) is better
  resistancePct?: number;     // signed % — lower is better (easier to crack)
  clusterFactorPct?: number;  // signed % — higher is better (ore sticks together)
  windowSizePct?: number;     // signed % — higher is better (wider sweet spot)
  windowRatePct?: number;     // signed % — higher is better (faster fill)
}

interface MedGunSpec {
  mSCUPerSec?: number;
  ammoPerMSCU?: number;
  maxDistance?: number;
  maxSensorDistance?: number;
  wearPerSec?: number;
  batteryDrainPerSec?: number;
  autoDosageTargetBDLModifier?: number;
  healingBreakTime?: number;
  healingMode?: string;
  healthSubtype?: string;   // GUID — resolves to actual drug once DCB extraction done
}

/** Known consumable-subtype GUIDs → human labels. Filled in as we identify
 *  them. Anything unmapped shows "Unknown (GUID prefix)" so unique variants
 *  are visible without pretending we know the drug name. */
const HEALTH_SUBTYPE_NAMES: Record<string, string> = {
  '2e3fc0d3-be97-4c57-972e-526872e4bd56': 'Hemozal',    // standard MedPen drug
};

interface FpsItem {
  className: string;
  name: string;
  manufacturer: string;
  attachType: string;
  subType: string;
  size: number;
  mass: number;
  category: string;
  modifiers?: Record<string, number>;   // only on attachments
  opticSpec?: OpticSpec;                // only on optics
  medGunSpec?: MedGunSpec;              // only on items with healing-beam action
  miningSpec?: MiningSpec;              // only on Mining Gadgets
  meleeSpec?: MeleeSpec;                // only on melee knives
  throwableSpec?: ThrowableSpec;        // grenades, mines, deployables
}

type TabKey =
  | 'barrels' | 'optics' | 'underbarrels'
  | 'medical' | 'mining' | 'melee' | 'tools' | 'other';

/** Map a category string (from the gear extractor) onto a display tab. */
function tabForCategory(cat: string): TabKey {
  if (cat === 'Attachment / Barrel')       return 'barrels';
  if (cat === 'Attachment / Optics')       return 'optics';
  if (cat === 'Attachment / Underbarrel')  return 'underbarrels';
  if (cat.startsWith('Consumable / Medical') ||
      cat.startsWith('Consumable / MedPack') ||
      cat.startsWith('Consumable / Oxygen') ||
      cat === 'Tool / Medical')             return 'medical';
  if (cat === 'Mining Gadget')              return 'mining';
  if (cat.startsWith('Melee / ') ||
      cat.startsWith('Throwable / '))       return 'melee';
  if (cat.startsWith('Tool /'))             return 'tools';
  return 'other';
}

/** True when the tab is one of the attachment sub-tabs (drives the dynamic
 *  mod-column rendering; non-attachment tabs still show Attach/Sub Type). */
function isAttachmentTab(t: TabKey): boolean {
  return t === 'barrels' || t === 'optics' || t === 'underbarrels';
}

/** Pretty-printable modifier labels for the Attachments tab. */
const MOD_LABELS: Record<string, string> = {
  damageMultiplier:                           'Damage',
  fireRateMultiplier:                         'Fire Rate',
  damageOverTimeMultiplier:                   'DoT',
  projectileSpeedMultiplier:                  'Projectile Speed',
  ammoCostMultiplier:                         'Ammo Cost',
  heatGenerationMultiplier:                   'Heat',
  soundRadiusMultiplier:                      'Sound Radius',
  chargeTimeMultiplier:                       'Charge Time',
  fireRate:                                   'Fire Rate',
  pellets:                                    'Pellets',
  burstShots:                                 'Burst',
  ammoCost:                                   'Ammo/Shot',
  recoil_decayMultiplier:                     'Recoil Decay',
  recoil_endDecayMultiplier:                  'End Decay',
  recoil_fireRecoilTimeMultiplier:            'Recoil Time',
  recoil_fireRecoilStrengthFirstMultiplier:   '1st-Shot Kick',
  recoil_fireRecoilStrengthMultiplier:        'Sustained Kick',
  recoil_angleRecoilStrengthMultiplier:       'Angle Kick',
  recoil_randomnessMultiplier:                'Spread',
  recoil_randomnessBackPushMultiplier:        'Back-Push Spread',
  recoil_animatedRecoilMultiplier:            'Visual Recoil',
};

/** Per-mod direction: true = higher is better (green on +, red on −),
 *  false = lower is better (red on +, green on −). Explicit so we're not
 *  guessing — the defaults used to fight the user's in-game intuition. */
const HIGHER_IS_BETTER: Record<string, boolean> = {
  damageMultiplier:                           true,
  fireRateMultiplier:                         true,
  damageOverTimeMultiplier:                   true,
  projectileSpeedMultiplier:                  true,
  ammoCostMultiplier:                         false,   // lower ammo use = good
  heatGenerationMultiplier:                   false,   // less heat = good
  soundRadiusMultiplier:                      false,   // quieter = good
  chargeTimeMultiplier:                       false,   // faster charge = good
  fireRate:                                   true,    // additive
  pellets:                                    true,
  burstShots:                                 true,
  ammoCost:                                   false,
  recoil_decayMultiplier:                     true,    // faster recovery rate = good
  recoil_endDecayMultiplier:                  true,
  recoil_fireRecoilTimeMultiplier:            false,   // shorter recoil duration = good
  recoil_fireRecoilStrengthFirstMultiplier:   false,   // less first-shot kick = good
  recoil_fireRecoilStrengthMultiplier:        false,   // less sustained kick = good
  recoil_angleRecoilStrengthMultiplier:       false,
  recoil_randomnessMultiplier:                false,   // less spread = good
  recoil_randomnessBackPushMultiplier:        false,
  recoil_animatedRecoilMultiplier:            false,   // less visual shake = good
};

@Component({
  selector: 'app-fps-items',
  standalone: true,
  templateUrl: './fps-items.html',
  styleUrl: './fps-items.scss',
})
export class FpsItemsComponent {
  items = signal<FpsItem[]>([]);
  loaded = signal(false);

  tab = signal<TabKey>('barrels');
  searchQuery = signal('');
  sortBy = signal<'name' | 'mass' | 'size' | 'category'>('category');
  sortDir = signal<'asc' | 'desc'>('asc');

  /** Counts per tab for the header pills. */
  tabCounts = computed(() => {
    const counts: Record<TabKey, number> = {
      barrels: 0, optics: 0, underbarrels: 0,
      medical: 0, mining: 0, melee: 0, tools: 0, other: 0,
    };
    for (const i of this.items()) counts[tabForCategory(i.category)]++;
    return counts;
  });

  filtered = computed(() => {
    const currentTab = this.tab();
    let list = this.items().filter(i => tabForCategory(i.category) === currentTab);
    const q = this.searchQuery().toLowerCase();
    const sort = this.sortBy();
    const dir = this.sortDir();

    if (q) list = list.filter(i =>
      i.name.toLowerCase().includes(q) ||
      i.manufacturer.toLowerCase().includes(q) ||
      i.className.toLowerCase().includes(q)
    );

    list = [...list].sort((a, b) => {
      if (sort === 'name' || sort === 'category') {
        const av = (a as any)[sort] as string;
        const bv = (b as any)[sort] as string;
        return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      const av = (a as any)[sort] as number;
      const bv = (b as any)[sort] as number;
      return dir === 'asc' ? av - bv : bv - av;
    });
    return list;
  });

  private data = inject(DataService);

  constructor(private http: HttpClient) {
    // Prefer the DB-backed payload when DataService has it — that's the
    // prod path after an admin import. Fall back to the raw JSON files
    // on the preview deployment (GitHub Pages) where no API is reachable,
    // so feature work against the extractor output keeps working
    // without a DB round-trip.
    effect(() => {
      const db = this.data.db();
      const fpsItems = db?.fpsItems as any[] | undefined;
      const fpsGear  = db?.fpsGear  as any[] | undefined;
      // Require non-empty arrays so a freshly-migrated DB with empty
      // FPS tables doesn't strand the user on a blank page — the
      // static-JSON fallback will still run.
      if (fpsItems?.length && fpsGear?.length) {
        this.hydrateFromDb(fpsItems, fpsGear);
      }
    });
    // Kick off the JSON fallback regardless — it's a no-op if DataService
    // wins the race, and it prevents a blank table on the preview host.
    this.loadFromStaticJson();
  }

  private hydrateFromDb(fpsItems: any[], fpsGear: any[]): void {
    const attachItems = this.mapAttachments(fpsItems.filter((x) => x._kind === 'attachment'));
    this.items.set([...this.normalizeGear(fpsGear), ...attachItems]);
    this.loaded.set(true);
  }

  private loadFromStaticJson(): void {
    const gear$ = this.http.get<{ items: FpsItem[] }>('live/versedb_fps_gear.json');
    const fps$  = this.http.get<{ attachments?: any[] }>('live/versedb_fps.json');
    let gearItems: FpsItem[] = [];
    let attachItems: FpsItem[] = [];
    let gearDone = false, fpsDone = false;
    const commit = () => {
      if (!gearDone || !fpsDone) return;
      // Skip if the DB path has already populated us — no need to
      // clobber a potentially curated DB read with raw extract JSON.
      if (this.loaded()) return;
      this.items.set([...gearItems, ...attachItems]);
      this.loaded.set(true);
    };
    gear$.subscribe({
      next: d => { gearItems = this.normalizeGear(d.items ?? []); gearDone = true; commit(); },
      error: () => { gearDone = true; commit(); },
    });
    fps$.subscribe({
      next: d => { attachItems = this.mapAttachments(d.attachments ?? []); fpsDone = true; commit(); },
      error: () => { fpsDone = true; commit(); },
    });
  }

  private normalizeGear(items: any[]): FpsItem[] {
    // Gear records already match FpsItem shape (classname, name, category,
    // medGunSpec, miningSpec, meleeSpec, throwableSpec, …). Pass-through.
    return items as FpsItem[];
  }

  private mapAttachments(raws: any[]): FpsItem[] {
    const slotToCat: Record<string, string> = {
      optics: 'Attachment / Optics',
      barrel: 'Attachment / Barrel',
      underbarrel: 'Attachment / Underbarrel',
      magazine: 'Attachment / Magazine',
    };
    return raws.map((a: any) => ({
      className: a.className,
      name: a.name,
      manufacturer: a.manufacturer,
      attachType: a.attachType,
      subType: a.subType,
      size: a.size,
      mass: a.mass,
      category: slotToCat[a.attachSlot] ?? `Attachment / ${a.attachSlot}`,
      modifiers: a.modifiers,
      opticSpec: a.opticSpec,
    }));
  }

  toggleSort(col: 'name' | 'mass' | 'size' | 'category'): void {
    if (this.sortBy() === col) {
      this.sortDir.set(this.sortDir() === 'desc' ? 'asc' : 'desc');
    } else {
      this.sortBy.set(col);
      this.sortDir.set(col === 'name' || col === 'category' ? 'asc' : 'desc');
    }
  }

  sortIndicator(col: string): string {
    if (this.sortBy() !== col) return '';
    return this.sortDir() === 'desc' ? ' \u25BE' : ' \u25B4';
  }

  fmt(v: number, d = 2): string {
    if (!v) return '\u2014';
    return v.toFixed(d);
  }

  setTab(t: TabKey): void {
    this.tab.set(t);
  }

  /** Columns rendered in the Attachments tab — one per mod key actually
   *  present on at least one filtered attachment. Keeps the table tight
   *  when filtering to (say) just optics (which have no mods at all). */
  modColumns = computed<Array<{ key: string; label: string }>>(() => {
    if (!isAttachmentTab(this.tab())) return [];
    const present = new Set<string>();
    for (const i of this.filtered()) {
      if (!i.modifiers) continue;
      for (const k of Object.keys(i.modifiers)) present.add(k);
    }
    // Preserve the canonical order from MOD_LABELS; unknown keys appended.
    const out: Array<{ key: string; label: string }> = [];
    for (const k of Object.keys(MOD_LABELS)) {
      if (present.has(k)) out.push({ key: k, label: MOD_LABELS[k] });
    }
    for (const k of present) {
      if (!MOD_LABELS[k]) out.push({ key: k, label: k });
    }
    return out;
  });

  /** Format the optic-specific ADS Time cell — 1.15× base shown as "+15%"
   *  (green, higher is better per in-game intuition), 1.0 as "base" grey. */
  opticAdsTimeCell(item: FpsItem): { text: string; positive: boolean; negative: boolean } {
    const v = item.opticSpec?.zoomTimeScale;
    if (v === undefined || v === null) return { text: '\u2014', positive: false, negative: false };
    const pct = (v - 1) * 100;
    if (Math.abs(pct) < 0.1) return { text: 'base', positive: false, negative: false };
    const sign = pct > 0 ? '+' : '';
    return {
      text: `${sign}${pct.toFixed(Math.abs(pct) < 10 ? 1 : 0)}%`,
      positive: pct > 0,   // + = good
      negative: pct < 0,   // − = bad
    };
  }

  /** Resolve a health-subtype GUID to a readable label. Unknown GUIDs
   *  render as the first 8 chars so users can still tell variants apart. */
  medicineName(guid: string | undefined): string {
    if (!guid) return '\u2014';
    return HEALTH_SUBTYPE_NAMES[guid] ?? `Unknown (${guid.slice(0, 8)})`;
  }

  /** Medical tab rows filtered by subsection. */
  pensRows = computed(() =>
    this.filtered().filter(i => i.category.startsWith('Consumable /'))
  );
  medGunsRows = computed(() =>
    this.filtered().filter(i => i.category === 'Tool / Medical')
  );

  /** Melee / Throwable tab: blades vs throwables. */
  meleeBladeRows = computed(() =>
    this.filtered().filter(i => i.category.startsWith('Melee /'))
  );
  throwableRows = computed(() =>
    this.filtered().filter(i => i.category.startsWith('Throwable /'))
  );

  /** Trigger label — "Timer (3 s)" for fuse-based, "Proximity (2.5 m)" or
   *  "Laser (2 m)" for mines. Em-dash when unknown. */
  throwableTriggerLabel(item: FpsItem): string {
    const s = item.throwableSpec;
    if (!s) return '\u2014';
    if (s.triggerType === 'Proximity') {
      return s.triggerRadiusM ? `Proximity · ${s.triggerRadiusM} m` : 'Proximity';
    }
    if (s.triggerType === 'Laser') {
      return s.laserLengthM ? `Laser · ${s.laserLengthM} m` : 'Laser';
    }
    if (s.fuseSec) return 'Timer';
    return '\u2014';
  }

  /** Radius label: "4–5.5 m" when both bounds present, falls back to single
   *  value or loc-Desc AoE for legacy mines. */
  throwableRadius(item: FpsItem): string {
    const s = item.throwableSpec;
    if (!s) return '\u2014';
    const mn = s.minRadiusM, mx = s.maxRadiusM;
    if (mn != null && mx != null && mx > 0) {
      return mn === mx ? `${mx} m` : `${mn}\u2013${mx} m`;
    }
    if (mx != null && mx > 0) return `${mx} m`;
    if (s.areaOfEffectM) return `${s.areaOfEffectM} m`;
    return '\u2014';
  }

  /** Zoom readout: "Nx" — em-dash when absent. */
  opticZoom(item: FpsItem, key: 'zoomScale' | 'secondZoomScale'): string {
    const v = item.opticSpec?.[key];
    if (v === undefined || v === null || v <= 0) return '\u2014';
    return `${v}x`;
  }

  /** True when the optic has a distinct secondary zoom worth showing —
   *  only optics with scopeType="Zoom" can actually toggle to the alt zoom.
   *  Without the scope attachment block, secondZoomScale is inert. */
  hasAltZoom(item: FpsItem): boolean {
    const s = item.opticSpec;
    if (!s || s.scopeType !== 'Zoom') return false;
    const a = s.zoomScale ?? 0;
    const b = s.secondZoomScale ?? 0;
    return b > 0 && Math.abs(a - b) > 1e-6;
  }

  /** Label for the Scope column. Nightvision, Variable Zoom, or — for none. */
  opticScopeLabel(item: FpsItem): { text: string; kind: 'nv' | 'zoom' | 'none' } {
    const t = item.opticSpec?.scopeType;
    if (t === 'Nightvision') return { text: 'Nightvision', kind: 'nv' };
    if (t === 'Zoom')        return { text: 'Variable Zoom', kind: 'zoom' };
    return { text: '\u2014', kind: 'none' };
  }

  /** Direction table for mining-gadget stat columns.
   *  true  = higher is better (green on +, red on −)
   *  false = lower is better  (green on −, red on +) */
  private static MINING_HIGHER_IS_BETTER: Record<string, boolean> = {
    instabilityPct:   false,   // less laser wobble = good
    resistancePct:    false,   // easier to crack = good
    clusterFactorPct: true,    // ore stays together = good
    windowSizePct:    true,    // bigger sweet spot = good
    windowRatePct:    true,    // fills faster = good
  };

  /** Format a mining-gadget modifier cell. Missing → em-dash; identity → '—'. */
  miningCell(item: FpsItem, key: keyof MiningSpec): { text: string; positive: boolean; negative: boolean } {
    const v = item.miningSpec?.[key];
    if (v === undefined || v === null) return { text: '\u2014', positive: false, negative: false };
    if (Math.abs(v) < 0.01) return { text: 'base', positive: false, negative: false };
    const higherIsBetter = FpsItemsComponent.MINING_HIGHER_IS_BETTER[key as string] ?? true;
    const sign = v > 0 ? '+' : '';
    const text = `${sign}${v.toFixed(Math.abs(v) < 10 ? 1 : 0)}%`;
    const isBetter = higherIsBetter ? v > 0 : v < 0;
    return { text, positive: isBetter, negative: !isBetter };
  }

  /** Render one cell for a given (item × mod column). Returns text + polarity
   *  so the template can colour the cell. Missing mod → em-dash. */
  modCell(item: FpsItem, key: string): { text: string; positive: boolean; negative: boolean } {
    const v = item.modifiers?.[key];
    if (v === undefined) return { text: '\u2014', positive: false, negative: false };

    const ADDITIVE = new Set(['fireRate', 'pellets', 'burstShots', 'ammoCost']);
    const higherIsBetter = HIGHER_IS_BETTER[key] ?? true;   // default: + good

    let text: string;
    let delta: number;      // sign of the change: + = increased, − = decreased
    if (ADDITIVE.has(key)) {
      const sign = v > 0 ? '+' : '';
      text = `${sign}${v}`;
      delta = v;
    } else {
      const pct = (v - 1) * 100;
      const sign = pct > 0 ? '+' : '';
      text = `${sign}${pct.toFixed(Math.abs(pct) < 10 ? 1 : 0)}%`;
      delta = pct;
    }

    if (Math.abs(delta) < 1e-6) {
      return { text, positive: false, negative: false };
    }
    const isBetter = higherIsBetter ? delta > 0 : delta < 0;
    return { text, positive: isBetter, negative: !isBetter };
  }
}
