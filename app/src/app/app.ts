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

  private pendingVersion = '';

  /**
   * Show the "update available" popup. Only called from the service worker's
   * VERSION_READY event — which guarantees the new bundle is fully downloaded
   * and cached by the SW. That makes the subsequent reload reliable: the SW
   * can immediately serve the new version without another network round-trip.
   *
   * Previously we also showed the popup from version.json polling, which
   * could fire before the SW had finished fetching the new bundle. Clicking
   * "Got it" then reloaded into the still-cached old version, and users had
   * to Ctrl+Shift+R. That path is removed; polling now only nudges the SW
   * to check for updates.
   */
  private notifyUpdate(newVersion: string): void {
    if (this.updateAvailable()) return;
    if (!newVersion || this.loadedVersion === newVersion) return;
    const acked = localStorage.getItem('versetools_update_acked');
    if (acked === newVersion) return;
    this.pendingVersion = newVersion;
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

    // Poll version.json every 5 minutes. If it changed, nudge the SW to
    // check for a new bundle — we do NOT show the popup from this path,
    // because version.json can flip before the SW has cached the new assets.
    // The popup will appear via VERSION_READY once the SW has the bundle ready.
    this.versionCheckInterval = setInterval(() => {
      this.http.get<{ v: string }>(`version.json?t=${Date.now()}`)
        .subscribe({ next: r => {
          if (this.loadedVersion && r.v !== this.loadedVersion && this.swUpdate.isEnabled) {
            this.swUpdate.checkForUpdate().catch(() => {});
          }
        }, error: () => {} });
    }, 5 * 60 * 1000);

    if (this.swUpdate.isEnabled) {
      this.swUpdate.versionUpdates.pipe(
        filter((e): e is VersionReadyEvent => e.type === 'VERSION_READY')
      ).subscribe(e => {
        const v = (e.latestVersion && (e.latestVersion as any).hash)
          ? (e.latestVersion as any).hash
          : (this.loadedVersion ? this.loadedVersion + '+new' : 'new');
        this.notifyUpdate(v);
      });
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
    // Close the popup immediately so the UI feels responsive even if the
    // SW activation takes a moment or fails.
    this.updateAvailable.set(false);

    // After activateUpdate() resolves, the new SW version is in control and
    // will serve the new bundle on the next fetch. We still append a cache-
    // busting query string to the URL on reload so any browser HTTP cache
    // for index.html is bypassed — the combination guarantees the user
    // lands on the new version without needing Ctrl+Shift+R.
    const tag = this.pendingVersion || Date.now().toString();
    const doReload = () => {
      const url = new URL(window.location.href);
      url.searchParams.set('_v', tag);
      window.location.replace(url.toString());
    };

    if (this.swUpdate.isEnabled) {
      const timer = setTimeout(doReload, 2000);
      this.swUpdate.activateUpdate()
        .catch(() => {})
        .finally(() => { clearTimeout(timer); doReload(); });
    } else {
      doReload();
    }
  }
}
