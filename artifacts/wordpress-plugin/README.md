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
| `width` | `content` | `wide` breaks out of the theme's column up to 1480px; `full` goes edge to edge. Both subtract the measured scrollbar width so the page never scrolls sideways. |

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

### Style isolation — the app renders in a shadow root

Tailwind emits all of its CSS inside `@layer`, and **unlayered CSS beats layered CSS regardless of
specificity**. A theme's CSS is unlayered, so an ordinary rule like `.entry-content button { display:
block }` overrides every utility in the bundle — which shows up as a vertical nav instead of a
horizontal one, collapsed row grids, and the theme's fonts throughout.

Specificity cannot win that fight. So the app mounts inside a **shadow root**, which is a hard style
boundary in both directions: theme CSS cannot reach in, and the app's CSS cannot leak out.

Three consequences the build handles automatically:

- **`:root` becomes `:host`.** Inside a shadow tree `:root` matches nothing, so the design tokens
  would never apply.
- **`@font-face` and `@property` are hoisted** into `assets/sc-nfl-schedule.document.css`, which the
  plugin enqueues normally. Both are document-scoped and silently ignored inside a shadow root —
  without the `@property` registrations, Tailwind v4 loses `--tw-border-style: solid` and every
  border in the app disappears.
- **Radix portals** (the team picker, the export menu, tooltips) are given the shadow container
  explicitly; left alone they escape to `document.body` and render unstyled.

Verified by rendering the app against a deliberately hostile theme stylesheet — one that forces
`display: block` on buttons, Georgia on everything, red links, and double borders on tables — and
confirming the widget is untouched while the surrounding page still shows all of it.

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
