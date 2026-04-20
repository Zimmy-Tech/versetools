import { Routes } from '@angular/router';
import { LoadoutViewComponent } from './components/loadout-view/loadout-view';
import { CompareViewComponent } from './components/compare-view/compare-view';
import { ComponentFinderComponent } from './components/component-finder/component-finder';
import { CartViewComponent } from './components/cart-view/cart-view';
import { MissionsViewComponent } from './components/missions-view/missions-view';
import { RepBuilderComponent } from './components/rep-builder/rep-builder';
import { BlueprintFinderComponent } from './components/blueprint-finder/blueprint-finder';
import { CraftingViewComponent } from './components/crafting-view/crafting-view';
import { RankingsViewComponent } from './components/rankings-view/rankings-view';
import { ArmorViewComponent } from './components/armor-view/armor-view';
import { SubmitViewComponent } from './components/submit-view/submit-view';
import { FormulasViewComponent } from './components/formulas-view/formulas-view';
import { MiningViewComponent } from './components/mining-view/mining-view';
import { MiningSignaturesComponent } from './components/mining-signatures/mining-signatures';
import { CompactViewComponent } from './components/compact-view/compact-view';
import { UpdatesViewComponent } from './components/updates-view/updates-view';
import { ChangelogViewComponent } from './components/changelog-view/changelog-view';
import { ShipCompareComponent } from './components/ship-compare/ship-compare';
import { QtRangeViewComponent } from './components/qt-range-view/qt-range-view';
import { FpsWeaponsComponent } from './components/fps-weapons/fps-weapons';
import { FpsArmorComponent } from './components/fps-armor/fps-armor';
import { FpsTtkComponent } from './components/fps-ttk/fps-ttk';
import { EveStyleComponent } from './components/eve-style/eve-style';
import { AltLayoutComponent } from './components/alt-layout/alt-layout';
import {
  ShipShieldsComponent,
  ShipCoolersComponent,
  ShipWeaponsDbComponent,
  ShipPowerPlantsComponent,
  ShipQuantumDrivesComponent,
} from './components/ship-items/ship-dbs';
import { ShipExplorerComponent } from './components/ship-items/ship-explorer';
import {
  MiningLasersDbComponent,
  MiningModulesDbComponent,
} from './components/ship-items/mining-dbs';
import { adminGuard } from './components/admin/admin-guard';

export const routes: Routes = [
  { path: 'loadout',            component: LoadoutViewComponent },
  { path: 'ship-compare',       component: ShipCompareComponent },
  { path: 'fps-weapons',        component: FpsWeaponsComponent },
  { path: 'fps-armor',          component: FpsArmorComponent },
  { path: 'fps-ttk',            component: FpsTtkComponent },
  { path: 'compare',            component: CompareViewComponent },
  { path: 'finder',             component: ComponentFinderComponent },
  { path: 'cart',               component: CartViewComponent },
  { path: 'missions',           component: MissionsViewComponent },
  { path: 'rep-builder',        component: RepBuilderComponent },
  { path: 'blueprints',         component: BlueprintFinderComponent },
  { path: 'crafting',           component: CraftingViewComponent },
  { path: 'rankings',           component: RankingsViewComponent },
  { path: 'qt-range',           component: QtRangeViewComponent },
  { path: 'armor',              component: ArmorViewComponent },
  { path: 'ship-shields',       component: ShipShieldsComponent },
  { path: 'ship-coolers',       component: ShipCoolersComponent },
  { path: 'ship-weapons-db',    component: ShipWeaponsDbComponent },
  { path: 'ship-power-plants',  component: ShipPowerPlantsComponent },
  { path: 'ship-quantum-drives',component: ShipQuantumDrivesComponent },
  { path: 'ship-explorer',      component: ShipExplorerComponent },
  { path: 'submit',             component: SubmitViewComponent },
  { path: 'formulas',           component: FormulasViewComponent },
  { path: 'mining',             component: MiningViewComponent },
  { path: 'mining-signatures',  component: MiningSignaturesComponent },
  { path: 'mining-lasers',      component: MiningLasersDbComponent },
  { path: 'mining-modules',     component: MiningModulesDbComponent },
  { path: 'compact',            component: CompactViewComponent },
  { path: 'eve-style',          component: EveStyleComponent },
  { path: 'alt-layout',         component: AltLayoutComponent },
  { path: 'updates',            component: UpdatesViewComponent },
  { path: 'changelog',          component: ChangelogViewComponent },

  // Admin section (auth-gated)
  {
    path: 'admin/login',
    loadComponent: () =>
      import('./components/admin/admin-login/admin-login').then((m) => m.AdminLoginComponent),
  },
  {
    path: 'admin',
    loadComponent: () =>
      import('./components/admin/admin-shell/admin-shell').then((m) => m.AdminShellComponent),
    canActivate: [adminGuard],
    children: [
      {
        path: '',
        loadComponent: () =>
          import('./components/admin/admin-dashboard/admin-dashboard').then(
            (m) => m.AdminDashboardComponent
          ),
      },
      {
        path: 'ship-accel',
        loadComponent: () =>
          import('./components/admin/ship-accel-editor/ship-accel-editor').then(
            (m) => m.ShipAccelEditorComponent
          ),
      },
      {
        path: 'ships',
        loadComponent: () =>
          import('./components/admin/ship-editor/ship-editor').then(
            (m) => m.ShipEditorComponent
          ),
      },
      {
        path: 'hardpoints',
        loadComponent: () =>
          import('./components/admin/hardpoint-editor/hardpoint-editor').then(
            (m) => m.HardpointEditorComponent
          ),
      },
      {
        path: 'items',
        loadComponent: () =>
          import('./components/admin/item-editor/item-editor').then(
            (m) => m.ItemEditorComponent
          ),
      },
      {
        path: 'audit',
        loadComponent: () =>
          import('./components/admin/audit-log/audit-log').then(
            (m) => m.AuditLogComponent
          ),
      },
      {
        path: 'diff',
        loadComponent: () =>
          import('./components/admin/diff-review/diff-review').then(
            (m) => m.DiffReviewComponent
          ),
      },
      {
        path: 'submissions',
        loadComponent: () =>
          import('./components/admin/submissions-review/submissions-review').then(
            (m) => m.SubmissionsReviewComponent
          ),
      },
      {
        path: 'cooling',
        loadComponent: () =>
          import('./components/admin/cooling-observations/cooling-observations').then(
            (m) => m.CoolingObservationsComponent
          ),
      },
    ],
  },

  { path: '',                    redirectTo: 'loadout', pathMatch: 'full' },
  { path: '**',                  redirectTo: 'loadout' },
];
