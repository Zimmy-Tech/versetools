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


  private notifyUpdate(): void {
    if (this.updateAvailable()) return;
    this.updateAvailable.set(true);
    clearInterval(this.versionCheckInterval);
  }

  ngOnInit(): void {
    // Clean up the ?_v= cache-buster left behind by refresh() so it
    // doesn't linger in the URL and trip up any query-param-sensitive
    // code (e.g. header isOnLoadout / isTabActive).
    if (typeof window !== 'undefined' && window.location.search.includes('_v=')) {
      const url = new URL(window.location.href);
      url.searchParams.delete('_v');
      const clean = url.pathname + (url.search || '') + url.hash;
      window.history.replaceState(null, '', clean);
    }

    if (!localStorage.getItem('versetools_welcomed')) {
      this.showWelcome.set(true);
    }
    this.http.get<{ v: string }>('version.json', { headers: { 'Cache-Control': 'no-cache' } })
      .subscribe({ next: r => {
        this.loadedVersion.set(r.v);
      }, error: () => {} });

    // Ask the SW every 60s (and on tab focus) whether a new version
    // exists. checkForUpdate() compares ngsw.json hashes server-side,
    // bypassing any CDN or SW caching of version.json. If it resolves
    // true, show the popup immediately — don't wait for VERSION_READY.
    // The reload handler does activateUpdate() + cache-busted URL to
    // guarantee the user lands on fresh assets.
    const checkForNew = () => {
      if (!this.swUpdate.isEnabled) return;
      this.swUpdate.checkForUpdate()
        .then(hasUpdate => { if (hasUpdate) this.notifyUpdate(); })
        .catch(() => {});
    };
    this.versionCheckInterval = setInterval(checkForNew, 60 * 1000);

    this.onVisibility = () => {
      if (document.visibilityState === 'visible') checkForNew();
    };
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('focus', this.onVisibility);

    // Kick off an immediate check on page load.
    checkForNew();
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
    const tag = Date.now().toString();
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
