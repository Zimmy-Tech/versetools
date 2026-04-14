import { Component } from '@angular/core';

interface UpdateEntry {
  version: string;
  date: string;
  highlights: string[];
  features: string[];
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
      features: [
        // ── Ship Loadout Builder ──
        'Ship Loadout Builder — full loadout customization with weapons, shields, power plants, coolers, quantum drives, radars, life support, flight controllers, and modules',
        'Interactive Power Pip Allocation — band-gap mechanics with real-time stat updates and cooling supply/demand gauge',
        'Bulk Equip — swap all weapons or missiles to a specific model across all compatible hardpoints',
        'Default Loadout Restoration — per-slot component picker with sortable tables',
        'Stored Loadouts — save, load, and compare custom builds with peak DPS display',
        'Shopping Cart — track non-stock components for in-game purchasing reference',

        // ── Combat Analysis ──
        'DPS Panel — burst DPS, sustained DPS, alpha damage, energy weapon sustained ratio, Real DPS (tick-quantized for sequence weapons)',
        'Shield Resistance & Absorption — ballistic bleedthrough, energy amplification, pip-scaled resistance display',
        'Armor Damage Analysis — weapon vs armor deflection thresholds, penetration checks, hull damage multipliers, durability modifiers',
        'Weapon Penetration Data — penetration distance, radius, proximity detonation for distortion/scatter',
        'Missile Blast Radius — explosion radius for all missiles and torpedoes',

        // ── Ship Comparison & Rankings ──
        'Side-by-Side Ship Comparison — weapons, shields, components, acceleration, and flight performance',
        'Flight Profile Radar — 10-axis radar chart with fleet average ghost overlay and global percentile normalization',
        'Ship Rankings — sortable tables across all performance categories',
        'Component Finder — search ships by factory-default loadouts',

        // ── FPS Combat ──
        'FPS Weapons Database — damage types, fire rates, Real DPS, max range, recoil data, magazine sizes',
        'FPS Armor Database — resistance tiers across 6 damage types, weight class breakdown',
        'FPS TTK Calculator — time-to-kill against armor tiers with headshot/bodyshot scenarios',

        // ── Flight & Signatures ──
        'Flight Performance — SCM/NAV/boost speeds, pitch/yaw/roll rates with thruster pip scaling',
        'Community-Sourced Acceleration — tested values with contributor attribution and stale data flags',
        'EM/IR/CS Signature System — power-scaled EM, demand-based IR, cross-section display',

        // ── Mining & Salvage ──
        'Mining Location Browser — 59 locations across Stanton, Pyro, and Nyx with mineral distributions',
        'Mining Mineral Properties — instability, resistance, optimal window, explosion multiplier, cluster factor',
        'Mining Laser & Module Stats — power scaling, modifiers, module slot management',
        'Ore Lookup — click any mineral to see all spawn locations',

        // ── Missions & Contracts ──
        'Contract Database — 1,600+ contracts with reputation rank, cargo grade, and full narrative descriptions',
        'Mission Filters — category, system, activity, contractor, lawfulness, blueprint rewards, mission chains',
        'Reputation Ladders — rank progression with point thresholds across all career tracks',
        'Blueprint Finder — searchable blueprint database linked to mission sources',

        // ── Crafting ──
        'Crafting Recipe Browser — quality modifier interpolation, dismantle returns calculator, materials tally',
        'Crafting Filters — armor set and weapon type quick-filter sidebar',

        // ── Other ──
        'Hull Parts Tree — structural breakdown with vital/secondary/breakable part categories',
        'LIVE/PTU Data Toggle — switch between LIVE and PTU game data when available',
        'Formulas Reference — documented calculations for all systems used in the app',
        'Community Data Submission — acceleration data and site feedback forms',
        'Cooling Supply/Demand Gauge — real-time thermal load visualization',
      ],
    },
  ];
}
