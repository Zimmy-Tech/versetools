import { Component, effect, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AdminService, type AdminMode } from '../admin.service';
import { DataService } from '../../../services/data.service';

@Component({
  selector: 'app-admin-shell',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './admin-shell.html',
  styleUrl: './admin-shell.scss',
})
export class AdminShellComponent {
  admin = inject(AdminService);
  data = inject(DataService);

  syncing = signal(false);
  syncResult = signal<string | null>(null);
  syncError = signal<string | null>(null);

  pendingSubmissions = signal(0);

  private async refreshPendingCount(): Promise<void> {
    if (!this.admin.isAuthenticated()) return;
    try {
      const n = await this.admin.getPendingSubmissionCount();
      this.pendingSubmissions.set(n);
    } catch {
      // ignore — badge just stays at last known value
    }
  }

  constructor() {
    this.refreshPendingCount();
    // Light polling so the badge updates when new submissions come in.
    // 60s is plenty for an admin panel.
    setInterval(() => this.refreshPendingCount(), 60000);
    // Whenever the admin's mode signal changes, ask the public data
    // service to load the matching dataset so every editor's picker
    // and form reflect the correct mode without any per-component
    // wiring. The two signals stay loosely synchronized while the
    // user is inside the admin shell.
    effect(() => {
      const m = this.admin.mode();
      if (this.data.dataMode() !== m) {
        this.data.switchMode(m);
      }
    });
  }

  setMode(m: AdminMode): void {
    this.admin.setMode(m);
  }

  async runSync(): Promise<void> {
    const ok = window.confirm(
      'Replace ALL PTU data with the current LIVE data?\n\n' +
        'Use this after CIG promotes a PTU build to LIVE and you have ' +
        'imported the new LIVE extraction. This wipes any in-progress ' +
        'PTU edits — they should already match LIVE at this point.\n\n' +
        'Continue?'
    );
    if (!ok) return;
    this.syncing.set(true);
    this.syncResult.set(null);
    this.syncError.set(null);
    try {
      const r = await this.admin.syncPtuFromLive();
      this.syncResult.set(`Synced. Copied ${r.shipsCopied} ships and ${r.itemsCopied} items.`);
      if (this.admin.mode() === 'ptu') {
        await this.data.refreshDb('ptu');
      }
    } catch (err: any) {
      this.syncError.set(err?.error?.error || err?.message || 'Sync failed');
    } finally {
      this.syncing.set(false);
    }
  }
}
