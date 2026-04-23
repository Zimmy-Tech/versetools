import { Component } from '@angular/core';

interface FeatureSection {
  title: string;
  items: string[];
}

interface UpdateEntry {
  version: string;
  date: string;
  highlights: string[];
  features: string[];
  sections?: FeatureSection[];
}

@Component({
  selector: 'app-updates-view',
  standalone: true,
  templateUrl: './updates-view.html',
  styleUrl: './updates-view.scss',
})
export class UpdatesViewComponent {
  readonly updates: UpdateEntry[] = [
    {
      version: '1.1',
      date: '2026-04-23',
      highlights: [
        'FPS Loadout Builder — full character loadout with weapons, armor, attachments, mags, grenades, and crafting-quality simulator',
        'Nyx Mission Pack 2 support — all 294 NMP2 contracts surface via a new opt-in event toggle with per-event checkboxes',
        'Site-wide UI refresh — unified sidecar filters, hanging-tab section headers, 3D panel aesthetic across every data page',
      ],
      features: [],
      sections: [
        { title: 'FPS Loadout Builder (Early Alpha)', items: [
          'Full FPS character loadout: armor (helmet/core/arms/legs/undersuit), primary + secondary weapons, grenades, medical, mining, utility gadgets',
          'Paperdoll view with slot indicators and live tier/quality readouts',
          'Columnar attachment pickers for barrels, optics, underbarrels, and magazines — sortable by DPS / alpha / RPM / range / power',
          'Crafting-quality simulator shared with the ship-component pipeline — interpolates stats based on the crafting tier (T1–T5)',
          'Reset-to-default button and individual slot clearing',
        ]},
        { title: 'Missions & Events', items: [
          'Event Missions toggle — "Include Event Missions" collapsible panel lets you opt specific event scenarios (NMP2, FFFinale, Luminalia, etc.) back into the main results',
          'Per-event checkboxes with "All / None" bulk controls; selected events surface on the active-filters chip bar so you can see and clear inclusions at a glance',
          'Nyx Mission Pack 2 content fully indexed — 23 bombing-run contracts (Headhunters + Foxwell Enforcement), 12 Aves-armor reward missions, 294 total NMP2 contracts',
          'Blueprint Pool grid picker — replaces the pool dropdown with a modal grid where every pool renders as a card showing all its blueprint names; search highlights matching items in green across any pool',
          'Mission dedup fidelity fix — previously-collapsed className variants (29 Shubin station mining-rights, 2 HaulCargo variants) now each have unique rows, restoring ~30 missions of prod coverage',
        ]},
        { title: 'Blueprint Finder Enhancements', items: [
          'Deep-link from mission popout to /missions — "Apply this filter to Contracts" button jumps straight from "what mission drops Aves armor?" to every mission that shares the same reward pool',
          'Shareable pool URLs: /missions?pool=<key> preserves the filter for bookmarking or linking',
        ]},
        { title: 'Ship Tools Refresh', items: [
          'Compare view polished: slot triggers as 3D raised cards with per-slot color accents, recessed-well comparison table, radar chart promoted to raised panel with hanging cyan tab',
          'Rankings view: sidecar filters (Rotation / Acceleration / Ship Size button grids with pressed-in cyan active state), raised-bevel header strip, recessed list container',
          'Flight Profile panel: raised-card radar box, 3D ship pickers with glowing slot-color bars, ship stats cards with slot-color accent + glow text',
          'QT Range: 3D class/grade buttons (Military / Civilian / Stealth / Competition / Industrial), unified column alignment, plain-text class labels',
          'Ship Explorer + component DB pages: sortable columns across every data table site-wide',
        ]},
        { title: 'UI/UX Refresh', items: [
          'Unified sidecar pattern — every data page gains a raised-card filter sidebar with hanging cyan tab (Blueprint Finder, Crafting, Mining, Mining Signatures, Missions, QT Range, FPS Weapons/Armor/Items, Contracts)',
          '3D bevel vocabulary: raised panel cards with inset highlights, recessed-well inputs, pressed-in active states, MFD-style chamfered tab corners',
          'Hanging-tab section headers across Loadout, DPS panel, Mission popout, and every filter sidebar — consistent identity signal for panel titles',
          'Centered data in comparison tables with more readable Exo 2 typography',
          'Terser event pills on mission cards — dropped the "Dormant:" prefix since the toggle handles activation state',
        ]},
        { title: 'Data Pipeline & Changelog', items: [
          'FPS + Missions DB promotion — fps_items, fps_gear, fps_armor, and missions tables with atomic diff/import through the admin review UI',
          'className dedup in the missions extractor — colliding keys get a stable per-variant hash suffix so the (class_name, mode) PK stops dropping variants',
          'New merged-vs-previous-merged changelog — one script covers every stream (ships / items / FPS triplet / missions / missionRefs / meta). Captures same-version reships (like the 4.7.2 NMP2 activation) that the old version-gated flow silently skipped',
          'Changelog is hand-editable static JSON — existing entries survive across runs, prune manually when it gets long',
        ]},
        { title: 'FPS Weapons & Gear', items: [
          'Universal sortable DB tables — click any column header to sort ascending/descending on Weapons, Gear, Armor, and Items pages',
          'FPS Items DB: dropped the broken Categories dropdown in favor of per-tab browsing; Melee/Throwable tab combines both; Mining tab surfaces hand-carried gadgets (Stalwart, BoreMax, WaveShift, Sabir, etc.)',
          'Curated alpha damage values for Fresnel, Parallax, and Quartz beam weapons while the beam-DPS extractor fix is parked post-4.8',
          'Recoil column additions + StarBreaker inline XML extractor compatibility',
        ]},
        { title: 'Other', items: [
          'Build version bumped to 4.7.2-live.11674325 to match the launcher display after CIG live-ops activated NMP2 server-side',
          'Rep Builder deep-links into Missions with faction + rank filters pre-applied',
          'Mobile-friendly event toggles and grid pickers — single-column layout at narrow viewports',
        ]},
      ],
    },
    {
      version: '1.0',
      date: '2026-03-27',
      highlights: [
        'Initial public release of VerseTools',
      ],
      features: [],
      sections: [
        { title: 'Ship Loadout Builder', items: [
          'Full loadout customization with weapons, shields, power plants, coolers, quantum drives, radars, life support, flight controllers, and modules',
          'Interactive power pip allocation with band-gap mechanics and real-time stat updates',
          'Bulk Equip — swap all weapons or missiles across all compatible hardpoints',
          'Stored Loadouts — save, load, and compare custom builds with peak DPS display',
          'Shopping Cart — track non-stock components for in-game purchasing reference',
        ]},
        { title: 'Combat Analysis', items: [
          'DPS Panel — burst DPS, sustained DPS, alpha damage, energy sustained ratio, Real DPS (tick-quantized for sequence weapons)',
          'Shield Resistance & Absorption — ballistic bleedthrough, energy amplification, pip-scaled resistance',
          'Armor Damage Analysis — deflection thresholds, penetration checks, hull damage multipliers, durability modifiers',
          'Weapon Penetration Data — penetration distance, radius, proximity detonation for distortion/scatter',
          'Missile Blast Radius — explosion radius for all missiles and torpedoes',
        ]},
        { title: 'Ship Comparison & Rankings', items: [
          'Side-by-side ship comparison — weapons, shields, components, acceleration, flight performance',
          'Flight Profile Radar — 10-axis chart with fleet average ghost overlay and global percentile normalization',
          'Ship Rankings — sortable tables across all performance categories',
          'Component Finder — search ships by factory-default loadouts',
          'Quantum Travel Range — every ship ranked by maximum Gm range, with class + grade filters that refit each ship with the best Military/Civilian/Stealth/Competition/Industrial drive of the matching size. Fuel rate expressed in SCU per Gm so ranges match in-game values.',
        ]},
        { title: 'FPS Combat', items: [
          'FPS Weapons Database — damage types, fire rates, Real DPS, max range, recoil, magazine sizes',
          'FPS Armor Database — resistance tiers across 6 damage types, weight class breakdown',
          'FPS TTK Calculator — time-to-kill against armor tiers with headshot/bodyshot scenarios',
        ]},
        { title: 'Flight & Signatures', items: [
          'Flight Performance — SCM/NAV/boost speeds, pitch/yaw/roll rates with thruster pip scaling',
          'Community-Sourced Acceleration — tested values with contributor attribution and stale data flags',
          'EM/IR/CS Signature System — power-scaled EM, demand-based IR, cross-section display',
          'Cooling Supply/Demand Gauge — real-time thermal load visualization',
        ]},
        { title: 'Mining & Salvage', items: [
          'Mining Location Browser — 59 locations across Stanton, Pyro, and Nyx with mineral distributions',
          'Mining Mineral Properties — instability, resistance, optimal window, explosion multiplier, cluster factor',
          'Mining Laser & Module Stats — power scaling, modifiers, module slot management',
          'Ore Lookup — click any mineral to see all spawn locations',
        ]},
        { title: 'Missions & Contracts', items: [
          'Contract Database — 1,600+ contracts with reputation rank, cargo grade, and full narrative descriptions',
          'Filters — category, system, activity, contractor, lawfulness, blueprint rewards, mission chains',
          'Reputation Ladders — rank progression with point thresholds across all career tracks',
          'Blueprint Finder — searchable blueprint database linked to mission sources',
        ]},
        { title: 'Crafting', items: [
          'Recipe Browser — quality modifier interpolation, dismantle returns calculator, materials tally',
          'Armor set and weapon type quick-filter sidebar',
        ]},
        { title: 'Other', items: [
          'Hull Parts Tree — structural breakdown with vital/secondary/breakable part categories',
          'LIVE/PTU Data Toggle — switch between LIVE and PTU game data when available',
          'Formulas Reference — documented calculations for all systems used in the app',
          'Community Data Submission — acceleration data and site feedback forms',
        ]},
      ],
    },
  ];
}
