import { Component, signal, OnInit, OnDestroy } from '@angular/core';
import { HttpClient } from '@angular/common/http';
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
import { BlueprintFinderComponent } from './components/blueprint-finder/blueprint-finder';
import { UpdatesViewComponent } from './components/updates-view/updates-view';

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
    BlueprintFinderComponent,
    UpdatesViewComponent,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit, OnDestroy {
  activeTab = signal<TabName>('loadout');
  updateAvailable = signal(false);
  showWelcome = signal(false);

  private versionCheckInterval: any;
  private loadedVersion = '';

  constructor(public data: DataService, private http: HttpClient) {}

  ngOnInit(): void {
    // Show welcome popup on first visit
    if (!localStorage.getItem('versetools_welcomed')) {
      this.showWelcome.set(true);
    }
    // Fetch initial version (use data file's ETag/Last-Modified as version proxy)
    this.http.get<{ v: string }>('version.json', { headers: { 'Cache-Control': 'no-cache' } })
      .subscribe({ next: r => this.loadedVersion = r.v, error: () => {} });

    // Poll every 5 minutes
    this.versionCheckInterval = setInterval(() => {
      this.http.get<{ v: string }>(`version.json?t=${Date.now()}`)
        .subscribe({ next: r => {
          if (this.loadedVersion && r.v !== this.loadedVersion) {
            this.updateAvailable.set(true);
          }
        }, error: () => {} });
    }, 5 * 60 * 1000);
  }

  ngOnDestroy(): void {
    clearInterval(this.versionCheckInterval);
  }

  dismissWelcome(): void {
    localStorage.setItem('versetools_welcomed', '1');
    this.showWelcome.set(false);
  }

  refresh(): void {
    window.location.reload();
  }
}
