import index from "./pages/index.html";
import room from "./pages/room.html";

import { appendReading, readRooms } from "./lib/data.ts";
import { normalizeShelly } from "./lib/shelly.ts";
import {
  computeSeries,
  computeUsage,
  latestReading,
  type Bucket,
} from "./lib/aggregate.ts";
import type { Reading } from "./lib/types.ts";

const PORT = Number(process.env.PORT ?? 3000);
const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,16}$/;

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

const server = Bun.serve({
  port: PORT,
  development: process.env.NODE_ENV !== "production",

  routes: {
    "/": index,

    "/favicon.ico": () => new Response(null, { status: 204 }),

    "/api/health": () =>
      Response.json({ ok: true, ts: new Date().toISOString() }),

    "/api/rooms": async () => {
      const cfg = await readRooms();
      const out = await Promise.all(
        Object.entries(cfg.rooms).map(async ([id, r]) => {
          const current = r.leases.find((l) => l.endDate === null) ?? null;
          const leaseFrom = current
            ? new Date(current.startDate + "T00:00:00Z")
            : new Date(0);
          const monthFrom = new Date();
          monthFrom.setUTCDate(1);
          monthFrom.setUTCHours(0, 0, 0, 0);
          const now = new Date();

          const [leaseUsage, monthUsage, latest] = await Promise.all([
            computeUsage({ room: id, from: leaseFrom, to: now }),
            computeUsage({ room: id, from: monthFrom, to: now }),
            latestReading(id),
          ]);

          return {
            id,
            label: r.label,
            currentTenant: current?.tenant ?? null,
            leaseStart: current?.startDate ?? null,
            leaseKWh: leaseUsage.energyKWh,
            monthKWh: monthUsage.energyKWh,
            powerW: latest?.powerW ?? null,
            lastSeen: latest?.ts ?? null,
          };
        }),
      );
      return Response.json({ rooms: out });
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
      return Response.json({
        room: { id: roomId, ...r },
        currentLease: current,
        leaseUsage: lease,
        monthUsage: month,
        latest,
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

    "/api/ingest/:roomId": {
      // Modern Shelly NotifyStatus / outbound webhook.
      POST: async (req) => {
        const { roomId } = req.params;
        if (!ROOM_ID_RE.test(roomId)) return badRequest("invalid roomId");
        const cfg = await readRooms();
        if (!cfg.rooms[roomId]) {
          return Response.json({ error: "unknown room" }, { status: 404 });
        }
        let body: unknown = null;
        try {
          body = await req.json();
        } catch {
          // Non-JSON body — try text + querystring fallback.
          body = null;
        }
        const url = new URL(req.url);
        const norm = normalizeShelly(body, url.searchParams);
        const reading: Reading = {
          ts: norm.ts,
          room: roomId,
          channels: norm.channels,
          raw: body ?? undefined,
        };
        await appendReading(reading);
        return Response.json({ ok: true, channels: norm.channels.length });
      },

      // Legacy Shelly Action URL: GET /api/ingest/301?total_act_energy=…&act_power=…&channel=0
      GET: async (req) => {
        const { roomId } = req.params;
        if (!ROOM_ID_RE.test(roomId)) return badRequest("invalid roomId");
        const cfg = await readRooms();
        if (!cfg.rooms[roomId]) {
          return Response.json({ error: "unknown room" }, { status: 404 });
        }
        const url = new URL(req.url);
        const norm = normalizeShelly(null, url.searchParams);
        if (norm.channels.length === 0) {
          return badRequest("no recognizable Shelly fields");
        }
        await appendReading({
          ts: norm.ts,
          room: roomId,
          channels: norm.channels,
          raw: Object.fromEntries(url.searchParams),
        });
        return Response.json({ ok: true });
      },
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

console.log(`5214 dashboard listening on http://${server.hostname}:${server.port}`);
