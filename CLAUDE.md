# CLAUDE.md

Context for Claude (and other coding agents) working in this repo.

## What this is

Single-tenant, single-house power dashboard for **5214**. One or more
**Shelly EM Mini Gen4** devices per room (single-channel CT clamped on a
specific feed — south wall, in-bathroom, etc.) post telemetry to this
server; tenants visit `/<roomId>` to see how much power they've used this
month and over their full lease.

Not a multi-tenant SaaS. One house, a handful of rooms, one or more
**monitors** per room.

## Stack & conventions

- **Bun** 1.3+ runs everything: the server, the bundler, type-checking. No Node, no Vite, no webpack.
- **`Bun.serve` with `routes`** for routing. HTML files are imported as bundles (`import index from "./pages/index.html"`) and Bun handles bundling linked TS/CSS automatically.
- **TypeScript strict mode**. `noUncheckedIndexedAccess` is on — index lookups return `T | undefined`.
- **Vanilla TS on the client** + Chart.js. No React/Vue/Svelte unless explicitly needed.
- **No build step required** for development — `bun run dev` serves and hot-reloads.

## Data model — read this before changing anything storage-related

Storage in `data/` is deliberately split by write pattern:

| File | Pattern | Contains |
|---|---|---|
| `data/rooms.json` | atomic read-modify-write (write to `.tmp`, rename) | Operator-editable overlay metadata: room/monitor labels, lease history. Auto-grown on first POST from a new `(room, monitor)` pair. |
| `data/readings/YYYY-MM.jsonl` | append-only NDJSON shards | One Shelly reading per line, raw payload preserved. The Shellys are the source of truth for "what monitors exist". |
| `data/rollups/daily.jsonl` | append-only NDJSON | Daily kWh totals for old raw shards that have been gzipped/archived. |

**Invariants**:

- All writes go through `src/lib/data.ts` and are serialized through a single
 in-process promise chain so `appendReading`, `writeRooms`, and
 `ensureRoomAndMonitor` never interleave.
- Raw reading shards are **never** rewritten in place. If a reading is bad, it's
 ignored at parse time. New ingests append to `data/readings/YYYY-MM.jsonl`.
- Legacy `data/readings.jsonl` is still read for compatibility. Run
 `bun run migrate:readings --apply` once in production to split it into
 monthly shards and move the monolith out of the request path.
- Old shards can be rolled up and gzipped with
 `bun run rollup --before YYYY-MM --apply`. This appends daily totals to
 `data/rollups/daily.jsonl` and archives raw shards under
 `data/archive/readings/*.jsonl.gz`.
- `ensureRoomAndMonitor` is strictly additive: it fills in missing `(room,
 monitor)` entries with default labels but never overwrites operator-edited
 fields. So once an operator has curated `rooms.json` (lease info, friendly
 labels), subsequent ingests preserve those edits.
- A "current lease" is the entry with `endDate === null`. Exactly zero or one
 per room. To turn over a tenant, set the existing lease's `endDate` and append a new one.

**Computing usage**: raw shards are walked in append order and we sum
**positive deltas** of `totalEnergyWh` per `(room, monitor)` whose timestamp
falls in `[from, to)`. Daily rollups are added directly as kWh. We trust the
meter's monotonic counter and ignore negative deltas (would indicate a meter
reset). Don't replace this with "average power × duration" — the cumulative
counter is more accurate.

**Reading shape**: flat, one tuple per device report:
`{ ts, room, monitor, powerW, totalEnergyWh, raw? }`. Multi-channel devices
get summed at the normalizer; the channel concept doesn't survive into
storage. Pre-migration readings (with `channels: [...]` and no `monitor`
field) are coerced at parse time in `data.ts` to `monitor: "default"` plus
the summed power/energy — they keep working without rewriting the file.

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
- `GET /api/rooms/:roomId/usage` — month, lease-to-date, latest, per-monitor breakdown
- `GET /api/rooms/:roomId/series?from=&to=&bucket=hour|day|month`
- `GET /api/series?from=&to=&bucket=…` — house total
- `DELETE /api/rooms/:roomId` — remove a room from `rooms.json`. Readings stay on disk but are filtered out of every aggregation. Operator action; if a Shelly still POSTs this room id it'll auto-register on its next POST.
- `POST /api/ingest/:roomId/:monitorId` — Shelly webhook (one path per device)
- `GET  /api/ingest/:roomId/:monitorId?total_act_energy=…&act_power=…` — legacy
- `POST|GET /api/ingest/:roomId` — shorthand for `monitor=default` (single-monitor rooms)
- `GET /api/health`

`/:roomId` route catches any single-segment path. Unknown rooms render the
HTML; the client shows an error after the API call 404s. Don't add server-side
room validation to that route — keep the HTML route purely static.

## Things to be careful about

1. **Don't pre-aggregate on write.** The whole point of the on-demand
   aggregator is that lease boundaries can be edited freely. If you add a
   monthly cache, invalidate it whenever `data/rooms.json` changes.
2. **Validate `roomId` and `monitorId` against `^[A-Za-z0-9_-]{1,16}$` in
   `server.ts`** — keeps path segments URL-safe and bounded. There is **no**
   allowlist beyond the regex; the Shellys are the source of truth for what
   `(room, monitor)` pairs exist, and the server auto-registers new ones via
   `ensureRoomAndMonitor`. Trade-off: a typo'd `MONITOR_ID` silently creates a
   phantom feed, so audit `auto-registered …` log lines after deploying
   devices, and prune `rooms.json` to hide typos.
3. **Timezones.** Storage is UTC. Aggregation buckets are UTC. The client
   formats labels in the browser's local TZ. "This month" on the dashboard is
   computed server-side using UTC month — if you need local-month boundaries,
   pass an explicit `from` from the client.
4. **Concurrent writes.** Use `appendReading` / `writeRooms` from `data.ts`,
   never write the files directly.
5. **Telemetry is gitignored.** `data/rooms.json` is checked in; raw shards,
   rollups, archives, and legacy `readings.jsonl` are not.

## Deployment

`cloudbuild.yaml` SSHes into the GCE `apps` host and runs `pull-beaver.sh`.
That script is expected to do `git pull && bun install --production` and
restart the service (e.g. systemd). The `data/` dir should be persisted
outside the repo (typically `/var/lib/5214`, symlinked).

## Common tasks

- **Add a room or monitor**: just configure the new Shelly with the
 desired `ROOM_ID`/`MONITOR_ID` and let it POST once. The server creates
 the entry in `data/rooms.json` automatically. Edit `rooms.json` afterwards
 to give the auto-created entry a friendlier label or to start tracking a
 lease.
- **Delete a room** (e.g. test data left in prod): click the × on the
 room's card on the homepage (or `curl -X DELETE
 /api/rooms/<roomId>`). Removes the entry from `rooms.json`; historical
 readings stay on disk but are filtered out of every
 aggregation, so the room silently disappears. **Important**: if the
 Shelly is still POSTing to that room id, it'll auto-register on its next
 POST. Stop or re-flash the device first if you want the deletion to
 stick. To recover a deleted room's data, re-add it to `rooms.json`
 (manually, or wait for the next auto-register).
- **Rotate a tenant**: set the active lease's `endDate` to today, append a new
  lease with `endDate: null`. Past usage stays attributed to the old tenant
  because aggregation windows the readings by `[lease.startDate, lease.endDate)`.
- **Inspect raw Shelly bodies**:
 `tail -f data/readings/$(date -u +%Y-%m).jsonl | jq`.
- **Migrate legacy telemetry**: `bun run migrate:readings --apply`.
- **Roll up old telemetry**: `bun run rollup --before 2025-07 --apply`.
- **Force a test reading**:
 `curl -X POST http://localhost:3000/api/ingest/301/default -H 'content-type: application/json' -d '{"params":{"ts":1714521600,"em1:0":{"act_power":120},"em1data:0":{"total_act_energy":12345}}}'`
