import { Component, signal } from '@angular/core';
import { DataService } from './services/data.service';
import { HeaderComponent, TabName } from './components/header/header';
import { LoadoutViewComponent } from './components/loadout-view/loadout-view';
import { ComponentsViewComponent } from './components/components-view/components-view';
import { CompareViewComponent } from './components/compare-view/compare-view';
import { ComponentFinderComponent } from './components/component-finder/component-finder';
import { CartViewComponent } from './components/cart-view/cart-view';
import { MissionsViewComponent } from './components/missions-view/missions-view';
import { CraftingViewComponent } from './components/crafting-view/crafting-view';
import { ChangelogViewComponent } from './components/changelog-view/changelog-view';
import { RankingsViewComponent } from './components/rankings-view/rankings-view';
import { ArmorViewComponent } from './components/armor-view/armor-view';
import { SubmitViewComponent } from './components/submit-view/submit-view';
import { FormulasViewComponent } from './components/formulas-view/formulas-view';
import { MiningViewComponent } from './components/mining-view/mining-view';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    HeaderComponent,
    LoadoutViewComponent,
    ComponentsViewComponent,
    CompareViewComponent,
    ComponentFinderComponent,
    CartViewComponent,
    MissionsViewComponent,
    CraftingViewComponent,
    ChangelogViewComponent,
    RankingsViewComponent,
    ArmorViewComponent,
    SubmitViewComponent,
    FormulasViewComponent,
    MiningViewComponent,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  activeTab = signal<TabName>('loadout');

  constructor(public data: DataService) {}
}
