import { iterReadings } from "./data.ts";
import type { Reading } from "./types.ts";

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
  /** kWh per channel index. */
  channels: Record<number, number>;
};

export type LatestReading = {
  ts: string;
  /** Sum of instantaneous power across all channels, in watts. */
  powerW: number;
  /** Per-channel snapshot. */
  channels: Array<{ idx: number; powerW: number; totalEnergyWh: number }>;
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

/**
 * Pulls every reading for `room` (or all rooms if undefined), sorted by ts.
 * For our scale (hundreds of readings/day per room) this is fine. If the
 * stream grows past ~10MB we should switch to monthly shards.
 */
async function loadSorted(room?: string): Promise<Reading[]> {
  const out: Reading[] = [];
  for await (const r of iterReadings()) {
    if (room && r.room !== room) continue;
    out.push(r);
  }
  out.sort((a, b) => a.ts.localeCompare(b.ts));
  return out;
}

/**
 * Compute kWh consumed in [from, to) by walking the cumulative-energy counter
 * delta on each channel. We trust the meter's monotonic counter and ignore
 * negative deltas (which would indicate a meter reset or out-of-order report).
 *
 * The delta from reading N-1 -> N is attributed to N's timestamp. That's a
 * standard convention and lines up with how the meter "reports" newly-accrued
 * energy.
 */
export async function computeUsage(opts: {
  room?: string;
  from: Date;
  to: Date;
}): Promise<UsageSummary> {
  const readings = await loadSorted(opts.room);
  const last: Map<string, number> = new Map(); // key: room|ch
  const channels: Record<number, number> = {};
  let totalKWh = 0;

  const fromMs = opts.from.getTime();
  const toMs = opts.to.getTime();

  for (const r of readings) {
    const tsMs = new Date(r.ts).getTime();
    for (const ch of r.channels) {
      const key = `${r.room}|${ch.idx}`;
      const prev = last.get(key);
      last.set(key, ch.totalEnergyWh);
      if (prev === undefined) continue;
      const delta = ch.totalEnergyWh - prev;
      if (delta <= 0) continue;
      if (tsMs < fromMs || tsMs >= toMs) continue;
      const kwh = delta / 1000;
      totalKWh += kwh;
      channels[ch.idx] = (channels[ch.idx] ?? 0) + kwh;
    }
  }

  return {
    from: opts.from.toISOString(),
    to: opts.to.toISOString(),
    energyKWh: totalKWh,
    channels,
  };
}

export async function computeSeries(opts: {
  room?: string;
  from: Date;
  to: Date;
  bucket: Bucket;
}): Promise<SeriesPoint[]> {
  const readings = await loadSorted(opts.room);
  const last: Map<string, number> = new Map();
  const buckets = new Map<number, number>(); // bucket-start-ms -> kWh

  const fromMs = opts.from.getTime();
  const toMs = opts.to.getTime();

  for (const r of readings) {
    const ts = new Date(r.ts);
    const tsMs = ts.getTime();
    for (const ch of r.channels) {
      const key = `${r.room}|${ch.idx}`;
      const prev = last.get(key);
      last.set(key, ch.totalEnergyWh);
      if (prev === undefined) continue;
      const delta = ch.totalEnergyWh - prev;
      if (delta <= 0) continue;
      if (tsMs < fromMs || tsMs >= toMs) continue;
      const bucketKey = bucketStartUTC(ts, opts.bucket).getTime();
      buckets.set(bucketKey, (buckets.get(bucketKey) ?? 0) + delta / 1000);
    }
  }

  // Fill empty buckets so the chart line is continuous.
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
  let latest: Reading | null = null;
  for await (const r of iterReadings()) {
    if (r.room !== room) continue;
    if (!latest || r.ts > latest.ts) latest = r;
  }
  if (!latest) return null;
  return {
    ts: latest.ts,
    powerW: latest.channels.reduce((s, c) => s + (c.powerW || 0), 0),
    channels: latest.channels.map((c) => ({
      idx: c.idx,
      powerW: c.powerW,
      totalEnergyWh: c.totalEnergyWh,
    })),
  };
}
