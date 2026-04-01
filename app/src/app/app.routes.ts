import { Routes } from '@angular/router';
import { LoadoutViewComponent } from './components/loadout-view/loadout-view';
import { CompareViewComponent } from './components/compare-view/compare-view';
import { ComponentFinderComponent } from './components/component-finder/component-finder';
import { CartViewComponent } from './components/cart-view/cart-view';
import { MissionsViewComponent } from './components/missions-view/missions-view';
import { BlueprintFinderComponent } from './components/blueprint-finder/blueprint-finder';
import { CraftingViewComponent } from './components/crafting-view/crafting-view';
import { RankingsViewComponent } from './components/rankings-view/rankings-view';
import { ArmorViewComponent } from './components/armor-view/armor-view';
import { SubmitViewComponent } from './components/submit-view/submit-view';
import { FormulasViewComponent } from './components/formulas-view/formulas-view';
import { MiningViewComponent } from './components/mining-view/mining-view';
import { MiningSignaturesComponent } from './components/mining-signatures/mining-signatures';
import { UpdatesViewComponent } from './components/updates-view/updates-view';
import { ChangelogViewComponent } from './components/changelog-view/changelog-view';

export const routes: Routes = [
  { path: 'loadout',            component: LoadoutViewComponent },
  { path: 'compare',            component: CompareViewComponent },
  { path: 'finder',             component: ComponentFinderComponent },
  { path: 'cart',               component: CartViewComponent },
  { path: 'missions',           component: MissionsViewComponent },
  { path: 'blueprints',         component: BlueprintFinderComponent },
  { path: 'crafting',           component: CraftingViewComponent },
  { path: 'rankings',           component: RankingsViewComponent },
  { path: 'armor',              component: ArmorViewComponent },
  { path: 'submit',             component: SubmitViewComponent },
  { path: 'formulas',           component: FormulasViewComponent },
  { path: 'mining',             component: MiningViewComponent },
  { path: 'mining-signatures',  component: MiningSignaturesComponent },
  { path: 'updates',            component: UpdatesViewComponent },
  { path: 'changelog',          component: ChangelogViewComponent },
  { path: '',                    redirectTo: 'loadout', pathMatch: 'full' },
  { path: '**',                  redirectTo: 'loadout' },
];
