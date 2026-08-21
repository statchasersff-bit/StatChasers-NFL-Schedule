# StatChasers NFL Schedule

A premium interactive 2026 NFL schedule tool for fantasy football players.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/nfl-schedule/src/App.tsx` — responsive weekly, team, bye-week, insights, and season-matrix experience.
- `artifacts/nfl-schedule/src/index.css` — StatChasers navy/brass visual tokens and responsive layout rules.
- `artifacts/api-server/src/routes/nfl.ts` — normalized nflverse schedule feed with server-side caching and team metadata.
- `lib/api-spec/openapi.yaml` — source-of-truth contract for the schedule API.

## Architecture decisions

- The UI derives every view from one normalized season payload to keep weekly, team, matrix, bye, and insights data consistent.
- Schedule data is fetched server-side from nflverse and cached in memory for six hours; pre-season schedule files can remain incomplete without fabricated kickoff details.
- Team codes are centralized and legacy feed abbreviations are normalized at the API boundary.

## Product

- Browse the 2026 regular season by week, team, or full-season matrix.
- Search teams by name, city, or abbreviation; inspect byes, primetime, divisional, and international games.
- Share filtered views through URL state without full page reloads.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- The API workflow must be running for the schedule client hook to resolve through `/api`.
- nflverse is authoritative for the normalized feed; flexible future weeks may have incomplete dates/times and must render as TBD rather than guessed values.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
