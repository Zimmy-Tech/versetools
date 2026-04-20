import { Component, signal, computed, effect, HostListener, ElementRef, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { DecimalPipe } from '@angular/common';
import { Router } from '@angular/router';
import { DataService } from '../../services/data.service';

interface Mission {
  className: string;
  title: string;
  category: string;
  reward: number;
  repReward?: number;
  repPenalty?: number;
  cooldownMin?: number;
  respawnMin?: number;
  repRequirements?: { scope: string; minRank: string; maxRank: string }[];
  repScopes?: string[];
  contractor?: string;
}

interface RepRank {
  name: string;
  minRep: number;
  gated?: boolean;
  perk?: string;
  driftPerHour?: number;
}

interface RepLadder {
  name: string;
  displayName: string;
  ceiling: number;
  ranks: RepRank[];
}

interface MissionData {
  reputationLadders?: Record<string, RepLadder>;
  scopeToLadder?: Record<string, string>;
  contracts: Mission[];
  missions?: Mission[];
}

interface PathStep {
  fromRank: string;
  toRank: string;
  fromMinRep: number;
  toMinRep: number;
  repNeeded: number;
  toRankGated: boolean;
  toRankPerk?: string;
  best: Mission | null;
  bestRepReward: number;
  missionsNeeded: number;
  cumulativeMissions: number;
  alternatives: { mission: Mission; repReward: number }[];
}

@Component({
  selector: 'app-rep-builder',
  standalone: true,
  imports: [DecimalPipe],
  templateUrl: './rep-builder.html',
  styleUrl: './rep-builder.scss',
})
export class RepBuilderComponent {
  private missions = signal<Mission[]>([]);
  private repLadders = signal<Record<string, RepLadder>>({});
  private scopeToLadder = signal<Record<string, string>>({});
  loaded = signal(false);

  /** Selected faction scope (same key space as missions-view.factionFilter). */
  factionScope = signal<string>('');
  /** Index into `walkableRanks()` where the user starts grinding. Defaults to
   *  the first walkable rank via an effect that fires on faction change. */
  startRankIdx = signal<number>(0);

  factionOpen = signal(false);
  rankOpen = signal(false);

  private host = inject(ElementRef<HTMLElement>);
  private router = inject(Router);

  @HostListener('document:click', ['$event'])
  onDocClick(ev: MouseEvent): void {
    if (this.host.nativeElement.contains(ev.target as Node)) return;
    this.factionOpen.set(false);
    this.rankOpen.set(false);
  }

  /** Friendly labels for machine-style scope keys. Mirrors the map in
   *  missions-view so Rep Builder picks match the Contracts filter wording. */
  private readonly SCOPE_DISPLAY: Record<string, string> = {
    'bounty': 'Bounty Hunting',
    'bounty_bountyhuntersguild': 'Bounty Hunters Guild',
    'courier': 'Courier',
    'emergency': 'Emergency Support',
    'hauling': 'Hauling',
    'hiredmuscle': 'Hired Muscle',
    'racing_shiptimetrial': 'Racing (Ship)',
    'security': 'Security',
    'shipcombat_headhunters': 'Ship Combat (Headhunters)',
    'assassination': 'Assassination',
    'wikelo': 'Barter & Trade',
  };

  private readonly LADDER_HIDDEN = new Set(['affinity', 'npc_reliability', 'npc_fired']);

  fmtScope(scope: string): string {
    return this.SCOPE_DISPLAY[scope] ?? scope;
  }

  constructor(private http: HttpClient, private data: DataService) {
    effect(() => {
      const prefix = this.data.dataPrefix();
      this.data.modeVersion();
      this.loaded.set(false);
      this.http.get<MissionData>(`${prefix}versedb_missions.json`).subscribe(d => {
        this.missions.set(d.contracts ?? d.missions ?? []);
        this.repLadders.set(d.reputationLadders ?? {});
        this.scopeToLadder.set(d.scopeToLadder ?? {});
        this.loaded.set(true);
      });
    });

    // Reset starting rank when faction changes so the dropdown doesn't point
    // at an index outside the new ladder. The default rank is the first
    // non-gated walkable rank — where actually-grindable content begins.
    effect(() => {
      this.factionScope();
      const ranks = this.walkableRanks();
      if (!ranks.length) { this.startRankIdx.set(0); return; }
      const firstUngated = ranks.findIndex(r => !r.gated);
      this.startRankIdx.set(firstUngated >= 0 ? firstUngated : 0);
    }, { allowSignalWrites: true });
  }

  /** Scopes that appear in at least one contract's repRequirements, minus
   *  hidden-ladder scopes. Same source as the Contracts page filter so the
   *  two features stay in lock-step. */
  factionOptions = computed<{ scope: string; label: string }[]>(() => {
    const stl = this.scopeToLadder();
    const seen = new Set<string>();
    for (const m of this.missions()) {
      for (const r of m.repRequirements ?? []) {
        const scope = r.scope;
        if (!scope || scope === '?') continue;
        const ladderKey = stl[scope] ?? stl[scope.toLowerCase()] ?? scope.toLowerCase();
        if (this.LADDER_HIDDEN.has(ladderKey)) continue;
        seen.add(scope);
      }
    }
    return Array.from(seen)
      .map(scope => ({ scope, label: this.fmtScope(scope) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  });

  /** Ladder associated with the selected faction scope. */
  ladder = computed<RepLadder | null>(() => {
    const scope = this.factionScope();
    if (!scope) return null;
    const stl = this.scopeToLadder();
    const key = stl[scope] ?? stl[scope.toLowerCase()] ?? scope.toLowerCase();
    return this.repLadders()[key] ?? null;
  });

  /** Ranks we consider valid starting points — drop the negative-minRep
   *  "Not Eligible" sentinel but keep gated ranks visible so users can see
   *  them as walls on the path. */
  walkableRanks = computed<RepRank[]>(() => {
    return (this.ladder()?.ranks ?? []).filter(r => r.minRep >= 0);
  });

  /** Display string for the current starting rank, used inside the picker. */
  startRankLabel = computed<string>(() => {
    const ranks = this.walkableRanks();
    const idx = this.startRankIdx();
    return ranks[idx]?.name ?? '—';
  });

  /** Core computation: walk the ladder from the chosen starting rank and
   *  pick the best-rep mission for each tier transition. A tier row exists
   *  for every step `i → i+1`, including steps where the target rank is
   *  gated — those break the grind chain and are surfaced as walls in the
   *  UI rather than silently skipped. */
  path = computed<PathStep[]>(() => {
    const ranks = this.walkableRanks();
    const scope = this.factionScope();
    if (!ranks.length || !scope) return [];

    const startIdx = Math.max(0, Math.min(this.startRankIdx(), ranks.length - 1));
    const steps: PathStep[] = [];
    let cumulative = 0;

    // Index helper for checking a rank falls inside a [minRank, maxRank] window.
    const rankIdx = (name: string) => ranks.findIndex(r => r.name === name);

    for (let i = startIdx; i < ranks.length - 1; i++) {
      const from = ranks[i];
      const to = ranks[i + 1];
      const repNeeded = Math.max(0, to.minRep - from.minRep);

      // Eligible = gated on this scope AND the current tier `i` is within the
      // [minRank, maxRank] window declared on the contract. Missions with a
      // null/zero repReward aren't grindable toward a rank and are excluded
      // so the "best" slot doesn't silently pick a 0-rep contract.
      const eligible: { mission: Mission; repReward: number }[] = [];
      for (const m of this.missions()) {
        const rep = m.repReward ?? 0;
        if (rep <= 0) continue;
        let matches = false;
        for (const req of m.repRequirements ?? []) {
          if (req.scope !== scope) continue;
          const minI = rankIdx(req.minRank);
          const maxI = rankIdx(req.maxRank);
          if (minI >= 0 && maxI >= 0 && i >= minI && i <= maxI) {
            matches = true;
            break;
          }
        }
        if (matches) eligible.push({ mission: m, repReward: rep });
      }

      eligible.sort((a, b) => b.repReward - a.repReward);
      const best = eligible[0] ?? null;
      // If the target rank is gated, rep alone won't unlock it — mark the
      // tier count as zero so the cumulative total doesn't mislead.
      const missionsNeeded = (best && !to.gated)
        ? Math.ceil(repNeeded / best.repReward)
        : 0;
      if (!to.gated) cumulative += missionsNeeded;

      steps.push({
        fromRank: from.name,
        toRank: to.name,
        fromMinRep: from.minRep,
        toMinRep: to.minRep,
        repNeeded,
        toRankGated: !!to.gated,
        toRankPerk: to.perk,
        best: best?.mission ?? null,
        bestRepReward: best?.repReward ?? 0,
        missionsNeeded,
        cumulativeMissions: cumulative,
        alternatives: eligible.slice(1, 4),
      });
    }

    return steps;
  });

  /** Roll-up shown in the summary strip at the top. `grindableMissions`
   *  excludes tiers behind a gated wall since rep won't open them. */
  summary = computed<{
    grindableMissions: number;
    tiersClimbed: number;
    gatedWalls: number;
    startRank: string;
    endRank: string;
    totalRepToCap: number;
  }>(() => {
    const steps = this.path();
    const ranks = this.walkableRanks();
    const startRank = ranks[this.startRankIdx()]?.name ?? '—';
    // End rank = last non-gated target we can actually reach via grinding.
    // If the user hits a gated wall partway up, endRank stops there.
    let endRank = startRank;
    let totalRep = 0;
    for (const s of steps) {
      if (s.toRankGated) break;
      endRank = s.toRank;
      totalRep += s.repNeeded;
    }
    return {
      grindableMissions: steps.reduce((a, s) => a + s.missionsNeeded, 0),
      tiersClimbed: steps.filter(s => !s.toRankGated && s.missionsNeeded > 0).length,
      gatedWalls: steps.filter(s => s.toRankGated).length,
      startRank,
      endRank,
      totalRepToCap: totalRep,
    };
  });

  /** Format helpers mirror the Contracts page for visual consistency. */
  fmtRep(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + 'k';
    return n.toLocaleString('en-US');
  }

  toggleFactionDd(ev: Event): void {
    ev.stopPropagation();
    this.rankOpen.set(false);
    this.factionOpen.update(v => !v);
  }
  toggleRankDd(ev: Event): void {
    ev.stopPropagation();
    if (!this.walkableRanks().length) return;
    this.factionOpen.set(false);
    this.rankOpen.update(v => !v);
  }
  pickFaction(scope: string): void {
    this.factionScope.set(scope);
    this.factionOpen.set(false);
  }
  pickStartRank(idx: number): void {
    this.startRankIdx.set(idx);
    this.rankOpen.set(false);
  }

  /** Jump to the Contracts page with faction + tier-rank pre-selected so
   *  the user can see every eligible contract, not just the "best." Uses
   *  the same scope + rank name keys the Contracts filter reads. */
  openMissionsForStep(step: PathStep): void {
    this.router.navigate(['/missions'], {
      queryParams: { faction: this.factionScope(), rank: step.fromRank },
    });
  }

  /** Title used in the picker before a faction is chosen. */
  factionLabel = computed<string>(() => {
    const s = this.factionScope();
    return s ? this.fmtScope(s) : 'Select a faction…';
  });
}
