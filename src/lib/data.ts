import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import type { DailyRollup, Lease, Monitor, Reading, RoomsConfig } from "./types.ts";
import { DEFAULT_MONITOR_ID, roomUsesNamedMonitors } from "./monitors.ts";

const DATA_DIR = resolve(process.cwd(), "data");
const ROOMS_PATH = resolve(DATA_DIR, "rooms.json");
const READINGS_DIR = resolve(DATA_DIR, "readings");
const READINGS_PATH = resolve(DATA_DIR, "readings.jsonl");
const ROLLUPS_DIR = resolve(DATA_DIR, "rollups");
const DAILY_ROLLUP_PATH = resolve(ROLLUPS_DIR, "daily.jsonl");

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

function monthKeyFromDate(d: Date): string {
  return d.toISOString().slice(0, 7);
}

function monthKeyFromReading(r: Reading): string {
  const d = new Date(r.ts);
  if (Number.isNaN(d.getTime())) return monthKeyFromDate(new Date());
  return monthKeyFromDate(d);
}

function monthlyReadingPath(month: string): string {
  return resolve(READINGS_DIR, `${month}.jsonl`);
}

function previousMonthKey(month: string): string {
  const d = new Date(month + "-01T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() - 1);
  return monthKeyFromDate(d);
}

function nextMonthKey(month: string): string {
  const d = new Date(month + "-01T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + 1);
  return monthKeyFromDate(d);
}

function monthKeysForRange(from?: Date, to?: Date): Set<string> | null {
  if (!from && !to) return null;
  const start = monthKeyFromDate(from ?? new Date(0));
  const end = monthKeyFromDate(to ?? new Date());
  const out = new Set<string>();
  // Include the previous month so cumulative-counter deltas at the start of
  // the requested range have a baseline reading.
  let cursor = previousMonthKey(start);
  while (cursor <= end) {
    out.add(cursor);
    cursor = nextMonthKey(cursor);
  }
  return out;
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
  await mkdir(READINGS_DIR, { recursive: true });
  const line = JSON.stringify(r) + "\n";
  const path = monthlyReadingPath(monthKeyFromReading(r));
  await enqueue(() => appendFile(path, line, "utf8"));
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

export class MonitorSwitchError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export async function setMonitorSwitchDesired(
  roomId: string,
  monitorId: string,
  output: boolean,
): Promise<Monitor> {
  await ensureDataDir();
  return enqueue(async () => {
    const text = await readFile(ROOMS_PATH, "utf8");
    const cfg = JSON.parse(text) as RoomsConfig;
    const room = cfg.rooms[roomId];
    if (!room) throw new MonitorSwitchError("no such room", 404);
    const monitor = room.monitors?.[monitorId];
    if (!monitor) throw new MonitorSwitchError("no such monitor", 404);
    if (!monitor.switch) {
      throw new MonitorSwitchError("monitor is not switch-capable", 400);
    }
    monitor.switch.desiredOutput = output;
    monitor.switch.updatedAt = new Date().toISOString();
    await writeRoomsInQueue(cfg);
    return monitor;
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
  observed?: { ip?: string; switch?: { output?: boolean } },
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
    if (observed?.switch) {
      const current = monitor.switch ?? {};
      if (!monitor.switch || monitor.switch.output !== observed.switch.output) {
        monitor.switch = {
          ...current,
          output: observed.switch.output,
          updatedAt: new Date().toISOString(),
        };
        dirty = true;
      }
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

async function* iterReadingFile(path: string): AsyncGenerator<Reading> {
  const file = Bun.file(path);
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

async function monthlyReadingFiles(opts?: {
  from?: Date;
  to?: Date;
}): Promise<string[]> {
  await ensureDataDir();
  const wanted = monthKeysForRange(opts?.from, opts?.to);
  let entries: string[];
  try {
    entries = await readdir(READINGS_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name))
    .map((name) => name.slice(0, 7))
    .filter((month) => !wanted || wanted.has(month))
    .sort()
    .map((month) => monthlyReadingPath(month));
}

/**
 * Stream readings in append order across legacy and monthly-sharded files.
 * `from`/`to` limit monthly shard selection; the legacy file is always scanned
 * because it predates sharding and can contain any timestamp.
 */
export async function* iterReadings(opts?: {
  from?: Date;
  to?: Date;
}): AsyncGenerator<Reading> {
  yield* iterReadingFile(READINGS_PATH);
  for (const path of await monthlyReadingFiles(opts)) {
    yield* iterReadingFile(path);
  }
}

export async function appendDailyRollups(rows: DailyRollup[]): Promise<void> {
  if (rows.length === 0) return;
  await ensureDataDir();
  await mkdir(ROLLUPS_DIR, { recursive: true });
  const lines = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await enqueue(() => appendFile(DAILY_ROLLUP_PATH, lines, "utf8"));
}

export async function* iterDailyRollups(opts?: {
  from?: Date;
  to?: Date;
}): AsyncGenerator<DailyRollup> {
  const fromDay = opts?.from?.toISOString().slice(0, 10);
  const toDay = opts?.to?.toISOString().slice(0, 10);
  const file = Bun.file(DAILY_ROLLUP_PATH);
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
        const row = JSON.parse(line) as DailyRollup;
        if (fromDay && row.date < fromDay) continue;
        if (toDay && row.date >= toDay) continue;
        yield row;
      } catch {
        // skip malformed line
      }
    }
  }
  buf += decoder.decode();
  const tail = buf.trim();
  if (tail) {
    try {
      const row = JSON.parse(tail) as DailyRollup;
      if ((!fromDay || row.date >= fromDay) && (!toDay || row.date < toDay)) {
        yield row;
      }
    } catch {
      // skip malformed tail
    }
  }
}

export const paths = {
  dataDir: DATA_DIR,
  rooms: ROOMS_PATH,
  readings: READINGS_PATH,
  readingsDir: READINGS_DIR,
  rollupsDir: ROLLUPS_DIR,
  dailyRollup: DAILY_ROLLUP_PATH,
} as const;
