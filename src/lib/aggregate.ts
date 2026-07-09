import { iterDailyRollups, iterReadings, readRooms } from "./data.ts";
import { visibleMonitorIds } from "./monitors.ts";
import type { DailyRollup, Reading, RoomsConfig } from "./types.ts";

export type Bucket = "hour" | "day" | "month";

export type SeriesPoint = {
  /** ISO timestamp at the start of the bucket (UTC). */
  ts: string;
  /** Energy consumed during the bucket, in kWh. */
  energyKWh: number;
};

export type UsageSummary = {
  from: string;
  to: string;
  energyKWh: number;
  /** kWh per monitor id within the room (empty when aggregating across rooms). */
  monitors: Record<string, number>;
};

export type LatestReading = {
  ts: string;
  /** Sum of instantaneous power across every monitor in the room, in watts. */
  powerW: number;
  /** Per-monitor snapshot, keyed by monitor id. */
  monitors: Record<string, { ts: string; powerW: number; totalEnergyWh: number }>;
};

export type RoomSummaryMetrics = {
  leaseKWh: number;
  monthKWh: number;
  powerW: number | null;
  lastSeen: string | null;
};

function bucketStartUTC(d: Date, bucket: Bucket): Date {
  const out = new Date(d.getTime());
  if (bucket === "hour") {
    out.setUTCMinutes(0, 0, 0);
  } else if (bucket === "day") {
    out.setUTCHours(0, 0, 0, 0);
  } else {
    out.setUTCDate(1);
    out.setUTCHours(0, 0, 0, 0);
  }
  return out;
}

function monitorAllowlist(cfg: RoomsConfig): Map<string, Set<string> | null> {
  const out = new Map<string, Set<string> | null>();
  for (const [roomId, room] of Object.entries(cfg.rooms)) {
    const ids = visibleMonitorIds(room.monitors);
    out.set(roomId, ids.length > 0 ? new Set(ids) : null);
  }
  return out;
}

function readingAllowed(
  r: Reading,
  allowlists: Map<string, Set<string> | null>,
): boolean {
  const allow = allowlists.get(r.room);
  if (!allow) return true;
  return allow.has(r.monitor);
}

function counterKey(r: Reading): string {
  return `${r.room}|${r.monitor}`;
}

function roomFromCounterKey(key: string): string {
  const sep = key.indexOf("|");
  return sep === -1 ? key : key.slice(0, sep);
}

async function readFilterContext(): Promise<{
  allowedRooms: Set<string>;
  monitorLists: Map<string, Set<string> | null>;
}> {
  const cfg = await readRooms();
  return {
    allowedRooms: new Set(Object.keys(cfg.rooms)),
    monitorLists: monitorAllowlist(cfg),
  };
}

function shouldUseReading(
  r: Reading,
  ctx: { allowedRooms: Set<string>; monitorLists: Map<string, Set<string> | null> },
  room?: string,
): boolean {
  if (room) {
    if (r.room !== room) return false;
  } else if (!ctx.allowedRooms.has(r.room)) {
    return false;
  }
  return readingAllowed(r, ctx.monitorLists);
}

function shouldUseRollup(
  r: DailyRollup,
  ctx: { allowedRooms: Set<string>; monitorLists: Map<string, Set<string> | null> },
  room?: string,
): boolean {
  if (room) {
    if (r.room !== room) return false;
  } else if (!ctx.allowedRooms.has(r.room)) {
    return false;
  }
  const allow = ctx.monitorLists.get(r.room);
  return !allow || allow.has(r.monitor);
}

function leaseStartMs(room: RoomsConfig["rooms"][string]): number {
  const current = room.leases.find((l) => l.endDate === null);
  return current
    ? new Date(current.startDate + "T00:00:00Z").getTime()
    : 0;
}

function monthStartMs(now: Date): number {
  const monthFrom = new Date(now);
  monthFrom.setUTCDate(1);
  monthFrom.setUTCHours(0, 0, 0, 0);
  return monthFrom.getTime();
}

/**
 * Single-pass metrics for every room — powers GET /api/rooms. Replaces the
 * old pattern of 3 full-file scans per room (lease + month + latest).
 */
export async function computeAllRoomSummaries(
  cfg: RoomsConfig,
  now = new Date(),
): Promise<Map<string, RoomSummaryMetrics>> {
  const nowMs = now.getTime();
  const monthFromMs = monthStartMs(now);
  const leaseFromMs = new Map<string, number>();
  const leaseKWh = new Map<string, number>();
  const monthKWh = new Map<string, number>();
  const out = new Map<string, RoomSummaryMetrics>();

  for (const [roomId, room] of Object.entries(cfg.rooms)) {
    leaseFromMs.set(roomId, leaseStartMs(room));
    leaseKWh.set(roomId, 0);
    monthKWh.set(roomId, 0);
    out.set(roomId, {
      leaseKWh: 0,
      monthKWh: 0,
      powerW: null,
      lastSeen: null,
    });
  }

  const lastCounter = new Map<string, number>();
  const latestByKey = new Map<string, Reading>();
  const monitorLists = monitorAllowlist(cfg);
  const ctx = {
    allowedRooms: new Set(Object.keys(cfg.rooms)),
    monitorLists,
  };

  for await (const row of iterDailyRollups({
    from: new Date(0),
    to: now,
  })) {
    if (!shouldUseRollup(row, ctx)) continue;
    const tsMs = new Date(row.date + "T00:00:00Z").getTime();
    const lf = leaseFromMs.get(row.room);
    if (lf !== undefined && tsMs >= lf && tsMs < nowMs) {
      leaseKWh.set(row.room, (leaseKWh.get(row.room) ?? 0) + row.energyKWh);
    }
    if (tsMs >= monthFromMs && tsMs < nowMs) {
      monthKWh.set(row.room, (monthKWh.get(row.room) ?? 0) + row.energyKWh);
    }
  }

  // Stream in append order instead of loading + sorting the full JSONL. Shelly
  // reports are append-only and effectively chronological; keeping this
  // streaming prevents a large mock-polluted file from blocking the process.
  for await (const r of iterReadings()) {
    if (!leaseFromMs.has(r.room)) continue;
    if (!readingAllowed(r, monitorLists)) continue;
    const key = counterKey(r);
    const prevLatest = latestByKey.get(key);
    if (!prevLatest || r.ts > prevLatest.ts) latestByKey.set(key, r);

    const prev = lastCounter.get(key);
    lastCounter.set(key, r.totalEnergyWh);
    if (prev === undefined) continue;

    const delta = r.totalEnergyWh - prev;
    if (delta <= 0) continue;

    const tsMs = new Date(r.ts).getTime();
    const kwh = delta / 1000;
    const roomId = r.room;

    const lf = leaseFromMs.get(roomId);
    if (lf !== undefined && tsMs >= lf && tsMs < nowMs) {
      leaseKWh.set(roomId, (leaseKWh.get(roomId) ?? 0) + kwh);
    }
    if (tsMs >= monthFromMs && tsMs < nowMs) {
      monthKWh.set(roomId, (monthKWh.get(roomId) ?? 0) + kwh);
    }
  }

  for (const [key, r] of latestByKey) {
    const roomId = roomFromCounterKey(key);
    const entry = out.get(roomId);
    if (!entry) continue;
    entry.powerW = (entry.powerW ?? 0) + (r.powerW || 0);
    if (!entry.lastSeen || r.ts > entry.lastSeen) entry.lastSeen = r.ts;
  }

  for (const [roomId, entry] of out) {
    entry.leaseKWh = leaseKWh.get(roomId) ?? 0;
    entry.monthKWh = monthKWh.get(roomId) ?? 0;
    if (!entry.lastSeen) entry.powerW = null;
  }

  return out;
}

export async function computeUsage(opts: {
  room?: string;
  from: Date;
  to: Date;
}): Promise<UsageSummary> {
  const ctx = await readFilterContext();
  const last = new Map<string, number>();
  const monitors: Record<string, number> = {};
  let totalKWh = 0;

  const fromMs = opts.from.getTime();
  const toMs = opts.to.getTime();

  for await (const row of iterDailyRollups({ from: opts.from, to: opts.to })) {
    if (!shouldUseRollup(row, ctx, opts.room)) continue;
    totalKWh += row.energyKWh;
    if (opts.room) {
      monitors[row.monitor] = (monitors[row.monitor] ?? 0) + row.energyKWh;
    }
  }

  for await (const r of iterReadings({ from: opts.from, to: opts.to })) {
    if (!shouldUseReading(r, ctx, opts.room)) continue;
    const key = counterKey(r);
    const prev = last.get(key);
    last.set(key, r.totalEnergyWh);
    if (prev === undefined) continue;
    const delta = r.totalEnergyWh - prev;
    if (delta <= 0) continue;
    const tsMs = new Date(r.ts).getTime();
    if (tsMs < fromMs || tsMs >= toMs) continue;
    const kwh = delta / 1000;
    totalKWh += kwh;
    if (opts.room) {
      monitors[r.monitor] = (monitors[r.monitor] ?? 0) + kwh;
    }
  }

  return {
    from: opts.from.toISOString(),
    to: opts.to.toISOString(),
    energyKWh: totalKWh,
    monitors,
  };
}

export async function computeSeries(opts: {
  room?: string;
  from: Date;
  to: Date;
  bucket: Bucket;
}): Promise<SeriesPoint[]> {
  const ctx = await readFilterContext();
  const last = new Map<string, number>();
  const buckets = new Map<number, number>();

  const fromMs = opts.from.getTime();
  const toMs = opts.to.getTime();

  for await (const row of iterDailyRollups({ from: opts.from, to: opts.to })) {
    if (!shouldUseRollup(row, ctx, opts.room)) continue;
    const bucketKey = bucketStartUTC(
      new Date(row.date + "T00:00:00Z"),
      opts.bucket,
    ).getTime();
    buckets.set(bucketKey, (buckets.get(bucketKey) ?? 0) + row.energyKWh);
  }

  for await (const r of iterReadings({ from: opts.from, to: opts.to })) {
    if (!shouldUseReading(r, ctx, opts.room)) continue;
    const key = counterKey(r);
    const prev = last.get(key);
    last.set(key, r.totalEnergyWh);
    if (prev === undefined) continue;
    const delta = r.totalEnergyWh - prev;
    if (delta <= 0) continue;
    const ts = new Date(r.ts);
    const tsMs = ts.getTime();
    if (tsMs < fromMs || tsMs >= toMs) continue;
    const bucketKey = bucketStartUTC(ts, opts.bucket).getTime();
    buckets.set(bucketKey, (buckets.get(bucketKey) ?? 0) + delta / 1000);
  }

  const out: SeriesPoint[] = [];
  const cursor = bucketStartUTC(opts.from, opts.bucket);
  const end = opts.to;
  while (cursor < end) {
    const k = cursor.getTime();
    out.push({ ts: cursor.toISOString(), energyKWh: buckets.get(k) ?? 0 });
    if (opts.bucket === "hour") {
      cursor.setUTCHours(cursor.getUTCHours() + 1);
    } else if (opts.bucket === "day") {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    } else {
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  }
  return out;
}

export async function latestReading(room: string): Promise<LatestReading | null> {
  const perMonitor = new Map<string, Reading>();
  const ctx = await readFilterContext();
  for await (const r of iterReadings()) {
    if (!shouldUseReading(r, ctx, room)) continue;
    const cur = perMonitor.get(r.monitor);
    if (!cur || r.ts > cur.ts) perMonitor.set(r.monitor, r);
  }
  if (perMonitor.size === 0) return null;

  let mostRecent = "";
  let powerW = 0;
  const monitors: LatestReading["monitors"] = {};
  for (const [id, r] of perMonitor) {
    if (r.ts > mostRecent) mostRecent = r.ts;
    powerW += r.powerW || 0;
    monitors[id] = { ts: r.ts, powerW: r.powerW, totalEnergyWh: r.totalEnergyWh };
  }
  return { ts: mostRecent, powerW, monitors };
}
