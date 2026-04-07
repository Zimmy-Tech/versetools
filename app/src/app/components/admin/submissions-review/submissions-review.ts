// Admin: review pending community accel submissions and approve or reject.
// Approving applies the values to the ship in the chosen mode and marks
// the ship as curated. Rejecting just closes the submission with a note.

import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AdminService, type AccelSubmission } from '../admin.service';
import { DataService } from '../../../services/data.service';

@Component({
  selector: 'app-submissions-review',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './submissions-review.html',
  styleUrl: './submissions-review.scss',
})
export class SubmissionsReviewComponent {
  private admin = inject(AdminService);
  private data = inject(DataService);

  status = signal<'pending' | 'approved' | 'rejected' | 'all'>('pending');
  loading = signal(false);
  error = signal<string | null>(null);
  entries = signal<AccelSubmission[]>([]);

  // Per-row state
  busyId = signal<number | null>(null);
  rowMessage = signal<{ id: number; kind: 'success' | 'error'; text: string } | null>(null);
  rejectingId = signal<number | null>(null);
  rejectNote = signal('');

  pendingCount = computed(() =>
    this.entries().filter((e) => e.status === 'pending').length
  );

  constructor() {
    this.refresh();
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const entries = await this.admin.listAccelSubmissions(this.status());
      this.entries.set(entries);
    } catch (err: any) {
      this.error.set(err?.error?.error || err?.message || 'Failed to load');
    } finally {
      this.loading.set(false);
    }
  }

  setStatus(s: 'pending' | 'approved' | 'rejected' | 'all'): void {
    this.status.set(s);
    this.refresh();
  }

  /** Look up the ship's current value for a field, from the loaded data,
   *  so the reviewer can compare the submission to what's already on file. */
  currentValue(submission: AccelSubmission, field: keyof AccelSubmission): number | null {
    const db = this.data.db();
    if (!db) return null;
    const ship = db.ships.find((s) => s.className === submission.ship_class_name);
    if (!ship) return null;
    // Map db column → ship field key
    const map: Record<string, string> = {
      accel_fwd: 'accelFwd',
      accel_ab_fwd: 'accelAbFwd',
      accel_retro: 'accelRetro',
      accel_ab_retro: 'accelAbRetro',
      accel_strafe: 'accelStrafe',
      accel_ab_strafe: 'accelAbStrafe',
      accel_up: 'accelUp',
      accel_ab_up: 'accelAbUp',
      accel_down: 'accelDown',
      accel_ab_down: 'accelAbDown',
    };
    const key = map[field as string];
    if (!key) return null;
    return (ship as any)[key] ?? null;
  }

  /** Returns the ship's display name for a submission. */
  shipDisplayName(submission: AccelSubmission): string {
    if (submission.ship_name) return submission.ship_name;
    const db = this.data.db();
    const ship = db?.ships.find((s) => s.className === submission.ship_class_name);
    return ship?.name || submission.ship_class_name;
  }

  fmt(v: number | null): string {
    if (v === null || v === undefined) return '—';
    return Number(v).toFixed(2);
  }

  diffClass(submitted: number | null, current: number | null): string {
    if (submitted === null || current === null) return '';
    if (Math.abs(submitted - current) < 0.005) return 'same';
    return submitted > current ? 'higher' : 'lower';
  }

  fmtDate(iso: string): string {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  async approve(submission: AccelSubmission): Promise<void> {
    if (this.busyId() !== null) return;
    const ok = window.confirm(
      `Approve this submission?\n\n` +
        `Ship: ${this.shipDisplayName(submission)}\n` +
        `Submitter: ${submission.submitter_name}\n\n` +
        `This will apply the values to LIVE and mark the ship as curated.`
    );
    if (!ok) return;
    this.busyId.set(submission.id);
    this.rowMessage.set(null);
    try {
      await this.admin.approveAccelSubmission(submission.id, 'live');
      this.rowMessage.set({ id: submission.id, kind: 'success', text: 'Approved and applied.' });
      // Refresh the list to drop the now-approved row
      await this.refresh();
      // Refresh the public data so the changed values reflect immediately
      await this.data.refreshDb();
    } catch (err: any) {
      const msg = err?.error?.error || err?.message || 'Approve failed';
      this.rowMessage.set({ id: submission.id, kind: 'error', text: msg });
    } finally {
      this.busyId.set(null);
    }
  }

  startReject(submission: AccelSubmission): void {
    this.rejectingId.set(submission.id);
    this.rejectNote.set('');
  }

  cancelReject(): void {
    this.rejectingId.set(null);
    this.rejectNote.set('');
  }

  async confirmReject(submission: AccelSubmission): Promise<void> {
    if (this.busyId() !== null) return;
    this.busyId.set(submission.id);
    this.rowMessage.set(null);
    try {
      await this.admin.rejectAccelSubmission(submission.id, this.rejectNote().trim() || undefined);
      this.rowMessage.set({ id: submission.id, kind: 'success', text: 'Rejected.' });
      this.rejectingId.set(null);
      this.rejectNote.set('');
      await this.refresh();
    } catch (err: any) {
      const msg = err?.error?.error || err?.message || 'Reject failed';
      this.rowMessage.set({ id: submission.id, kind: 'error', text: msg });
    } finally {
      this.busyId.set(null);
    }
  }
}
