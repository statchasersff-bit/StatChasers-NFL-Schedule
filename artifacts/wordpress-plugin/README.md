# StatChasers NFL Schedule — WordPress plugin

Puts the NFL schedule on `statchasers.com/nfl/nfl-schedule` as **server-rendered HTML**, so the
content is in the page source at your canonical URL rather than locked inside a JavaScript bundle.
The React app then layers on top for interactivity and live scores.

## Why not an iframe or a code module

- **Iframe** — Google attributes iframed content to the *source* URL, not the embedding page. Any
  ranking value would accrue to whatever host serves the app, leaving your page an empty shell.
- **Code module with the JS app** — the page source is `<div id="root"></div>` plus a script tag.
  Googlebot does render JavaScript, but on a deferred second pass and dependent on a third-party
  API call succeeding during that render. Bing is inconsistent; most AI crawlers don't execute JS
  at all. For a page whose whole value is 272 rows of factual data, shipping none of those rows in
  the HTML is the problem.

This plugin writes all 272 games into the HTML response.

## What gets rendered

For `[nfl_schedule]` on your page:

- A jump-to-week `<nav>` of real anchor links.
- 18 `<section>` blocks, each with an `<h2>` and a semantic `<table>` (`<caption>`,
  `<th scope="col">`) covering Date, Kickoff (ET), Matchup, TV and Venue.
- `SportsEvent` JSON-LD wrapped in an `ItemList`, with correct Eastern offsets
  (`2026-09-09T20:20:00-04:00`). Upcoming games only by default — see `jsonld` below.
- A `#sc-nfl-root` container the app mounts into.

Total page addition: roughly 124 KB of HTML, about 15 KB over the wire after gzip.

## Install

```bash
./artifacts/wordpress-plugin/build.sh --zip
```

That builds the WordPress bundle, copies it into `statchasers-nfl-schedule/assets/`, stamps a fresh
version (for cache-busting) and produces `statchasers-nfl-schedule.zip`.

Then: **WordPress admin → Plugins → Add New → Upload Plugin → Activate.**

On activation the plugin schedules a refresh and primes the cache within about a minute. Edit the
page at `/nfl/nfl-schedule` and add the shortcode:

```
[nfl_schedule]
```

Leave the page's own `<h1>` as the title — week headings are `<h2>` so the outline stays correct.

## Shortcode attributes

| Attribute | Default | Notes |
|---|---|---|
| `season` | `2026` | Season year. |
| `heading` | `h2` | `h2`, `h3` or `h4` for week titles. |
| `jsonld` | `upcoming` | `upcoming` (from today, max 64 events), `all` (all 272, ~100 KB), or `none`. |
| `app` | `yes` | `no` renders the static table only and skips the React bundle entirely. |

## How the data works

A PHP port of the Node API — no separate service to host, no CORS, no cross-origin latency.

Two sources, cached separately because they move at different speeds:

| Layer | Source | Refresh |
|---|---|---|
| Slate (dates, venues, lines) | nflverse `games.csv` | 6 hours |
| Status, live scores, TV | ESPN scoreboard | 30s while a game is live, else 15 min |

Both are stored in **options**, not transients: an object cache can evict a transient at any
moment, and an evicted schedule means a blank page for whoever asks next. Options give a
last-known-good copy that survives, with freshness decided from stored timestamps.

**Page rendering never makes a blocking HTTP request.** A WP-Cron job (`sc_nfl_refresh`, every five
minutes) does the fetching; the shortcode only reads stored data. Verified: zero HTTP calls during a
page render. The one exception is a genuinely cold cache on first load, which builds once behind a
lock so a traffic burst triggers one download rather than many.

Live scores reach the browser through the REST route, which *is* allowed to block on ESPN — a poll
is asking precisely because it wants the current score.

### REST route

```
GET /wp-json/statchasers/v1/api/nfl/schedule/2026
```

The path deliberately mirrors the Express API (`/api/nfl/schedule/{season}`) so the generated
TypeScript client needs nothing but a base URL to point here instead.

## How the app and the static table coexist

This is progressive enhancement, not React hydration. The plugin renders plain HTML; the bundle
mounts a separate React tree into `#sc-nfl-root`. Once the app has data it adds `sc-nfl-ready` to
`<html>`, and CSS swaps the static table for the live one — so a visitor never sees the schedule
replaced by a loading skeleton. If the script fails or JS is off, the static table simply stays.
That is also what a crawler sees, and the two versions carry the same content, so there is no
cloaking risk.

### Style isolation

The app is Tailwind-based and would otherwise wreck the surrounding theme. The WordPress bundle:

- **omits Tailwind's preflight**, which resets `*`, `html` and `body` globally, and substitutes a
  scoped reset confined to `.sc-nfl-app`;
- **rewrites every `:root` to `.sc-nfl-app`** at build time, so tokens like `--background`,
  `--border` and `--font-sans` never land on the document root beside your theme's own variables.

Both are verified in the built CSS: zero `:root`, zero global `body` rules, zero universal reset.

## Maintenance

After any change to the app, re-run `build.sh` and re-upload. The version stamp changes on every
build, so browsers pick up the new bundle instead of a cached one.

## Known considerations

- **Team logos** are hotlinked from ESPN's CDN (`a.espncdn.com`). That is how the app has always
  worked, but hotlinking a third party's images from a commercial site carries some risk — worth
  self-hosting the crests if this becomes a revenue page.
- **WP-Cron is request-triggered.** On a very low-traffic site the five-minute refresh can drift.
  If live scores matter on game day, point a real cron at `wp-cron.php` and set
  `DISABLE_WP_CRON` to `true`.
- **Week 18 has no TV data** until the NFL assigns it — those rows show `—`. That is the feed being
  honest, not a bug.
