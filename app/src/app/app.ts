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
  /** Build tag from version.json — hash + ISO timestamp. Exposed for the
   *  build badge so users (and us) can see at a glance which deploy the
   *  browser is currently running. */
  loadedVersion = signal('');

  private versionCheckInterval: any;
  private onVisibility: (() => void) | null = null;

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
    if (!newVersion || this.loadedVersion() === newVersion) return;
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
        this.loadedVersion.set(r.v);
        const acked = localStorage.getItem('versetools_update_acked');
        if (acked && acked === r.v) localStorage.removeItem('versetools_update_acked');
      }, error: () => {} });

    // Poll version.json every 60s. If it changed, nudge the SW to
    // check for a new bundle — we do NOT show the popup from this path,
    // because version.json can flip before the SW has cached the new assets.
    // The popup will appear via VERSION_READY once the SW has the bundle ready.
    const nudgeUpdate = () => {
      this.http.get<{ v: string }>(`version.json?t=${Date.now()}`)
        .subscribe({ next: r => {
          if (this.loadedVersion() && r.v !== this.loadedVersion() && this.swUpdate.isEnabled) {
            this.swUpdate.checkForUpdate().catch(() => {});
          }
        }, error: () => {} });
    };
    this.versionCheckInterval = setInterval(nudgeUpdate, 60 * 1000);

    // Also nudge when the tab regains focus/visibility — users who left
    // the site open in a background tab get an update check as soon as
    // they come back instead of waiting up to a full poll cycle.
    this.onVisibility = () => {
      if (document.visibilityState === 'visible') nudgeUpdate();
    };
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('focus', this.onVisibility);

    if (this.swUpdate.isEnabled) {
      this.swUpdate.versionUpdates.pipe(
        filter((e): e is VersionReadyEvent => e.type === 'VERSION_READY')
      ).subscribe(e => {
        const v = (e.latestVersion && (e.latestVersion as any).hash)
          ? (e.latestVersion as any).hash
          : (this.loadedVersion() ? this.loadedVersion() + '+new' : 'new');
        this.notifyUpdate(v);
      });
      // Kick off an immediate check on load so returning users don't
      // wait for the first 60s tick.
      this.swUpdate.checkForUpdate().catch(() => {});
    }
  }

  ngOnDestroy(): void {
    clearInterval(this.versionCheckInterval);
    if (this.onVisibility) {
      document.removeEventListener('visibilitychange', this.onVisibility);
      window.removeEventListener('focus', this.onVisibility);
    }
  }

  /**
   * Short build tag for the badge — "hash · MM-DD HH:MM" pulled from
   * `version.json` whose format is "HASH-ISO8601". Returns empty until
   * the first load resolves.
   */
  buildTag(): string {
    const v = this.loadedVersion();
    if (!v) return '';
    // "18e2aed-2026-04-09T06:56:19Z" -> ["18e2aed", "2026-04-09T06:56:19Z"]
    const dash = v.indexOf('-');
    if (dash < 0) return v;
    const hash = v.slice(0, dash);
    const iso = v.slice(dash + 1);
    // MM-DD HH:MM
    const m = iso.match(/^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    const when = m ? `${m[1]}-${m[2]} ${m[3]}:${m[4]}` : iso;
    return `${hash} · ${when}`;
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
