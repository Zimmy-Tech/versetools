import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { DataService } from '../../../services/data.service';
import { AdminService, ShopPriceRefreshSummary, ShipWikiRefreshSummary } from '../admin.service';

@Component({
  selector: 'app-admin-dashboard',
  standalone: true,
  imports: [RouterLink, FormsModule],
  templateUrl: './admin-dashboard.html',
  styleUrl: './admin-dashboard.scss',
})
export class AdminDashboardComponent {
  private data = inject(DataService);
  private admin = inject(AdminService);

  shipCount = computed(() => this.data.db()?.ships?.length ?? 0);
  itemCount = computed(() => this.data.db()?.items?.length ?? 0);

  // Site config (PTU toggle)
  ptuEnabled = signal(false);
  ptuLabel = signal('');
  configLoading = signal(false);
  configSaving = signal(false);
  configMessage = signal<string | null>(null);
  configError = signal<string | null>(null);

  // Shop price refresh state
  shopRefreshing = signal(false);
  shopRefreshResult = signal<ShopPriceRefreshSummary | null>(null);
  shopRefreshError = signal<string | null>(null);
  showUnmatched = signal(false);

  // Ship wiki refresh state
  wikiRefreshing = signal(false);
  wikiRefreshResult = signal<ShipWikiRefreshSummary | null>(null);
  wikiRefreshError = signal<string | null>(null);

  constructor() {
    this.loadConfig();
  }

  async loadConfig(): Promise<void> {
    this.configLoading.set(true);
    try {
      const cfg = await this.admin.getConfig();
      this.ptuEnabled.set(cfg.ptuEnabled);
      this.ptuLabel.set(cfg.ptuLabel);
    } catch (err: any) {
      this.configError.set(err?.error?.error || err?.message || 'Failed to load config');
    } finally {
      this.configLoading.set(false);
    }
  }

  async saveConfig(): Promise<void> {
    this.configSaving.set(true);
    this.configMessage.set(null);
    this.configError.set(null);
    try {
      const cfg = await this.admin.setConfig({
        ptuEnabled: this.ptuEnabled(),
        ptuLabel: this.ptuLabel(),
      });
      this.ptuEnabled.set(cfg.ptuEnabled);
      this.ptuLabel.set(cfg.ptuLabel);
      this.configMessage.set('Saved. Public site picks this up on next page load.');
      // Update the local data service immediately so the header slider
      // reflects the change without needing a reload.
      this.data.ptuEnabled.set(cfg.ptuEnabled);
      this.data.ptuLabel.set(cfg.ptuLabel);
    } catch (err: any) {
      this.configError.set(err?.error?.error || err?.message || 'Save failed');
    } finally {
      this.configSaving.set(false);
    }
  }

  /** Refresh all source='uex' shop prices from UEX Corp's API. Manual
   *  entries are untouched. The whole operation is transactional on the
   *  backend so a partial failure leaves the table in its prior state. */
  async refreshShopPrices(): Promise<void> {
    this.shopRefreshing.set(true);
    this.shopRefreshError.set(null);
    this.shopRefreshResult.set(null);
    this.showUnmatched.set(false);
    try {
      const summary = await this.admin.refreshShopPrices();
      this.shopRefreshResult.set(summary);
      // Force the public data service to re-fetch so the sidebar/cart
      // immediately reflect the new prices instead of waiting for a reload.
      await this.data.refreshDb();
    } catch (err: any) {
      this.shopRefreshError.set(err?.error?.error || err?.message || 'Refresh failed');
    } finally {
      this.shopRefreshing.set(false);
    }
  }

  /** Refresh ship_wiki_metadata from api.star-citizen.wiki. Replaces the
   *  whole table in one transaction. Mirrors the shop-prices pattern. */
  async refreshShipWiki(): Promise<void> {
    this.wikiRefreshing.set(true);
    this.wikiRefreshError.set(null);
    this.wikiRefreshResult.set(null);
    try {
      const summary = await this.admin.refreshShipWiki();
      this.wikiRefreshResult.set(summary);
      // Force a DB re-fetch so ships in the cache pick up roleFull /
      // careerFull without a page reload — Ship Explorer and any other
      // consumer see the new values immediately.
      await this.data.refreshDb();
    } catch (err: any) {
      this.wikiRefreshError.set(err?.error?.error || err?.message || 'Refresh failed');
    } finally {
      this.wikiRefreshing.set(false);
    }
  }

}
