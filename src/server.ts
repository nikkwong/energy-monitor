import index from "./pages/index.html";
import room from "./pages/room.html";
import debug from "./pages/debug.html";

import {
  appendReading,
  deleteRoom,
  deleteMonitor,
  endCurrentLease,
  ensureRoomAndMonitor,
  LeaseError,
  readRooms,
  startLease,
} from "./lib/data.ts";
import {
  DEFAULT_MONITOR_ID,
  filterMonitorRecord,
  roomUsesNamedMonitors,
  sanitizeRoom,
} from "./lib/monitors.ts";
import { normalizeShelly } from "./lib/shelly.ts";
import { recentTraffic, recordTraffic, requestMeta } from "./lib/debug.ts";
import {
  computeAllRoomSummaries,
  computeSeries,
  computeUsage,
  latestReading,
  type Bucket,
} from "./lib/aggregate.ts";
import type { Reading, Room } from "./lib/types.ts";

const PORT = Number(process.env.PORT ?? 3000);
const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,16}$/;
const MONITOR_ID_RE = /^[A-Za-z0-9_-]{1,16}$/;

function badRequest(msg: string): Response {
  return Response.json({ error: msg }, { status: 400 });
}

function parseDate(v: string | null, fallback: Date): Date {
  if (!v) return fallback;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

function parseBucket(v: string | null): Bucket {
  if (v === "hour" || v === "day" || v === "month") return v;
  return "day";
}

function monitorList(r: Room): string[] {
  if (r.monitors && Object.keys(r.monitors).length > 0) {
    return Object.keys(r.monitors);
  }
  return [DEFAULT_MONITOR_ID];
}

const server = Bun.serve({
  port: PORT,
  development: process.env.NODE_ENV !== "production",

  routes: {
    "/": index,

    "/favicon.ico": () => new Response(null, { status: 204 }),

    "/debug": debug,

    "/api/health": () =>
      Response.json({ ok: true, ts: new Date().toISOString() }),

    "/api/debug/traffic": () =>
      Response.json({
        now: new Date().toISOString(),
        traffic: recentTraffic(),
      }),

    // Raw `data/rooms.json` for at-a-glance audit (auto-registered entries,
    // typo'd monitor names, lease history). Pretty-printed via the same
    // serialization the on-disk file uses, so what you see is what's saved.
    "/api/config/rooms": async () => {
      const cfg = await readRooms();
      return new Response(JSON.stringify(cfg, null, 2) + "\n", {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    },

    "/api/rooms": async () => {
      const cfg = await readRooms();
      const now = new Date();
      const summaries = await computeAllRoomSummaries(cfg, now);

      const out = Object.entries(cfg.rooms).map(([id, r]) => {
        const current = r.leases.find((l) => l.endDate === null) ?? null;
        const s = summaries.get(id)!;
        return {
          id,
          label: r.label,
          currentTenant: current?.tenant ?? null,
          leaseStart: current?.startDate ?? null,
          leaseKWh: s.leaseKWh,
          monthKWh: s.monthKWh,
          powerW: s.powerW,
          lastSeen: s.lastSeen,
          monitors: monitorList(r),
        };
      });
      return Response.json({ rooms: out });
    },

    // Operator-only: hide a room from the dashboard. Removes the entry from
    // rooms.json; historical readings stay on disk but the aggregator filters
    // them out. If the device is still POSTing to this id, it'll auto-register
    // on its next POST — that's by design (the Shellys are the source of
    // truth) but the operator should turn off / re-flash the device first if
    // they don't want the room to come back.
    "/api/rooms/:roomId": {
      DELETE: async (req) => {
        const { roomId } = req.params;
        if (!ROOM_ID_RE.test(roomId)) return badRequest("invalid roomId");
        const removed = await deleteRoom(roomId);
        if (!removed) {
          return Response.json({ error: "no such room" }, { status: 404 });
        }
        console.log(`deleted room ${roomId}`);
        return Response.json({ ok: true, deleted: roomId });
      },
    },

    "/api/rooms/:roomId/leases": {
      POST: async (req) => {
        const { roomId } = req.params;
        if (!ROOM_ID_RE.test(roomId)) return badRequest("invalid roomId");
        let body: { tenant?: unknown; startDate?: unknown };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return badRequest("expected JSON body");
        }
        if (typeof body.tenant !== "string" || typeof body.startDate !== "string") {
          return badRequest("tenant and startDate are required");
        }
        try {
          const lease = await startLease(roomId, body.tenant, body.startDate);
          console.log(`started lease ${lease.id} for room ${roomId}`);
          return Response.json({ ok: true, lease });
        } catch (err) {
          if (err instanceof LeaseError) {
            return Response.json({ error: err.message }, { status: err.status });
          }
          throw err;
        }
      },
    },

    "/api/rooms/:roomId/leases/current/end": {
      POST: async (req) => {
        const { roomId } = req.params;
        if (!ROOM_ID_RE.test(roomId)) return badRequest("invalid roomId");
        let endDate: string | undefined;
        try {
          const body = (await req.json()) as { endDate?: unknown };
          if (body.endDate != null) {
            if (typeof body.endDate !== "string") return badRequest("endDate must be a string");
            endDate = body.endDate;
          }
        } catch {
          // Empty body — default end date to today.
        }
        try {
          const lease = await endCurrentLease(roomId, endDate);
          console.log(`ended lease ${lease.id} for room ${roomId}`);
          return Response.json({ ok: true, lease });
        } catch (err) {
          if (err instanceof LeaseError) {
            return Response.json({ error: err.message }, { status: err.status });
          }
          throw err;
        }
      },
    },

    "/api/rooms/:roomId/monitors/:monitorId": {
      DELETE: async (req) => {
        const { roomId, monitorId } = req.params;
        if (!ROOM_ID_RE.test(roomId)) return badRequest("invalid roomId");
        if (!MONITOR_ID_RE.test(monitorId)) return badRequest("invalid monitorId");
        const removed = await deleteMonitor(roomId, monitorId);
        if (!removed) {
          return Response.json({ error: "no such monitor" }, { status: 404 });
        }
        console.log(`deleted monitor ${roomId}/${monitorId}`);
        return Response.json({ ok: true, deleted: { roomId, monitorId } });
      },
    },

    "/api/rooms/:roomId/usage": async (req) => {
      const { roomId } = req.params;
      if (!ROOM_ID_RE.test(roomId)) return badRequest("invalid roomId");
      const url = new URL(req.url);
      const cfg = await readRooms();
      const r = cfg.rooms[roomId];
      if (!r) return Response.json({ error: "no such room" }, { status: 404 });
      const current = r.leases.find((l) => l.endDate === null) ?? null;
      const leaseFrom = current
        ? new Date(current.startDate + "T00:00:00Z")
        : new Date(0);
      const monthFrom = new Date();
      monthFrom.setUTCDate(1);
      monthFrom.setUTCHours(0, 0, 0, 0);
      const now = parseDate(url.searchParams.get("to"), new Date());
      const [lease, month, latest] = await Promise.all([
        computeUsage({ room: roomId, from: leaseFrom, to: now }),
        computeUsage({ room: roomId, from: monthFrom, to: now }),
        latestReading(roomId),
      ]);
      const roomOut = sanitizeRoom({ id: roomId, ...r });
      const latestOut = latest
        ? {
            ...latest,
            monitors: filterMonitorRecord(latest.monitors, roomOut),
            powerW: Object.values(filterMonitorRecord(latest.monitors, roomOut)).reduce(
              (s, m) => s + (m.powerW || 0),
              0,
            ),
          }
        : null;
      return Response.json({
        room: roomOut,
        currentLease: current,
        leaseUsage: {
          ...lease,
          monitors: filterMonitorRecord(lease.monitors, roomOut),
        },
        monthUsage: {
          ...month,
          monitors: filterMonitorRecord(month.monitors, roomOut),
        },
        latest: latestOut,
      });
    },

    "/api/rooms/:roomId/series": async (req) => {
      const { roomId } = req.params;
      if (!ROOM_ID_RE.test(roomId)) return badRequest("invalid roomId");
      const url = new URL(req.url);
      const to = parseDate(url.searchParams.get("to"), new Date());
      const defaultFrom = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
      const from = parseDate(url.searchParams.get("from"), defaultFrom);
      const bucket = parseBucket(url.searchParams.get("bucket"));
      const series = await computeSeries({ room: roomId, from, to, bucket });
      return Response.json({ from: from.toISOString(), to: to.toISOString(), bucket, series });
    },

    "/api/series": async (req) => {
      const url = new URL(req.url);
      const to = parseDate(url.searchParams.get("to"), new Date());
      const defaultFrom = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
      const from = parseDate(url.searchParams.get("from"), defaultFrom);
      const bucket = parseBucket(url.searchParams.get("bucket"));
      const series = await computeSeries({ from, to, bucket });
      return Response.json({ from: from.toISOString(), to: to.toISOString(), bucket, series });
    },

    // Multi-monitor ingest. Each physical Shelly in a room POSTs to its own
    // monitor path so per-device cumulative counters don't trample each other.
    "/api/ingest/:roomId/:monitorId": {
      POST: (req) => ingest(req, req.params.roomId, req.params.monitorId, "POST"),
      GET: (req) => ingest(req, req.params.roomId, req.params.monitorId, "GET"),
    },

    // Single-monitor shorthand: equivalent to /api/ingest/:roomId/default.
    // Old Shelly devices that haven't been re-flashed with MONITOR_ID still work.
    "/api/ingest/:roomId": {
      POST: (req) => ingest(req, req.params.roomId, DEFAULT_MONITOR_ID, "POST"),
      GET: (req) => ingest(req, req.params.roomId, DEFAULT_MONITOR_ID, "GET"),
    },

    // Single-segment paths render the room page; the client reads the path
    // and fetches /api/rooms/:roomId/usage, which 404s gracefully for unknown rooms.
    "/:roomId": room,
  },

  error(err) {
    console.error(err);
    return new Response("internal error", { status: 500 });
  },
});

async function ingest(
  req: Request,
  roomId: string,
  monitorId: string,
  method: "POST" | "GET",
): Promise<Response> {
  const meta = requestMeta(req);
  const baseDebug = {
    ...meta,
    roomId,
    monitorId,
  };

  if (!ROOM_ID_RE.test(roomId)) {
    recordTraffic({
      ...baseDebug,
      status: 400,
      message: "invalid roomId",
    });
    return badRequest("invalid roomId");
  }
  if (!MONITOR_ID_RE.test(monitorId)) {
    recordTraffic({
      ...baseDebug,
      status: 400,
      message: "invalid monitorId",
    });
    return badRequest("invalid monitorId");
  }

  let body: unknown = null;
  let bodyParseOk: boolean | undefined;
  if (method === "POST") {
    try {
      body = await req.json();
      bodyParseOk = true;
    } catch {
      bodyParseOk = false;
      // Non-JSON body — we'll fall through to the querystring extractor below.
    }
  }

  const url = new URL(req.url);
  const norm = normalizeShelly(body, url.searchParams);
  const normalized = {
    hasReading: norm.hasReading,
    powerW: norm.powerW,
    totalEnergyWh: norm.totalEnergyWh,
    ts: norm.ts,
    ip: norm.ip,
  };

  if (!norm.hasReading) {
    recordTraffic({
      ...baseDebug,
      status: 400,
      message: "no recognizable Shelly fields",
      bodyParseOk,
      normalized,
    });
    return badRequest("no recognizable Shelly fields");
  }

  const cfg = await readRooms();
  const room = cfg.rooms[roomId];
  if (monitorId === DEFAULT_MONITOR_ID && roomUsesNamedMonitors(room)) {
    recordTraffic({
      ...baseDebug,
      status: 400,
      message: "default monitor rejected for named-monitor room",
      bodyParseOk,
      normalized,
    });
    return Response.json(
      {
        error:
          `room ${roomId} uses named monitors; POST to /api/ingest/${roomId}/<monitorId> instead`,
      },
      { status: 400 },
    );
  }

  // Auto-register: the Shelly is the source of truth for "what (room, monitor)
  // pairs exist". Operators add lease history and friendly labels by editing
  // rooms.json after the fact — those edits stick because this only fills in
  // missing entries. The device's self-reported LAN IP is *also* refreshed
  // here on every POST so dashboard links follow DHCP renewals.
  const { newRoom, newMonitor } = await ensureRoomAndMonitor(
    roomId,
    monitorId,
    norm.ip ? { ip: norm.ip } : undefined,
  );
  if (newRoom || newMonitor) {
    const what = newRoom ? "room+monitor" : "monitor";
    const tail = norm.ip ? ` (ip ${norm.ip})` : "";
    console.log(`auto-registered ${what} ${roomId}/${monitorId}${tail}`);
  }

  const reading: Reading = {
    ts: norm.ts,
    room: roomId,
    monitor: monitorId,
    powerW: norm.powerW,
    totalEnergyWh: norm.totalEnergyWh,
    raw: body ?? Object.fromEntries(url.searchParams),
  };
  await appendReading(reading);
  recordTraffic({
    ...baseDebug,
    status: 200,
    message: "stored reading",
    bodyParseOk,
    normalized,
    autoRegistered: { newRoom, newMonitor },
  });
  return Response.json({ ok: true });
}

console.log(`5214 dashboard listening on http://${server.hostname}:${server.port}`);
