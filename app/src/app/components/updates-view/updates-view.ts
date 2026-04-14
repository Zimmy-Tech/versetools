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
