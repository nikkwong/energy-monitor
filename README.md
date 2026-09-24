# 5214

Per-room power-consumption dashboard for the house at 5214, fed by Shelly EM
Mini Gen4 devices (one per room). Shows each tenant how much power they've
used this month and over their full lease.

## Stack

- **Runtime / bundler**: [Bun](https://bun.sh) 1.3+ (native HTML routing + bundling)
- **Server**: `Bun.serve` with typed routes and dynamic params
- **Client**: vanilla TypeScript + [Chart.js](https://www.chartjs.org), bundled by Bun
- **Storage**: two flat files in `data/` — see [Data model](#data-model)

## Quick start

```bash
bun install
bun run dev      # http://localhost:3000  (hot reload)
```

In production:

```bash
bun install --production
PORT=3000 bun run start
```

## Configuration

- `PORT` — HTTP port, defaults to `3000`.

The homepage has a browser-local electricity-rate setting saved in
`localStorage`. It defaults to Seattle City Light's current Seattle residential
energy rate, `$0.1338/kWh`. Cost estimates do not include fixed daily service
charges.

## Routes

### Pages

- `GET /` — overview of every room with totals + house-level chart
- `GET /:roomId` — single-room dashboard (e.g. `/301`, `/b4`)

### JSON API

- `GET /api/rooms` — every room with month-to-date kWh, lease-to-date kWh, current power, last-seen
- `GET /api/rooms/:roomId/usage` — same plus per-channel breakdown for one room
- `GET /api/rooms/:roomId/series?from=&to=&bucket=hour|day|month` — time series for one room
- `GET /api/series?from=&to=&bucket=…` — house-total time series
- `POST /api/ingest/:roomId` — Shelly webhook target (NotifyStatus / RPC payloads)
- `GET /api/ingest/:roomId?total_act_energy=…&act_power=…&channel=…` — legacy "Action URL" target
- `GET /api/health`

`from`/`to` accept any ISO-8601 timestamp. Defaults: last 30 days, day buckets.

## Configuring Shelly devices

See [`shelly/README.md`](./shelly/README.md) for the device-side setup.
TL;DR: paste [`shelly/report.js`](./shelly/report.js) into the device's
**Scripts** tab, edit `ROOM_ID` + `BASE_URL`, click Run + Start on boot.

The server's ingest endpoint is forgiving: as long as the body has any of
`em1:N` / `em1data:N` / `em:N` keys (or the legacy querystring params), it
stores a reading. Anything unrecognized is preserved in `raw` for debugging.

## Data model

### `data/rooms.json` (read-modify-write, rare)

Identity and lease history. Edit by hand or via a future admin endpoint.

```json
{
  "rooms": {
    "301": {
      "label": "Room 301",
      "channelLabels": { "0": "Outlets", "1": "Lights", "2": "AC" },
      "leases": [
        {
          "id": "lease-301-1",
          "tenant": "Alice",
          "startDate": "2026-05-01",
          "endDate": null
        }
      ]
    }
  }
}
```

The current tenant is the lease with `endDate: null`. To rotate tenants, set
`endDate` on the existing lease and append a new one.

### `data/readings/YYYY-MM.jsonl` (append-only telemetry)

One JSON object per line, sharded by UTC month. Created on first webhook for
that month. Never edited in-place.

```jsonl
{"ts":"2026-05-01T07:00:00Z","room":"301","monitor":"south","powerW":120.5,"totalEnergyWh":12345.67,"raw":{...}}
```

Older deployments may still have a legacy `data/readings.jsonl`; the app reads
it for compatibility. Migrate it once so requests no longer have to scan one
large file:

```bash
bun run migrate:readings          # dry run
bun run migrate:readings --apply  # write shards, move readings.jsonl aside
```

### `data/rollups/daily.jsonl` (old-data summaries)

For raw shards older than your retention window, roll them up to daily kWh and
gzip the raw shard:

```bash
# Archive shards older than July 2025 (dry run first)
bun run rollup --before 2025-07
bun run rollup --before 2025-07 --apply
```

This writes daily rows like:

```jsonl
{"date":"2025-06-01","room":"301","monitor":"south","energyKWh":4.21}
```

Archived raw shards land in `data/archive/readings/*.jsonl.gz`. The dashboard
can rebuild its SQLite query index from daily rollups plus retained raw shards.

### `data/usage.sqlite` (fast query index)

Dashboard requests use a compact SQLite index containing one consumed-energy
total per room, monitor, and UTC hour, plus each monitor's latest reading.
Minute-level reports are still preserved in JSONL, but they are not repeatedly
parsed when the app opens.

Build the index once after upgrading:

```bash
bun run rebuild:index          # prints instructions; changes nothing
# Stop the dashboard service before the next command.
bun run rebuild:index --apply
```

If telemetry lives outside the checkout, set its absolute path explicitly for
both the server and maintenance commands:

```bash
DATA_DIR=/home/nikk/energy-monitor-data bun run rebuild:index --apply
```

For this deployment, `bun run start` already uses
`/home/nikk/energy-monitor-data`; `DATA_DIR` can still override it when running
the server directly. Maintenance commands require an explicit `DATA_DIR`.
The rebuild prints the selected directory and refuses to activate an index
with fewer than 100 source rows unless `--allow-small` is supplied.

The rebuild imports daily rollups and retained raw readings, then atomically
replaces `data/usage.sqlite`. If the index is absent or incomplete, the app
continues using the slower JSONL reader instead of returning empty totals.

Hourly rows store positive deltas from the Shelly's cumulative
`totalEnergyWh` counter—not voltage and not sampled power. Day, month, and
midnight lease boundaries remain exact. Ranges beginning partway through an
hour estimate the overlapping fraction of that first hour.

### Why keep JSONL and SQLite?

- Telemetry and identity have very different write patterns. Telemetry
  appends every minute; lease config changes once a quarter. Mixing them
  forces read-modify-write on every Shelly post, which is fragile under
  concurrency.
- Append-only NDJSON is crash-safe and trivially parseable.
- JSONL preserves the raw Shelly payload and is the recovery source. SQLite is
  a rebuildable, compact query index.
- Usage remains based on cumulative-energy counter deltas, so changing a lease
  boundary does not require rewriting telemetry.

## Project layout

```
src/
  server.ts           # Bun.serve + routes
  lib/
    types.ts          # Shared types
    data.ts           # rooms.json + readings.jsonl I/O (serialized writes)
    hourly-store.ts   # compact SQLite ingestion and indexed reads
    shelly.ts         # Forgiving Shelly payload normalizer
    aggregate.ts      # SQLite queries with JSONL fallback
  pages/
    index.html        # Overview
    index.ts
    room.html         # /:roomId dashboard
    room.ts
    common.ts
    styles.css
data/
  rooms.json          # leases (in git)
  readings/           # monthly raw telemetry shards (gitignored)
  rollups/            # daily old-data summaries (gitignored)
  archive/readings/   # gzipped old raw shards (gitignored)
  usage.sqlite        # rebuildable hourly query index (gitignored)
```

## Deployment notes

This repo is paired with the existing `cloudbuild.yaml`, which SSHes into the
`apps` GCE instance and runs `pull-beaver.sh`. That script should:

1. `git pull`
2. `bun install --production` (in this directory)
3. Restart the `bun run start` process (e.g. via systemd)

Persist `data/` outside the deploy dir or on a volume so `git pull` doesn't
clobber `readings.jsonl`. A typical layout: symlink `./data` -> `/var/lib/5214`.
# energy-monitor
