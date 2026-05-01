# CLAUDE.md

Context for Claude (and other coding agents) working in this repo.

## What this is

Single-tenant, single-house power dashboard for **5214**. One **Shelly EM
Mini Gen4** per room (single-channel CT clamped on that room's mains feed)
posts telemetry to this server; tenants visit `/<roomId>` to see how much
power they've used this month and over their full lease.

Not a multi-tenant SaaS. One house, a handful of rooms, one meter per room.

## Stack & conventions

- **Bun** 1.3+ runs everything: the server, the bundler, type-checking. No Node, no Vite, no webpack.
- **`Bun.serve` with `routes`** for routing. HTML files are imported as bundles (`import index from "./pages/index.html"`) and Bun handles bundling linked TS/CSS automatically.
- **TypeScript strict mode**. `noUncheckedIndexedAccess` is on — index lookups return `T | undefined`.
- **Vanilla TS on the client** + Chart.js. No React/Vue/Svelte unless explicitly needed.
- **No build step required** for development — `bun run dev` serves and hot-reloads.

## Data model — read this before changing anything storage-related

Two files in `data/`, deliberately separate:

| File | Pattern | Contains |
|---|---|---|
| `data/rooms.json` | atomic read-modify-write (write to `.tmp`, rename) | Rooms, channel labels, lease history |
| `data/readings.jsonl` | append-only NDJSON | One Shelly reading per line, raw payload preserved |

**Invariants**:

- All writes go through `src/lib/data.ts` and are serialized through a single
  in-process promise chain so `appendReading` and `writeRooms` never interleave.
- `readings.jsonl` is **never** rewritten in place. If a reading is bad, it's
  ignored at parse time. To purge data, append a new shard or rotate.
- A "current lease" is the entry with `endDate === null`. Exactly zero or one
  per room. To turn over a tenant, set the existing lease's `endDate` and append a new one.

**Computing usage**: we walk readings in chronological order and sum
**positive deltas** of `totalEnergyWh` per `(room, channel)` whose timestamp
falls in `[from, to)`. We trust the meter's monotonic counter and ignore
negative deltas (would indicate a meter reset). Don't replace this with
"average power × duration" — the cumulative counter is more accurate.

## Shelly payload handling

`src/lib/shelly.ts` is intentionally forgiving. It accepts:

- Modern JSON-RPC `NotifyStatus` with `em1:N` / `em1data:N` keys in `params`.
- Same keys at the top level (RPC status response).
- Legacy `?total_act_energy=…&act_power=…&channel=N` querystring (Action URLs).

The raw body is always stored alongside the parsed channels. **If you add a
new firmware shape, extend the normalizer; don't move the parsing into the
route handler.**

## Routes

- `GET /` → `src/pages/index.html` — overview
- `GET /:roomId` → `src/pages/room.html` — single room dashboard
- `GET /api/rooms` — summaries for all rooms
- `GET /api/rooms/:roomId/usage` — month, lease-to-date, latest, channels
- `GET /api/rooms/:roomId/series?from=&to=&bucket=hour|day|month`
- `GET /api/series?from=&to=&bucket=…` — house total
- `POST /api/ingest/:roomId` — Shelly webhook
- `GET  /api/ingest/:roomId?total_act_energy=…&act_power=…&channel=…` — legacy
- `GET /api/health`

`/:roomId` route catches any single-segment path. Unknown rooms render the
HTML; the client shows an error after the API call 404s. Don't add server-side
room validation to that route — keep the HTML route purely static.

## Things to be careful about

1. **Don't pre-aggregate on write.** The whole point of the on-demand
   aggregator is that lease boundaries can be edited freely. If you add a
   monthly cache, invalidate it whenever `data/rooms.json` changes.
2. **Don't trust client-supplied `roomId`** — validate against `ROOM_ID_RE` in
   `server.ts` (`/^[A-Za-z0-9_-]{1,16}$/`). The ingest endpoint also rejects
   unknown room ids so a mistyped Shelly URL doesn't silently create files.
3. **Timezones.** Storage is UTC. Aggregation buckets are UTC. The client
   formats labels in the browser's local TZ. "This month" on the dashboard is
   computed server-side using UTC month — if you need local-month boundaries,
   pass an explicit `from` from the client.
4. **Concurrent writes.** Use `appendReading` / `writeRooms` from `data.ts`,
   never write the files directly.
5. **`data/readings.jsonl` is gitignored.** `data/rooms.json` is checked in.
   Don't accidentally swap that.

## Deployment

`cloudbuild.yaml` SSHes into the GCE `apps` host and runs `pull-beaver.sh`.
That script is expected to do `git pull && bun install --production` and
restart the service (e.g. systemd). The `data/` dir should be persisted
outside the repo (typically `/var/lib/5214`, symlinked).

## Common tasks

- **Add a room**: edit `data/rooms.json`, add an entry, restart isn't needed
  (file is read on each request).
- **Rotate a tenant**: set the active lease's `endDate` to today, append a new
  lease with `endDate: null`. Past usage stays attributed to the old tenant
  because aggregation windows the readings by `[lease.startDate, lease.endDate)`.
- **Inspect raw Shelly bodies**: `tail -f data/readings.jsonl | jq`.
- **Force a test reading**:
  `curl -X POST http://localhost:3000/api/ingest/301 -H 'content-type: application/json' -d '{"params":{"ts":1714521600,"em1:0":{"act_power":120},"em1data:0":{"total_act_energy":12345}}}'`
