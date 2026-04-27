# Shopping Assistant — Commodities Expansion

**Audience:** the Claude Code instance that picks this up later. Read
this end-to-end before touching any code. Written 2026-04-26 in the
session that shipped the initial Shopping Assistant tab + extended the
UEX matcher to FPS items.

> **Status as of 2026-04-26:**
> - Shopping Assistant tab is live at versetools.games/shop. Covers
>   ships, ship components, and FPS items/gear/armor — anything UEX
>   lists in `vehicles_purchases_prices_all` or `items_prices_all`.
> - Commodities (cargo trading: Laranite, Quantanium, Aluminum, fuel,
>   refined goods) are **deferred**. User wants to research how other
>   tools handle commodity volatility before we commit to a design.

---

## Problem Statement

UEX's `commodities_prices_all` endpoint exposes 2,338 records covering
the full Star Citizen cargo economy: 191 distinct commodities priced at
hundreds of terminals, with both buy and sell prices. This is the most
valuable data UEX has that VerseTools doesn't pull.

The obvious build is a "Trade Planner" — buy-low/sell-high route finder
that tells players "buy Laranite at A for X, sell at B for Y, profit per
SCU = Y-X." Most established SC tools (TradeTools, Galactic Logistics,
SC Trade Tools) work this way.

**Why we paused before building:** UEX prices and stock levels are
*volatile* and our static-data architecture (admin-triggered UEX refresh,
served from Postgres + cached in browsers) snapshots them at refresh
time. Players acting on a snapshot that's hours or days old will arrive
at a sell terminal that's overstocked (can't sell) or a buy terminal
that's sold out (can't buy). That's a worse experience than no trade
planner at all — it actively misleads the user.

The user wants to look at how other tools handle this (live polling?
"last updated N minutes ago" warnings? overlays from community-reported
stock levels?) before we commit to an approach.

---

## What we're not doing (and why)

- **Bolting commodities into the Shopping tab as a 16th category chip.**
  Mechanically simple, terrible UX. Commodities are about buy/sell
  *pairs* and route arbitrage, not "where do I buy this." A flat list
  next to medical supplies would mislead players about how to use it.
- **Building a real-time trade planner against the static refresh.**
  See "volatility" above. Without per-page-load freshness or community
  stock signals, the data is too stale to act on.

---

## What UEX offers (gap analysis from 2026-04-26)

Endpoints we **already use:**
- `vehicles_purchases_prices_all` — ship buy prices (~200 records)
- `items_prices_all` — ship components + FPS items (~3500 records)
- `terminals` — location enrichment (system / planet / city / etc.)

Endpoints we **don't use yet,** ordered by potential value:

| Endpoint | Records | Why valuable | Notes |
|---|---|---|---|
| `commodities_prices_all` | 2,338 | The cargo trading economy. Buy + sell at every terminal, container sizes, SCU stock, average prices. | Volatility is the open problem. |
| `fuel_prices_all` | 198 | Quantum Fuel + Hydrogen at terminals. | Same shape as commodities; comes along for free if we build that. |
| `vehicles_rentals_prices_all` | 271 | Ship rental prices. | Useful adjacent to loadout ("try before you buy"). Cheap add — parallel `rentalPrices` array on ships. |
| `vehicles` | 274 | Ship catalog with capability flags (`is_combat`, `is_mining`, etc.). | Could supplement DCB role + ship_wiki. |
| `refineries_capacities` | 20 | Refinery throughput per location. | Niche; feeds the refinery research entry. |
| `vehicles_loaners` | 113 | Loaner mappings. | Partially covered by ship_wiki. |

Endpoints we **explicitly don't need** (already covered by our `terminals`
join or DCB extraction):
- `terminals`, `moons`, `planets`, `cities`, `outposts`, `space_stations`,
  `star_systems`, `orbits`, `poi`, `jump_points`
- `companies` (manufacturer catalog — ours from DCB is richer)
- `categories` (UEX's item taxonomy — ours is richer)

---

## Research questions (do these before designing)

1. **How do existing SC tools handle volatility?** Look at Galactic
   Logistics, SC Trade Tools, UEX's own web UI. Specifically:
   - Do they show "last updated N minutes ago" per-row?
   - Do they let users self-report stock levels to keep data fresh?
   - Do they live-poll UEX on each search vs caching like we would?
   - How do they handle the "drove to sell, terminal overstocked"
     failure case in their UI?

2. **What's UEX's API rate limit and freshness cadence?** Their
   `date_modified` field on commodity records is the signal. If most
   records are <30 minutes old, even a hourly admin refresh is
   reasonable. If they're days old, the volatility problem is
   actually a UEX-side problem and our refresh cadence doesn't matter.

3. **Do we want to introduce live API calls from the frontend?**
   Today the frontend reads our snapshot. A trade planner could
   selectively re-fetch from UEX directly per route query. That's a
   different architecture (CORS, rate limits, error handling) from
   anything we do today.

4. **What about user-submitted stock signals?** We already have a
   community submission flow for accel data. Same pattern could feed
   "Lorville is sold out right now" reports. Probably overkill for
   v1, but a known fallback if UEX freshness alone isn't good enough.

---

## If we decide to build it (provisional plan)

Don't start without answering the research questions above. But if and
when we proceed:

### Schema
- New table `commodity_prices` (parallel to `shop_prices`, not a reuse).
  `shop_prices` doesn't track stock levels, container sizes, or
  buy/sell averages — those are commodity-specific.
- Columns: `id`, `commodity_name`, `terminal_id`, `terminal_name`,
  location chain (system/planet/etc.), `price_buy`, `price_sell`,
  `price_buy_avg`, `price_sell_avg`, `scu_buy`, `scu_sell`,
  `scu_sell_stock`, `container_sizes`, `status_buy`, `status_sell`,
  `date_modified` (from UEX), `refreshed_at` (our refresh time),
  `source`.

### Backend
- `api/uex.js`: add `fetchUexCommodityPrices()` + a new `matchUexCommodities()`
  function (no name-matching against our DB needed — commodity_name is
  the primary key directly).
- `api/db.js`: extend `refreshUexShopPrices` to also pull commodities,
  OR (better) add a separate `refreshUexCommodityPrices` function so
  the cadences can differ (commodities likely want hourly; gear is
  fine weekly).

### Frontend
- New tab "Trade" or "Cargo" — explicitly NOT under Shopping.
- Two-column layout: "Buy at" (left) + "Sell at" (right). Each row
  is one route with profit per SCU computed.
- Filters: source system, dest system, max cargo SCU, min profit/SCU.
- Per-row "last updated" timestamp (UEX `date_modified`), color-coded
  to highlight stale data (green <1h, yellow <6h, red >6h).
- Possibly a "I just sold there, mark stock low" community signal
  button that posts to our submissions API.

### What NOT to do
- Don't reuse `shop_prices` table.
- Don't put commodities under the Shopping tab.
- Don't ship without a freshness indicator. The volatility is a UX
  problem, not just a data problem.

---

## Decision log

| Date | Decision | By |
|---|---|---|
| 2026-04-26 | Defer commodities expansion until research phase complete. Static-data volatility is the unresolved blocker. | Bryan |
| 2026-04-26 | If/when built, commodities go in their own tab, not as a Shopping category. | Bryan |
| 2026-04-26 | Drop the proposed scheduled-agent integrity check. Manual eyeball monitoring is fine. | Bryan |
