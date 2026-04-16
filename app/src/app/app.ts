import { Component, signal, OnInit, OnDestroy } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router, RouterOutlet } from '@angular/router';
import { SwUpdate } from '@angular/service-worker';
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

  /** Show the "update available" popup. Called directly from the
   *  version.json poll the moment the version string changes. The
   *  reload handler (refresh()) takes care of bypassing any stale SW
   *  cache via activateUpdate() + cache-busting URL param. */
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

    // Poll version.json every 60s. When the version string changes,
    // show the popup directly and also nudge the SW to start fetching
    // the new bundle so it's cached by the time the user clicks "Got
    // it". The reload handler does a cache-busted hard reload either
    // way, so a slightly-behind SW can't land the user on stale assets.
    const checkVersion = () => {
      this.http.get<{ v: string }>(`version.json?t=${Date.now()}`)
        .subscribe({ next: r => {
          if (this.loadedVersion() && r.v !== this.loadedVersion()) {
            if (this.swUpdate.isEnabled) this.swUpdate.checkForUpdate().catch(() => {});
            this.notifyUpdate(r.v);
          }
        }, error: () => {} });
    };
    this.versionCheckInterval = setInterval(checkVersion, 60 * 1000);

    // Also check when the tab regains focus/visibility — users who left
    // the site open in a background tab see the popup as soon as they
    // come back instead of waiting up to a full poll cycle.
    this.onVisibility = () => {
      if (document.visibilityState === 'visible') checkVersion();
    };
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('focus', this.onVisibility);
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
