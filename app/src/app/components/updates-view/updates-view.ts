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
        'Ship Loadout Manager — build and customize loadouts with swappable weapons, shields, power plants, coolers, quantum drives, radars, and life support',
        'Power Bar System — interactive power pip allocation with band-gap mechanics and real-time cooling supply/demand gauge',
        'DPS Panel — burst DPS, sustained DPS, alpha damage, and energy weapon sustained ratio',
        'Weapon Ammo System — energy weapon ammo pool shared proportionally by power draw',
        'Weapon Penetration Data — penetration distance and radius for all weapons, plus proximity detonation for distortion/scatter weapons',
        'Missile Blast Radius — explosion radius for all missiles and torpedoes',
        'Shield Mechanics — primary/reserve model, linear regen scaling, resistance and absorption display',
        'Tool Power — togglable mining laser and salvage head power pips',
        'Flight Performance — SCM/NAV speeds, boost speeds, pitch/yaw/roll with thruster pip scaling',
        'Community-Sourced Acceleration Data — tested and verified acceleration values with contributor attribution',
        'Armor Damage Analysis — weapon vs armor deflect threshold with penetration checks',
        'Weapon Performance Comparison — side-by-side component comparison with radar charts',
        'Default Loadout Finder — search ships by their factory-default component loadouts',
        'Sortable Picker Tables — click any column header to sort in all component pickers',
        'Stored Loadouts — save and load loadouts with peak DPS and alpha damage display',
        'Shopping Cart — add non-stock components for in-game shopping reference',
        'Mining Location Browser — 47 locations across Stanton, Pyro, and Nyx with mineral distributions for ship, ROC, and hand mining',
        'Mining Mineral Properties — instability, resistance, optimal window, explosion multiplier, and cluster factor for 34 minerals',
        'Mining Laser & Module Stats — power scaling, stat modifiers, and module slot management',
        'Crafting Recipe Browser — quality modifier interpolation, dismantle returns calculator, and materials list tally',
        'Crafting Filters — armor set and weapon type quick-filter sidebar',
        'Blueprint Finder — searchable blueprint database with armor set and weapon filters, linked to mission sources',
        'Missions Browser — contract database with filters for category, system, activity, faction, and lawfulness',
        'Mission Details — rewards, cooldowns, reputation requirements, and mission flow',
        'Formulas Reference — 10-section documentation of all calculations used in the app',
        'LIVE/PTU Data Toggle — switch between LIVE and PTU game data when available',
        'Community Data Submission — submit acceleration data and site feedback directly from the app',
        'Ships Needing Data — ships with missing or stale data flagged for community testing',
      ],
    },
  ];
}
