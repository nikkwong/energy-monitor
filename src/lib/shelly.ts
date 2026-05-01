import type { ChannelReading } from "./types.ts";

/**
 * Normalize a Shelly EM payload into a flat list of channel readings.
 *
 * Shelly EM Mini / Pro EM / Pro 3EM devices can deliver data in several flavors:
 *
 * 1. JSON-RPC `NotifyStatus` (the modern "Webhook" / outbound report):
 *    {
 *      "method": "NotifyStatus",
 *      "params": {
 *        "ts": 1700000000.0,
 *        "em1:0":     { "act_power": 120.5, "voltage": 237.1, ... },
 *        "em1data:0": { "total_act_energy": 12345.67 },
 *        "em1:1":     { ... }, "em1data:1": { ... },
 *        ...
 *      }
 *    }
 *
 * 2. JSON-RPC status response (`/rpc/Shelly.GetStatus` mirrored as a webhook),
 *    which has the same `em1:N` / `em1data:N` keys at the top level.
 *
 * 3. Legacy "Action URL" GET with query params, e.g.
 *      /api/ingest/301?total_act_energy=12345&act_power=120&channel=0
 *    This is what older firmwares post when set up via the "URL action" UI.
 *
 * We accept any of those and return a normalized struct. Unknown shapes still
 * produce an empty channel list — the caller is responsible for storing the
 * raw body so nothing is lost.
 */

export type Normalized = {
  ts: string;
  channels: ChannelReading[];
};

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function tsFromBody(body: unknown): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const params = b["params"] as Record<string, unknown> | undefined;
    const t = num(params?.["ts"]) ?? num(b["ts"]);
    if (t !== undefined) {
      // Shelly reports unix seconds; allow ms too just in case.
      const ms = t > 1e12 ? t : t * 1000;
      return new Date(ms).toISOString();
    }
  }
  return new Date().toISOString();
}

function extractFromKeyed(obj: Record<string, unknown>): ChannelReading[] {
  // Look for em1:N (instantaneous) and em1data:N (cumulative). Also accept
  // em:N variants used by Pro EM (3-phase) where channels are phases.
  const channels = new Map<number, ChannelReading>();

  for (const [key, val] of Object.entries(obj)) {
    if (!val || typeof val !== "object") continue;
    const m = /^em(?:1)?(data)?:(\d+)$/.exec(key);
    if (!m) continue;
    const isData = m[1] === "data";
    const idx = Number(m[2]);
    const v = val as Record<string, unknown>;

    const existing: ChannelReading = channels.get(idx) ?? {
      idx,
      powerW: 0,
      totalEnergyWh: 0,
    };

    if (isData) {
      const total =
        num(v["total_act_energy"]) ??
        num(v["total_energy"]) ??
        num(v["aenergy"]);
      if (total !== undefined) existing.totalEnergyWh = total;
    } else {
      const power = num(v["act_power"]) ?? num(v["power"]);
      if (power !== undefined) existing.powerW = power;
      // Some firmwares put the cumulative counter alongside instantaneous.
      const total =
        num(v["total_act_energy"]) ??
        num(v["total_energy"]) ??
        num(v["aenergy"]);
      if (total !== undefined && existing.totalEnergyWh === 0) {
        existing.totalEnergyWh = total;
      }
    }

    channels.set(idx, existing);
  }

  return [...channels.values()].sort((a, b) => a.idx - b.idx);
}

export function normalizeShelly(
  body: unknown,
  query: URLSearchParams,
): Normalized {
  const ts = tsFromBody(body);
  let channels: ChannelReading[] = [];

  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const params = (b["params"] as Record<string, unknown> | undefined) ?? b;
    channels = extractFromKeyed(params);
  }

  if (channels.length === 0) {
    // Legacy GET-style action URL.
    const total = num(query.get("total_act_energy") ?? query.get("total_energy"));
    const power = num(query.get("act_power") ?? query.get("power"));
    const idx = num(query.get("channel")) ?? 0;
    if (total !== undefined || power !== undefined) {
      channels = [
        {
          idx,
          powerW: power ?? 0,
          totalEnergyWh: total ?? 0,
        },
      ];
    }
  }

  return { ts, channels };
}
