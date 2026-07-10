/**
 * Normalize a Shelly EM payload into a flat (power, energy) tuple.
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
 *      /api/ingest/301/south?total_act_energy=12345&act_power=120
 *    This is what older firmwares post when set up via the "URL action" UI.
 *
 * Multi-channel devices (Pro EM, Pro 3EM) report several `em1:N` keys per
 * payload. Since we treat one Shelly = one monitor, we sum the channels into
 * a single tuple. For an EM Mini Gen4 (the supported case) that's a sum of
 * one. If you want per-channel attribution from a multi-channel device, run
 * one Shelly script per channel with its own `MONITOR_ID`.
 */

export type Normalized = {
  ts: string;
  /** Sum of `act_power` across all reported channels, in watts. */
  powerW: number;
  /** Sum of `total_act_energy` across all reported channels, in watt-hours. */
  totalEnergyWh: number;
  /** True if any recognizable em*-shaped fields were found in the payload. */
  hasReading: boolean;
  /** LAN IP the device self-reported (from `wifi.sta_ip`), if any. */
  ip?: string;
  /** True when the payload included a controllable Shelly switch component. */
  hasSwitch: boolean;
  /** Last reported relay output state for switch-capable devices. */
  switchOutput?: boolean;
};

/** IPv4 dotted-quad sanity check. We don't care about exact validity — just
 *  that what came in over the wire is plausible enough to put behind an
 *  `<a href="http://...">`. Trims trailing whitespace, rejects anything else. */
function plausibleIp(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(s)) return undefined;
  return s;
}

function ipFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  // Prefer params.wifi.sta_ip (NotifyStatus shape), fall back to top-level.
  const params = b["params"] as Record<string, unknown> | undefined;
  const wifi =
    (params?.["wifi"] as Record<string, unknown> | undefined) ??
    (b["wifi"] as Record<string, unknown> | undefined);
  if (!wifi) return undefined;
  return plausibleIp(wifi["sta_ip"]);
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function energyTotal(v: Record<string, unknown>): number | undefined {
  const aenergy = v["aenergy"] as Record<string, unknown> | undefined;
  const direct =
    num(v["total_act_energy"]) ??
    num(v["total_energy"]) ??
    num(v["aenergy"]) ??
    num(aenergy?.["total"]) ??
    num(v["total_act"]);
  if (direct !== undefined) return direct;

  const phases = [
    num(v["a_total_act_energy"]),
    num(v["b_total_act_energy"]),
    num(v["c_total_act_energy"]),
  ];
  let sum = 0;
  let seen = false;
  for (const p of phases) {
    if (p === undefined) continue;
    sum += p;
    seen = true;
  }
  return seen ? sum : undefined;
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

type Acc = {
  powerW: number;
  totalEnergyWh: number;
  seen: boolean;
  hasSwitch: boolean;
  switchOutput?: boolean;
};

function accumulateKeyed(obj: Record<string, unknown>, acc: Acc): void {
  // em1:N (instantaneous, single-phase per-channel), em1data:N (cumulative),
  // em:N (Pro 3EM 3-phase aggregate), emdata:N (its cumulative companion),
  // pm1:N / switch:N (Shelly 1PM / outlet-style metering).
  for (const [key, val] of Object.entries(obj)) {
    if (!val || typeof val !== "object") continue;
    const m = /^(?:(em(?:1)?)(data)?|pm1|switch):(\d+)$/.exec(key);
    if (!m) continue;
    const component = m[1] ?? key.split(":")[0];
    const isData = m[2] === "data";
    const v = val as Record<string, unknown>;
    if (component === "switch") {
      acc.hasSwitch = true;
      if (typeof v["output"] === "boolean") acc.switchOutput = v["output"];
    }

    if (isData) {
      const total = energyTotal(v);
      if (total !== undefined) {
        acc.totalEnergyWh += total;
        acc.seen = true;
      }
    } else {
      const power = num(v["act_power"]) ?? num(v["apower"]) ?? num(v["power"]);
      if (power !== undefined) {
        acc.powerW += power;
        acc.seen = true;
      }
      // Some firmwares put the cumulative counter alongside instantaneous;
      // only pull it from here if there's no companion em*data:N (rare).
      const total = energyTotal(v);
      const companionKey =
        component === "em1"
          ? key.replace(/^em1:/, "em1data:")
          : component === "em"
            ? key.replace(/^em:/, "emdata:")
            : "";
      if (total !== undefined && !(companionKey in obj)) {
        acc.totalEnergyWh += total;
        acc.seen = true;
      }
    }
  }
}

export function normalizeShelly(
  body: unknown,
  query: URLSearchParams,
): Normalized {
  const ts = tsFromBody(body);
  const acc: Acc = { powerW: 0, totalEnergyWh: 0, seen: false, hasSwitch: false };

  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const params = (b["params"] as Record<string, unknown> | undefined) ?? b;
    accumulateKeyed(params, acc);
  }

  if (!acc.seen) {
    // Legacy GET-style action URL.
    const total = num(query.get("total_act_energy") ?? query.get("total_energy"));
    const power = num(query.get("act_power") ?? query.get("power"));
    if (total !== undefined) {
      acc.totalEnergyWh = total;
      acc.seen = true;
    }
    if (power !== undefined) {
      acc.powerW = power;
      acc.seen = true;
    }
  }

  return {
    ts,
    powerW: acc.powerW,
    totalEnergyWh: acc.totalEnergyWh,
    hasReading: acc.seen,
    ip: ipFromBody(body),
    hasSwitch: acc.hasSwitch,
    switchOutput: acc.switchOutput,
  };
}
