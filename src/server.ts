import index from "./pages/index.html";
import room from "./pages/room.html";
import rawReadings from "./pages/raw.html";
import debug from "./pages/debug.html";

import {
  appendReading,
  deleteRoom,
  deleteMonitor,
  endCurrentLease,
  ensureRoomAndMonitor,
  findCurrentLease,
  LeaseError,
  type LeaseInput,
  MonitorSwitchError,
  readRooms,
  recentReadings,
  saveRoomLeases,
  setLeaseEmail,
  setMonitorSwitchDesired,
  setRoomModalities,
  startLease,
} from "./lib/data.ts";
import {
  DEFAULT_MONITOR_ID,
  filterMonitorRecord,
  normalizeRoomModalities,
  roomUsesNamedMonitors,
  sanitizeRoom,
} from "./lib/monitors.ts";
import { normalizeShelly } from "./lib/shelly.ts";
import { recentTraffic, recordTraffic, requestMeta } from "./lib/debug.ts";
import {
  computeAllRoomSummaries,
  computeMonthlyBills,
  computeSeries,
  computeUsage,
  emptySeries,
  latestReading,
  type Bucket,
} from "./lib/aggregate.ts";
import type { Reading, Room } from "./lib/types.ts";
import {
  getTenant,
  loadTenantsConfig,
  TENANT_ID_RE,
  type TenantConfig,
} from "./lib/tenants.ts";

const PORT = Number(process.env.PORT ?? 3000);
// Unicode room/monitor ids are OK (e.g. Chinese room labels). Keep slashes,
// spaces, and punctuation out so ids remain safe path segments.
const ROOM_ID_RE = /^[\p{L}\p{N}_-]{1,32}$/u;
const MONITOR_ID_RE = /^[\p{L}\p{N}_-]{1,32}$/u;

class RouteError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function requireTenantConfig(tenantId: string): Promise<TenantConfig> {
  if (!TENANT_ID_RE.test(tenantId)) throw new RouteError("invalid tenantId", 400);
  const tenant = await getTenant(tenantId);
  if (!tenant) throw new RouteError("no such tenant", 404);
  return tenant;
}

async function requirePowerTenant(tenantId: string): Promise<TenantConfig> {
  const tenant = await requireTenantConfig(tenantId);
  if (!tenant.modalities.power) throw new RouteError("power monitoring is disabled", 404);
  return tenant;
}

async function requireAnyModalityTenant(tenantId: string): Promise<TenantConfig> {
  const tenant = await requireTenantConfig(tenantId);
  if (!tenant.modalities.power && !tenant.modalities.water) {
    throw new RouteError("no monitoring modalities are enabled", 404);
  }
  return tenant;
}

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

async function updateRoomModalities(
  req: Request & { params: { tenantId: string; roomId: string } },
): Promise<Response> {
  const { tenantId, roomId } = req.params;
  await requireTenantConfig(tenantId);
  if (!ROOM_ID_RE.test(roomId)) return badRequest("invalid roomId");
  let body: { power?: unknown; water?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return badRequest("expected JSON body");
  }
  if (!body || typeof body !== "object") return badRequest("expected JSON object");
  if (body.power !== undefined && typeof body.power !== "boolean") {
    return badRequest("power must be a boolean");
  }
  if (body.water !== undefined && typeof body.water !== "boolean") {
    return badRequest("water must be a boolean");
  }
  if (body.power === undefined && body.water === undefined) {
    return badRequest("power or water boolean is required");
  }
  try {
    const modalities = await setRoomModalities(tenantId, roomId, {
      power: body.power,
      water: body.water,
    });
    console.log(
      `updated modalities for room ${tenantId}/${roomId}: power=${modalities.power}, water=${modalities.water}`,
    );
    return Response.json({ ok: true, modalities });
  } catch (err) {
    if (err instanceof LeaseError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}

async function updateLeaseEmail(
  req: Request & { params: { tenantId: string; roomId: string; leaseId: string } },
): Promise<Response> {
  const { tenantId, roomId, leaseId } = req.params;
  await requireTenantConfig(tenantId);
  if (!ROOM_ID_RE.test(roomId)) return badRequest("invalid roomId");
  if (!leaseId || leaseId.length > 128 || leaseId.includes("/")) {
    return badRequest("invalid leaseId");
  }
  let body: { email?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return badRequest("expected JSON body");
  }
  if (!body || typeof body !== "object") return badRequest("expected JSON object");
  if (body.email !== null && typeof body.email !== "string") {
    return badRequest("email must be a string or null");
  }
  try {
    const lease = await setLeaseEmail(tenantId, roomId, leaseId, body.email);
    console.log(
      `updated email for lease ${tenantId}/${roomId}/${leaseId}: ${lease.email ?? "(cleared)"}`,
    );
    return Response.json({ ok: true, lease });
  } catch (err) {
    if (err instanceof LeaseError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}

await loadTenantsConfig();

const server = Bun.serve({
  port: PORT,
  development: process.env.NODE_ENV !== "production",

  routes: {
    "/": async () => {
      const cfg = await loadTenantsConfig();
      return Response.redirect(`/${encodeURIComponent(cfg.defaultTenantId)}`, 302);
    },

    "/favicon.ico": () => new Response(null, { status: 204 }),

    "/debug": debug,

    "/api/health": () =>
      Response.json({ ok: true, ts: new Date().toISOString() }),

    "/api/debug/traffic": () =>
      Response.json({
        now: new Date().toISOString(),
        traffic: recentTraffic(),
      }),

    // Raw tenant `rooms.json` for at-a-glance audit (auto-registered entries,
    // typo'd monitor names, lease history). Pretty-printed via the same
    // serialization the on-disk file uses, so what you see is what's saved.
    "/api/tenants/:tenantId/config": async (req) => {
      const tenant = await requireTenantConfig(req.params.tenantId);
      return Response.json(tenant);
    },

    "/api/tenants/:tenantId/config/rooms": async (req) => {
      const { tenantId } = req.params;
      await requireAnyModalityTenant(tenantId);
      const cfg = await readRooms(tenantId);
      return new Response(JSON.stringify(cfg, null, 2) + "\n", {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    },

    "/api/tenants/:tenantId/rooms": async (req) => {
      const { tenantId } = req.params;
      const tenant = await requireAnyModalityTenant(tenantId);
      const url = new URL(req.url);
      const cfg = await readRooms(tenantId);
      const now = new Date();
      const rawTodayFrom = url.searchParams.get("todayFrom");
      const todayFrom = rawTodayFrom ? parseDate(rawTodayFrom, now) : undefined;
      const summaries = tenant.modalities.power
        ? await computeAllRoomSummaries(tenantId, cfg, now, todayFrom)
        : null;

      const out = Object.entries(cfg.rooms).map(([id, r]) => {
        const current = findCurrentLease(r.leases, now);
        const roomModalities = normalizeRoomModalities(r.modalities);
        const s = summaries?.get(id);
        return {
          id,
          label: r.label,
          modalities: {
            power: tenant.modalities.power && roomModalities.power,
            water: tenant.modalities.water && roomModalities.water,
          },
          currentTenant: current?.tenant ?? null,
          leaseStart: current?.startDate ?? null,
          leaseKWh: s?.leaseKWh ?? 0,
          monthKWh: s?.monthKWh ?? 0,
          todayKWh: s?.todayKWh ?? 0,
          dayKWh: s?.dayKWh ?? 0,
          weekKWh: s?.weekKWh ?? 0,
          thirtyDayKWh: s?.thirtyDayKWh ?? 0,
          allTimeKWh: s?.allTimeKWh ?? 0,
          powerW: s?.powerW ?? null,
          lastSeen: s?.lastSeen ?? null,
          leaseWaterGal: 0,
          monthWaterGal: 0,
          todayWaterGal: 0,
          dayWaterGal: 0,
          weekWaterGal: 0,
          thirtyDayWaterGal: 0,
          allTimeWaterGal: 0,
          flowGpm: null as number | null,
          waterLastSeen: null as string | null,
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
    "/api/tenants/:tenantId/rooms/:roomId": {
      DELETE: async (req) => {
        const { tenantId, roomId } = req.params;
        await requireAnyModalityTenant(tenantId);
        if (!ROOM_ID_RE.test(roomId)) return badRequest("invalid roomId");
        const removed = await deleteRoom(tenantId, roomId);
        if (!removed) {
          return Response.json({ error: "no such room" }, { status: 404 });
        }
        console.log(`deleted room ${roomId}`);
        return Response.json({ ok: true, deleted: roomId });
      },
    },

    "/api/tenants/:tenantId/rooms/:roomId/modalities": {
      POST: async (req) => updateRoomModalities(req),
      PATCH: async (req) => updateRoomModalities(req),
    },

    "/api/tenants/:tenantId/rooms/:roomId/leases": {
      POST: async (req) => {
        const { tenantId, roomId } = req.params;
        await requireTenantConfig(tenantId);
        if (!ROOM_ID_RE.test(roomId)) return badRequest("invalid roomId");
        let body: { tenant?: unknown; startDate?: unknown; endDate?: unknown };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return badRequest("expected JSON body");
        }
        if (typeof body.startDate !== "string") {
          return badRequest("startDate is required");
        }
        if (body.tenant != null && typeof body.tenant !== "string") {
          return badRequest("tenant must be a string");
        }
        if (body.endDate != null && typeof body.endDate !== "string") {
          return badRequest("endDate must be a string");
        }
        try {
          const lease = await startLease(
            tenantId,
            roomId,
            typeof body.tenant === "string" ? body.tenant : "",
            body.startDate,
            typeof body.endDate === "string" ? body.endDate : null,
          );
          console.log(`started lease ${lease.id} for room ${roomId}`);
          return Response.json({ ok: true, lease });
        } catch (err) {
          if (err instanceof LeaseError) {
            return Response.json({ error: err.message }, { status: err.status });
          }
          throw err;
        }
      },
      PUT: async (req) => {
        const { tenantId, roomId } = req.params;
        await requireTenantConfig(tenantId);
        if (!ROOM_ID_RE.test(roomId)) return badRequest("invalid roomId");
        let body: { leases?: unknown };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return badRequest("expected JSON body");
        }
        if (!Array.isArray(body.leases)) {
          return badRequest("leases must be an array");
        }
        const inputs: LeaseInput[] = [];
        for (const item of body.leases) {
          if (!item || typeof item !== "object") {
            return badRequest("each lease must be an object");
          }
          const rec = item as Record<string, unknown>;
          if (typeof rec.startDate !== "string") {
            return badRequest("each lease requires startDate");
          }
          if (rec.endDate != null && typeof rec.endDate !== "string") {
            return badRequest("endDate must be a string or null");
          }
          if (rec.id != null && typeof rec.id !== "string") {
            return badRequest("id must be a string");
          }
          if (rec.tenant != null && typeof rec.tenant !== "string") {
            return badRequest("tenant must be a string");
          }
          if (rec.email != null && typeof rec.email !== "string") {
            return badRequest("email must be a string or null");
          }
          inputs.push({
            id: typeof rec.id === "string" ? rec.id : undefined,
            tenant: typeof rec.tenant === "string" ? rec.tenant : undefined,
            email:
              rec.email === undefined
                ? undefined
                : typeof rec.email === "string"
                  ? rec.email
                  : null,
            startDate: rec.startDate,
            endDate: typeof rec.endDate === "string" ? rec.endDate : null,
          });
        }
        try {
          const leases = await saveRoomLeases(tenantId, roomId, inputs);
          console.log(`updated leases (${leases.length}) for room ${roomId}`);
          return Response.json({ ok: true, leases });
        } catch (err) {
          if (err instanceof LeaseError) {
            return Response.json({ error: err.message }, { status: err.status });
          }
          throw err;
        }
      },
    },

    "/api/tenants/:tenantId/rooms/:roomId/leases/:leaseId/email": {
      POST: async (req) => updateLeaseEmail(req),
      PATCH: async (req) => updateLeaseEmail(req),
    },

    "/api/tenants/:tenantId/rooms/:roomId/leases/current/end": {
      POST: async (req) => {
        const { tenantId, roomId } = req.params;
        await requireTenantConfig(tenantId);
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
          const lease = await endCurrentLease(tenantId, roomId, endDate);
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

    "/api/tenants/:tenantId/rooms/:roomId/monitors/:monitorId": {
      DELETE: async (req) => {
        const { tenantId, roomId, monitorId } = req.params;
        await requirePowerTenant(tenantId);
        if (!ROOM_ID_RE.test(roomId)) return badRequest("invalid roomId");
        if (!MONITOR_ID_RE.test(monitorId)) return badRequest("invalid monitorId");
        const removed = await deleteMonitor(tenantId, roomId, monitorId);
        if (!removed) {
          return Response.json({ error: "no such monitor" }, { status: 404 });
        }
        console.log(`deleted monitor ${roomId}/${monitorId}`);
        return Response.json({ ok: true, deleted: { roomId, monitorId } });
      },
    },

    "/api/tenants/:tenantId/rooms/:roomId/monitors/:monitorId/switch": {
      POST: async (req) => {
        const { tenantId, roomId, monitorId } = req.params;
        await requirePowerTenant(tenantId);
        if (!ROOM_ID_RE.test(roomId)) return badRequest("invalid roomId");
        if (!MONITOR_ID_RE.test(monitorId)) return badRequest("invalid monitorId");
        let body: { output?: unknown };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return badRequest("expected JSON body");
        }
        if (typeof body.output !== "boolean") return badRequest("output must be a boolean");
        try {
          const monitor = await setMonitorSwitchDesired(
            tenantId,
            roomId,
            monitorId,
            body.output,
          );
          console.log(`queued switch ${roomId}/${monitorId} -> ${body.output ? "on" : "off"}`);
          return Response.json({ ok: true, monitor });
        } catch (err) {
          if (err instanceof MonitorSwitchError) {
            return Response.json({ error: err.message }, { status: err.status });
          }
          throw err;
        }
      },
    },

    "/api/tenants/:tenantId/rooms/:roomId/usage": async (req) => {
      const { tenantId, roomId } = req.params;
      const tenant = await requireTenantConfig(tenantId);
      if (!ROOM_ID_RE.test(roomId)) return badRequest("invalid roomId");
      const url = new URL(req.url);
      const cfg = await readRooms(tenantId);
      const r = cfg.rooms[roomId];
      if (!r) return Response.json({ error: "no such room" }, { status: 404 });
      const now = parseDate(url.searchParams.get("to"), new Date());
      const current = findCurrentLease(r.leases, now);
      const leaseFrom = current
        ? new Date(current.startDate + "T00:00:00Z")
        : new Date(0);
      const monthFrom = new Date();
      monthFrom.setUTCDate(1);
      monthFrom.setUTCHours(0, 0, 0, 0);
      const defaultTodayFrom = new Date(now);
      defaultTodayFrom.setUTCHours(0, 0, 0, 0);
      const todayFrom = parseDate(url.searchParams.get("todayFrom"), defaultTodayFrom);
      const roomOut = sanitizeRoom({ id: roomId, ...r });
      const powerActive = tenant.modalities.power && roomOut.modalities.power;
      const zeroUsage = (from: Date) => ({
        from: from.toISOString(),
        to: now.toISOString(),
        energyKWh: 0,
        monitors: {} as Record<string, number>,
      });
      const [lease, month, today, latest, bills] = powerActive
        ? await Promise.all([
            computeUsage({ tenantId, room: roomId, from: leaseFrom, to: now }),
            computeUsage({ tenantId, room: roomId, from: monthFrom, to: now }),
            computeUsage({ tenantId, room: roomId, from: todayFrom, to: now }),
            latestReading(tenantId, roomId, now),
            computeMonthlyBills({ tenantId, room: roomId, leases: r.leases, to: now }),
          ])
        : [zeroUsage(leaseFrom), zeroUsage(monthFrom), zeroUsage(todayFrom), null, []];
      const leaseTotals: Record<string, number> = {};
      for (const l of r.leases) leaseTotals[l.id] = 0;
      for (const b of bills) {
        leaseTotals[b.leaseId] = (leaseTotals[b.leaseId] ?? 0) + b.energyKWh;
      }
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
        todayUsage: {
          ...today,
          monitors: filterMonitorRecord(today.monitors, roomOut),
        },
        leaseTotals,
        latest: latestOut,
        bills,
      });
    },

    "/api/tenants/:tenantId/rooms/:roomId/series": async (req) => {
      const { tenantId, roomId } = req.params;
      const tenant = await requireTenantConfig(tenantId);
      if (!ROOM_ID_RE.test(roomId)) return badRequest("invalid roomId");
      const url = new URL(req.url);
      const to = parseDate(url.searchParams.get("to"), new Date());
      const defaultFrom = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
      const from = parseDate(url.searchParams.get("from"), defaultFrom);
      const bucket = parseBucket(url.searchParams.get("bucket"));
      const cfg = await readRooms(tenantId);
      const r = cfg.rooms[roomId];
      if (!r) return Response.json({ error: "no such room" }, { status: 404 });
      const roomMod = normalizeRoomModalities(r.modalities);
      const series =
        tenant.modalities.power && roomMod.power
          ? await computeSeries({ tenantId, room: roomId, from, to, bucket })
          : emptySeries({ from, to, bucket });
      return Response.json({ from: from.toISOString(), to: to.toISOString(), bucket, series });
    },

    "/api/tenants/:tenantId/rooms/:roomId/raw": async (req) => {
      const { tenantId, roomId } = req.params;
      await requireTenantConfig(tenantId);
      if (!ROOM_ID_RE.test(roomId)) return badRequest("invalid roomId");
      const cfg = await readRooms(tenantId);
      const roomConfig = cfg.rooms[roomId];
      if (!roomConfig) {
        return Response.json({ error: "no such room" }, { status: 404 });
      }
      const requested = Number(new URL(req.url).searchParams.get("limit") ?? 100);
      const limit = Math.min(200, Math.max(1, Number.isFinite(requested) ? requested : 100));
      const readings = await recentReadings(tenantId, roomId, limit);
      return Response.json({
        roomId,
        roomLabel: roomConfig.label,
        limit,
        readings,
      });
    },

    "/api/tenants/:tenantId/series": async (req) => {
      const { tenantId } = req.params;
      const tenant = await requireAnyModalityTenant(tenantId);
      const url = new URL(req.url);
      const to = parseDate(url.searchParams.get("to"), new Date());
      const defaultFrom = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
      const from = parseDate(url.searchParams.get("from"), defaultFrom);
      const bucket = parseBucket(url.searchParams.get("bucket"));
      const powerSeries = tenant.modalities.power
        ? await computeSeries({ tenantId, from, to, bucket })
        : emptySeries({ from, to, bucket });
      const series = powerSeries.map((p) => ({
        ts: p.ts,
        energyKWh: p.energyKWh,
        waterGal: 0,
      }));
      return Response.json({ from: from.toISOString(), to: to.toISOString(), bucket, series });
    },

    // Multi-monitor ingest. Each physical Shelly in a room POSTs to its own
    // monitor path so per-device cumulative counters don't trample each other.
    "/api/tenants/:tenantId/ingest/:roomId/:monitorId": {
      POST: (req) =>
        ingest(req, req.params.tenantId, req.params.roomId, req.params.monitorId, "POST"),
      GET: (req) =>
        ingest(req, req.params.tenantId, req.params.roomId, req.params.monitorId, "GET"),
    },

    // Single-monitor shorthand: equivalent to the tenant ingest path ending in /default.
    // Old Shelly devices that haven't been re-flashed with MONITOR_ID still work.
    "/api/tenants/:tenantId/ingest/:roomId": {
      POST: (req) =>
        ingest(req, req.params.tenantId, req.params.roomId, DEFAULT_MONITOR_ID, "POST"),
      GET: (req) =>
        ingest(req, req.params.tenantId, req.params.roomId, DEFAULT_MONITOR_ID, "GET"),
    },

    "/:tenantId/rooms/:roomId/raw": rawReadings,

    "/:tenantId/rooms/:roomId/edit": room,

    "/:tenantId/rooms/:roomId": room,

    "/:tenantId": index,
  },

  error(err) {
    if (err instanceof RouteError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error(err);
    return new Response("internal error", { status: 500 });
  },
});

async function ingest(
  req: Request,
  tenantId: string,
  roomId: string,
  monitorId: string,
  method: "POST" | "GET",
): Promise<Response> {
  const meta = requestMeta(req);
  const baseDebug = {
    ...meta,
    tenantId,
    roomId,
    monitorId,
  };

  try {
    await requirePowerTenant(tenantId);
  } catch (err) {
    const routeError = err instanceof RouteError ? err : new RouteError("invalid tenant", 400);
    recordTraffic({
      ...baseDebug,
      status: routeError.status,
      message: routeError.message,
    });
    return Response.json({ error: routeError.message }, { status: routeError.status });
  }

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
    hasSwitch: norm.hasSwitch,
    switchOutput: norm.switchOutput,
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

  const cfg = await readRooms(tenantId);
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
          `room ${roomId} uses named monitors; POST to /api/tenants/${tenantId}/ingest/${roomId}/<monitorId> instead`,
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
    tenantId,
    roomId,
    monitorId,
    norm.ip || norm.hasSwitch
      ? {
          ip: norm.ip,
          switch: norm.hasSwitch ? { output: norm.switchOutput } : undefined,
        }
      : undefined,
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
  await appendReading(tenantId, reading);
  recordTraffic({
    ...baseDebug,
    status: 200,
    message: "stored reading",
    bodyParseOk,
    normalized,
    autoRegistered: { newRoom, newMonitor },
  });
  const latestCfg = await readRooms(tenantId);
  const desiredOutput = latestCfg.rooms[roomId]?.monitors?.[monitorId]?.switch?.desiredOutput;
  const switchCommand =
    typeof desiredOutput === "boolean" && desiredOutput !== norm.switchOutput
      ? { output: desiredOutput }
      : undefined;
  return Response.json({ ok: true, switch: switchCommand });
}

console.log(`tenant dashboards listening on http://${server.hostname}:${server.port}`);
