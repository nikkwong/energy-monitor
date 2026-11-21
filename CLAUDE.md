# CLAUDE.md

Context for Claude (and other coding agents) working in this repo.

## What this is

Tenant-scoped utility dashboards in one deployment. Each configured tenant
has isolated rooms, leases, monitors, and telemetry. **Shelly EM Mini Gen4**
devices post power telemetry; users visit `/<tenantId>` or
`/<tenantId>/rooms/<roomId>`.

Tenant slugs partition data but are not authentication. Power is implemented;
the water modality can be configured but is intentionally not rendered yet.

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
| `data/tenants.json` | operator-edited | Tenant IDs, labels, default tenant, modality flags. |
| `data/tenants/<tenantId>/rooms.json` | atomic read-modify-write | Room/monitor labels, room modality flags, and lease history (including optional lease contact `email`). |
| `data/tenants/<tenantId>/readings/YYYY-MM.jsonl` | append-only NDJSON | One Shelly reading per line. |
| `data/tenants/<tenantId>/rollups/daily.jsonl` | append-only NDJSON | Daily kWh totals for archived shards. |
| `data/tenants/<tenantId>/usage.sqlite` | rebuildable SQLite query index | One energy-total row per `(room, monitor, UTC hour)`, latest readings, and cumulative-counter state. |

**Invariants**:

- All writes go through `src/lib/data.ts` and are serialized through a single
 in-process promise chain so `appendReading`, `writeRooms`, and
 `ensureRoomAndMonitor` never interleave.
- Raw reading shards are **never** rewritten in place. If a reading is bad, it's
 ignored at parse time. New ingests append to the tenant's monthly shard.
- JSONL remains the recovery/source-of-truth stream. `usage.sqlite` is the
  compact query path and can be recreated with `bun run rebuild:index --tenant TENANT_ID --apply`.
  Stop the server during a rebuild so readings cannot arrive during the atomic
  database replacement. Until a completed index exists, the app falls back to
  scanning JSONL.
- Production's `bun run start` pins `DATA_DIR=/home/nikk/energy-monitor-data`.
  Maintenance commands still need that explicit `DATA_DIR`; other invocations
  default to `./data` under the process working directory.
- Legacy tenant-local `readings.jsonl` is still read for compatibility. Run
 `bun run migrate:readings --tenant TENANT_ID --apply` to split it into
 monthly shards and move the monolith out of the request path.
- Old shards can be rolled up and gzipped with
 `bun run rollup --tenant TENANT_ID --before YYYY-MM --apply`.
- `ensureRoomAndMonitor` is strictly additive: it fills in missing `(room,
 monitor)` entries with default labels but never overwrites operator-edited
 fields. So once an operator has curated `rooms.json` (lease info, friendly
 labels), subsequent ingests preserve those edits.
- A "current lease" is the entry with `endDate === null`. Exactly zero or one
 per room. To turn over a tenant, set the existing lease's `endDate` and append a new one.

**Computing usage**: on ingest, sum **positive deltas** of `totalEnergyWh` per
`(room, monitor)` into a UTC-hour row in `usage.sqlite`. Negative deltas are
ignored as meter resets. Day/month/lease boundaries are exact because they are
hour-aligned. A range beginning partway through an hour prorates that first
hour, so arbitrary sub-hour boundaries are estimates. The JSONL fallback uses
the exact raw counter deltas. Don't replace energy deltas with voltage or
"average power × duration" — neither measures consumed energy accurately.

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

- `GET /` → redirect to the configured default tenant
- `GET /:tenantId` → tenant overview
- `GET /:tenantId/rooms/:roomId` → single room dashboard
- `GET /:tenantId/rooms/:roomId/edit` → room utility & lease editor
- `GET /:tenantId/rooms/:roomId/raw` → newest persisted raw reports
- `GET /api/tenants/:tenantId/config` → public tenant label/modalities
- `GET /api/tenants/:tenantId/rooms` → tenant room summaries
- `GET /api/tenants/:tenantId/rooms/:roomId/usage`
- `GET /api/tenants/:tenantId/rooms/:roomId/series?from=&to=&bucket=hour|day|month`
- `GET /api/tenants/:tenantId/rooms/:roomId/raw?limit=100` → newest raw readings, capped at 200
- `POST|PATCH /api/tenants/:tenantId/rooms/:roomId/modalities`
- `POST|PATCH /api/tenants/:tenantId/rooms/:roomId/leases/:leaseId/email`
- `GET /api/tenants/:tenantId/series?from=&to=&bucket=…`
- `DELETE /api/tenants/:tenantId/rooms/:roomId`
- `POST|GET /api/tenants/:tenantId/ingest/:roomId/:monitorId`
- `POST|GET /api/tenants/:tenantId/ingest/:roomId` — shorthand for `monitor=default`
- `GET /api/health`

Page routes are static HTML bundles; the client confirms tenant and room
existence through tenant-scoped APIs.

## Things to be careful about

1. **Don't pre-aggregate on write.** The whole point of the on-demand
   aggregator is that lease boundaries can be edited freely. If you add a
   monthly cache, invalidate it whenever that tenant's `rooms.json` changes.
2. **Validate `roomId` and `monitorId` against `^[\p{L}\p{N}_-]{1,32}$` in
   `server.ts`** — Unicode letters/numbers are allowed (including Chinese),
   while slashes/spaces/punctuation stay out of path segments. There is **no**
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
5. **Telemetry is gitignored.** Tenant room metadata may be checked in; raw
   shards, rollups, archives, and legacy `readings.jsonl` are not.

## Deployment

`cloudbuild.yaml` SSHes into the GCE `apps` host and runs `pull-beaver.sh`.
That script is expected to do `git pull && bun install --production` and
restart the service (e.g. systemd). The `data/` dir should be persisted
outside the repo (typically `/var/lib/5214`, symlinked).

## Common tasks

- **Add a room or monitor**: configure the new Shelly with the desired
 `TENANT_ID`/`ROOM_ID`/`MONITOR_ID` and let it POST once. The server creates
 the entry in `data/tenants/<tenantId>/rooms.json` automatically. Edit it afterwards
 to give the auto-created entry a friendlier label or to start tracking a
 lease.
- **Delete a room** (e.g. test data left in prod): click the × on the
 room's card on the homepage (or `curl -X DELETE
 /api/tenants/<tenantId>/rooms/<roomId>`). Removes the entry from that
 tenant's `rooms.json`; historical
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
 `tail -f data/tenants/5214/readings/$(date -u +%Y-%m).jsonl | jq`.
- **Migrate legacy telemetry**: `bun run migrate:readings --tenant 5214 --apply`.
- **Roll up old telemetry**: `bun run rollup --tenant 5214 --before 2025-07 --apply`.
- **Build/rebuild the fast query index**: stop the server, then run
  `bun run rebuild:index --tenant 5214 --apply`. This imports daily rollups and retained raw
  readings, atomically replaces `data/tenants/5214/usage.sqlite`, and enables hourly SQLite
  queries on the next start.
- **Force a test reading**:
 `curl -X POST http://localhost:3000/api/tenants/5214/ingest/301/default -H 'content-type: application/json' -d '{"params":{"ts":1714521600,"em1:0":{"act_power":120},"em1data:0":{"total_act_energy":12345}}}'`
