import { mkdir, readFile, writeFile, appendFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import type { Lease, Reading, RoomsConfig } from "./types.ts";
import { DEFAULT_MONITOR_ID, roomUsesNamedMonitors } from "./monitors.ts";

const DATA_DIR = resolve(process.cwd(), "data");
const ROOMS_PATH = resolve(DATA_DIR, "rooms.json");
const READINGS_PATH = resolve(DATA_DIR, "readings.jsonl");

// Single in-process write queue. Serializes appends and atomic rewrites so we
// never interleave a reading append with a rooms.json rewrite, and so concurrent
// Shelly POSTs don't tear lines.
let writeChain: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  // Swallow rejection on the chain so one failure doesn't poison subsequent writes,
  // but still surface the error to the caller.
  writeChain = next.catch(() => {});
  return next;
}

async function ensureDataDir(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}

export async function readRooms(): Promise<RoomsConfig> {
  await ensureDataDir();
  try {
    const text = await readFile(ROOMS_PATH, "utf8");
    const parsed = JSON.parse(text) as RoomsConfig;
    if (!parsed.rooms || typeof parsed.rooms !== "object") {
      return { rooms: {} };
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      const empty: RoomsConfig = { rooms: {} };
      await writeRooms(empty);
      return empty;
    }
    throw err;
  }
}

export async function writeRooms(cfg: RoomsConfig): Promise<void> {
  await ensureDataDir();
  await enqueue(async () => {
    const tmp = ROOMS_PATH + ".tmp";
    await writeFile(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    await rename(tmp, ROOMS_PATH);
  });
}

export async function appendReading(r: Reading): Promise<void> {
  await ensureDataDir();
  const line = JSON.stringify(r) + "\n";
  await enqueue(() => appendFile(READINGS_PATH, line, "utf8"));
}

/**
 * Remove a room (and all its monitors) from `rooms.json`. The room's
 * historical readings stay in `readings.jsonl` — that file is append-only by
 * design — but the aggregator filters them out at read time, so deleted rooms
 * silently disappear from every dashboard and the house total. To bring the
 * data back, re-add the room to `rooms.json` (or wait for the device to
 * auto-register on its next POST).
 *
 * Returns `false` if no such room existed (caller should 404).
 */
export async function deleteRoom(roomId: string): Promise<boolean> {
  await ensureDataDir();
  return enqueue(async () => {
    let cfg: RoomsConfig;
    try {
      const text = await readFile(ROOMS_PATH, "utf8");
      const parsed = JSON.parse(text) as RoomsConfig;
      cfg =
        parsed && parsed.rooms && typeof parsed.rooms === "object"
          ? parsed
          : { rooms: {} };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
    if (!cfg.rooms[roomId]) return false;
    delete cfg.rooms[roomId];
    const tmp = ROOMS_PATH + ".tmp";
    await writeFile(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    await rename(tmp, ROOMS_PATH);
    return true;
  });
}

/**
 * Remove one monitor from a room in `rooms.json`. Readings for that monitor
 * stay in `readings.jsonl` but stop contributing to totals once the monitor
 * is no longer listed (see `aggregate.ts` allowlist).
 *
 * Returns `false` if the room or monitor did not exist.
 */
export async function deleteMonitor(
  roomId: string,
  monitorId: string,
): Promise<boolean> {
  await ensureDataDir();
  return enqueue(async () => {
    let cfg: RoomsConfig;
    try {
      const text = await readFile(ROOMS_PATH, "utf8");
      const parsed = JSON.parse(text) as RoomsConfig;
      cfg =
        parsed && parsed.rooms && typeof parsed.rooms === "object"
          ? parsed
          : { rooms: {} };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
    const room = cfg.rooms[roomId];
    if (!room?.monitors?.[monitorId]) return false;
    delete room.monitors[monitorId];
    const tmp = ROOMS_PATH + ".tmp";
    await writeFile(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    await rename(tmp, ROOMS_PATH);
    return true;
  });
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseIsoDate(v: string): string | null {
  if (!ISO_DATE_RE.test(v)) return null;
  const d = new Date(v + "T00:00:00Z");
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) return null;
  return v;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function nextLeaseId(roomId: string): string {
  return `lease-${roomId}-${Date.now()}`;
}

async function writeRoomsInQueue(cfg: RoomsConfig): Promise<void> {
  const tmp = ROOMS_PATH + ".tmp";
  await writeFile(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  await rename(tmp, ROOMS_PATH);
}

/**
 * End the room's current lease (the entry with `endDate === null`).
 * `endDate` is exclusive — readings on that date belong to the next tenant.
 */
export async function endCurrentLease(
  roomId: string,
  endDate?: string,
): Promise<Lease> {
  await ensureDataDir();
  return enqueue(async () => {
    const text = await readFile(ROOMS_PATH, "utf8");
    const cfg = JSON.parse(text) as RoomsConfig;
    const room = cfg.rooms[roomId];
    if (!room) throw new LeaseError("no such room", 404);

    const current = room.leases.find((l) => l.endDate === null);
    if (!current) throw new LeaseError("no active lease", 400);

    const end = parseIsoDate(endDate ?? todayUtc());
    if (!end) throw new LeaseError("invalid endDate", 400);
    if (end <= current.startDate) {
      throw new LeaseError("endDate must be after lease startDate", 400);
    }

    current.endDate = end;
    await writeRoomsInQueue(cfg);
    return current;
  });
}

/**
 * Append a new active lease. If a lease is currently open, it is closed with
 * `endDate = startDate` of the new one so tenancy windows stay contiguous.
 */
export async function startLease(
  roomId: string,
  tenant: string,
  startDate: string,
): Promise<Lease> {
  await ensureDataDir();
  return enqueue(async () => {
    const text = await readFile(ROOMS_PATH, "utf8");
    const cfg = JSON.parse(text) as RoomsConfig;
    const room = cfg.rooms[roomId];
    if (!room) throw new LeaseError("no such room", 404);

    const name = tenant.trim();
    if (!name) throw new LeaseError("tenant is required", 400);

    const start = parseIsoDate(startDate);
    if (!start) throw new LeaseError("invalid startDate", 400);

    const current = room.leases.find((l) => l.endDate === null);
    if (current) {
      if (start <= current.startDate) {
        throw new LeaseError("startDate must be after current lease startDate", 400);
      }
      current.endDate = start;
    }

    const lease: Lease = {
      id: nextLeaseId(roomId),
      tenant: name,
      startDate: start,
      endDate: null,
    };
    room.leases.push(lease);
    await writeRoomsInQueue(cfg);
    return lease;
  });
}

export class LeaseError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * Idempotently ensure `rooms.json` has an entry for `(roomId, monitorId)`,
 * creating both with sensible defaults if missing, and refreshing any
 * `observed` fields (currently just `ip`) on each call.
 *
 * - **Curated fields** (`label`, `leases`) are strictly additive: only set
 *   when missing, never overwritten. Operator edits in `rooms.json` stick.
 * - **Observed fields** (`ip`) are overwritten whenever the device reports
 *   a new value, so the dashboard always links to the device's *current*
 *   LAN address even after DHCP renewals.
 *
 * The whole read-modify-write happens inside a single queued task so two
 * concurrent first-POSTs can't race. We only write the file when something
 * actually changed, so steady-state ingest stays a no-op disk-wise.
 */
export async function ensureRoomAndMonitor(
  roomId: string,
  monitorId: string,
  observed?: { ip?: string },
): Promise<{ newRoom: boolean; newMonitor: boolean }> {
  await ensureDataDir();
  return enqueue(async () => {
    let cfg: RoomsConfig;
    try {
      const text = await readFile(ROOMS_PATH, "utf8");
      const parsed = JSON.parse(text) as RoomsConfig;
      cfg =
        parsed && parsed.rooms && typeof parsed.rooms === "object"
          ? parsed
          : { rooms: {} };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        cfg = { rooms: {} };
      } else {
        throw err;
      }
    }

    let newRoom = false;
    let newMonitor = false;
    let dirty = false;

    if (!cfg.rooms[roomId]) {
      cfg.rooms[roomId] = {
        label: `Room ${roomId}`,
        monitors: {},
        leases: [],
      };
      newRoom = true;
      dirty = true;
    }

    const room = cfg.rooms[roomId];
    if (!room.monitors) room.monitors = {};
    if (
      monitorId === DEFAULT_MONITOR_ID &&
      roomUsesNamedMonitors(room) &&
      !room.monitors[DEFAULT_MONITOR_ID]
    ) {
      // Ghost default from mock/legacy ingest — don't re-add to config.
      return { newRoom: false, newMonitor: false };
    }
    if (!room.monitors[monitorId]) {
      room.monitors[monitorId] = {
        label: monitorId === DEFAULT_MONITOR_ID ? "Mains" : monitorId,
      };
      newMonitor = true;
      dirty = true;
    }

    const monitor = room.monitors[monitorId];
    if (observed?.ip && monitor.ip !== observed.ip) {
      monitor.ip = observed.ip;
      dirty = true;
    }

    if (dirty) {
      const tmp = ROOMS_PATH + ".tmp";
      await writeFile(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
      await rename(tmp, ROOMS_PATH);
    }

    return { newRoom, newMonitor };
  });
}

/**
 * Coerce a raw JSONL line into the current `Reading` shape.
 *
 * Readings written before the multi-monitor migration have a `channels[]`
 * array and no `monitor` field. We attribute them to a synthetic
 * `monitor: "default"` and sum any reported channels into a single tuple
 * — every room had exactly one Shelly back then, so the sum is a sum of one.
 *
 * Returns null if the line lacks the fields needed to be useful.
 */
function coerceReading(parsed: unknown): Reading | null {
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  const ts = typeof p["ts"] === "string" ? p["ts"] : null;
  const room = typeof p["room"] === "string" ? p["room"] : null;
  if (!ts || !room) return null;

  if (typeof p["powerW"] === "number" && typeof p["totalEnergyWh"] === "number") {
    return {
      ts,
      room,
      monitor: typeof p["monitor"] === "string" ? p["monitor"] : "default",
      powerW: p["powerW"],
      totalEnergyWh: p["totalEnergyWh"],
      raw: p["raw"],
    };
  }

  if (Array.isArray(p["channels"])) {
    let powerW = 0;
    let totalEnergyWh = 0;
    for (const c of p["channels"] as unknown[]) {
      if (!c || typeof c !== "object") continue;
      const cc = c as Record<string, unknown>;
      if (typeof cc["powerW"] === "number") powerW += cc["powerW"];
      if (typeof cc["totalEnergyWh"] === "number") totalEnergyWh += cc["totalEnergyWh"];
    }
    return {
      ts,
      room,
      monitor: typeof p["monitor"] === "string" ? p["monitor"] : "default",
      powerW,
      totalEnergyWh,
      raw: p["raw"],
    };
  }

  return null;
}

/**
 * Stream readings in file order. The file is append-only, so this is roughly
 * chronological — but callers that need strict order should sort by `ts`.
 */
export async function* iterReadings(): AsyncGenerator<Reading> {
  await ensureDataDir();
  const file = Bun.file(READINGS_PATH);
  if (!(await file.exists())) return;

  const decoder = new TextDecoder();
  let buf = "";
  // @ts-expect-error - Bun's file stream is async iterable of Uint8Array
  for await (const chunk of file.stream()) {
    buf += decoder.decode(chunk as Uint8Array, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const r = coerceReading(JSON.parse(line));
        if (r) yield r;
      } catch {
        // skip malformed line
      }
    }
  }
  buf += decoder.decode();
  const tail = buf.trim();
  if (tail) {
    try {
      const r = coerceReading(JSON.parse(tail));
      if (r) yield r;
    } catch {
      // skip malformed tail
    }
  }
}

export const paths = {
  dataDir: DATA_DIR,
  rooms: ROOMS_PATH,
  readings: READINGS_PATH,
} as const;
