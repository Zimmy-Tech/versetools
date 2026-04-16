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

  constructor(
    public data: DataService,
    public router: Router,
    private http: HttpClient,
    private swUpdate: SwUpdate,
  ) {}

  private notifyUpdate(newVersion?: string): void {
    if (this.updateAvailable()) return;
    this.updateAvailable.set(true);
    clearInterval(this.versionCheckInterval);
    if (newVersion) localStorage.setItem('versetools_update_acked', newVersion);
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
        const acked = localStorage.getItem('versetools_update_acked');
        if (acked && acked === r.v) localStorage.removeItem('versetools_update_acked');
      }, error: () => {} });

    // Single-path update detection: poll version.json every 10 min.
    // ngsw-config.json caches version.json with a freshness-first strategy
    // (10s network timeout) so the poll sees fresh content in normal
    // network conditions. localStorage ack prevents a re-fire after
    // refresh for the version the user just dismissed.
    //
    // History: the SW-driven VERSION_READY subscription was dropped here
    // because it fires with no ack awareness — it would re-show the popup
    // after a reload if the SW finished caching during/after the refresh.
    // See research_cooling_declared_model.md style notes for the prior
    // dual-path rationale; that variant is retrievable from git history
    // if single-path proves unreliable. Trading up-to-10-min detection
    // latency for zero double-popup complexity.
    this.versionCheckInterval = setInterval(() => {
      this.http.get<{ v: string }>(`version.json?t=${Date.now()}`)
        .subscribe({ next: r => {
          if (this.loadedVersion() && r.v !== this.loadedVersion()) {
            const acked = localStorage.getItem('versetools_update_acked');
            if (acked === r.v) return;
            this.notifyUpdate(r.v);
          }
        }, error: () => {} });
    }, 10 * 60 * 1000);
  }

  ngOnDestroy(): void {
    clearInterval(this.versionCheckInterval);
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
