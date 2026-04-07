import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { DataService } from '../../../services/data.service';
import { AdminService } from '../admin.service';

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
  detectingDiff = signal(false);

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

  /** Inspect the changelog and toggle PTU enabled based on whether
   *  PTU and LIVE actually differ. Saves immediately. */
  async detectFromChangelog(): Promise<void> {
    this.detectingDiff.set(true);
    this.configMessage.set(null);
    this.configError.set(null);
    try {
      const hasDiff = await this.admin.hasPtuDifferences();
      this.ptuEnabled.set(hasDiff);
      await this.saveConfig();
      this.configMessage.set(
        hasDiff
          ? 'PTU has differences from LIVE — slider enabled.'
          : 'PTU is identical to LIVE — slider disabled.'
      );
    } catch (err: any) {
      this.configError.set(err?.error?.error || err?.message || 'Detection failed');
    } finally {
      this.detectingDiff.set(false);
    }
  }
}
