import { Component, signal, OnInit, OnDestroy } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router, RouterOutlet } from '@angular/router';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter } from 'rxjs/operators';
import { DataService } from './services/data.service';
import { HeaderComponent } from './components/header/header';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    HeaderComponent,
    RouterOutlet,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit, OnDestroy {
  updateAvailable = signal(false);
  showWelcome = signal(false);

  private versionCheckInterval: any;
  private loadedVersion = '';

  constructor(
    public data: DataService,
    public router: Router,
    private http: HttpClient,
    private swUpdate: SwUpdate,
  ) {}

  private notifyUpdate(newVersion?: string): void {
    if (this.updateAvailable()) return;
    // Ignore if we already have this version loaded (SW activating the same
    // version we just reloaded into)
    if (newVersion && this.loadedVersion === newVersion) return;
    // For SW-triggered notifications without a version, verify against current
    // version.json — skip if we're already on the latest
    if (!newVersion) {
      this.http.get<{ v: string }>(`version.json?t=${Date.now()}`)
        .subscribe({ next: r => {
          if (this.loadedVersion && r.v === this.loadedVersion) return;
          const acked = localStorage.getItem('versetools_update_acked');
          if (acked === r.v) return;
          this.updateAvailable.set(true);
          clearInterval(this.versionCheckInterval);
        }, error: () => {} });
      return;
    }
    this.updateAvailable.set(true);
    clearInterval(this.versionCheckInterval);
    localStorage.setItem('versetools_update_acked', newVersion);
  }

  ngOnInit(): void {
    if (!localStorage.getItem('versetools_welcomed')) {
      this.showWelcome.set(true);
    }
    this.http.get<{ v: string }>('version.json', { headers: { 'Cache-Control': 'no-cache' } })
      .subscribe({ next: r => {
        this.loadedVersion = r.v;
        const acked = localStorage.getItem('versetools_update_acked');
        if (acked && acked === r.v) localStorage.removeItem('versetools_update_acked');
      }, error: () => {} });

    this.versionCheckInterval = setInterval(() => {
      this.http.get<{ v: string }>(`version.json?t=${Date.now()}`)
        .subscribe({ next: r => {
          if (this.loadedVersion && r.v !== this.loadedVersion) {
            const acked = localStorage.getItem('versetools_update_acked');
            if (acked === r.v) return;
            this.notifyUpdate(r.v);
          }
        }, error: () => {} });
    }, 5 * 60 * 1000);

    if (this.swUpdate.isEnabled) {
      this.swUpdate.versionUpdates.pipe(
        filter((e): e is VersionReadyEvent => e.type === 'VERSION_READY')
      ).subscribe(() => this.notifyUpdate());
    }
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
