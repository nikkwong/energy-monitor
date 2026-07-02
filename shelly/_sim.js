// Local simulation of the Shelly reporter — mirrors report.js exactly.
// For testing only; NOT shipped to the device.
//
// Mock mode (recommended): edit data/mock-rooms.json, then:
//   bun run mock                        # continuous, uses mock-rooms.json
//   bun run mock --interval 10          # every 10s
//   bun run mock --base http://host:3000
//
// Legacy discover mode (rooms already on the server):
//   bun run sim                         # one tick from GET /api/rooms, exit
//   bun run sim --watch                 # continuous
//   bun run sim --discover              # same, explicit
//
// Each (room, monitor) pair gets its own load profile. Energy counters
// increment realistically based on power × elapsed time.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const ID_RE = /^[A-Za-z0-9_-]{1,16}$/;
const DEFAULT_CONFIG = resolve(process.cwd(), "data/mock-rooms.json");

const args = parseArgs(process.argv.slice(2));
const BASE_URL = args.base ?? null;
const ROOM_FILTER = args.room ?? null;
const WATCH = args.watch ?? false;
const INTERVAL_MS =
  (args.interval ?? null) != null ? args.interval * 1000 : null;
const CONFIG_PATH = args.config ?? (args.discover ? null : DEFAULT_CONFIG);
const USE_DISCOVER = args.discover || CONFIG_PATH == null;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--watch") out.watch = true;
    else if (a === "--discover") out.discover = true;
    else if (a === "--interval") out.interval = Number(argv[++i]);
    else if (a === "--room") out.room = argv[++i];
    else if (a === "--base") out.base = argv[++i];
    else if (a === "--config") out.config = resolve(process.cwd(), argv[++i]);
    else if (a.startsWith("--")) console.warn("unknown flag:", a);
    else if (!out.room) out.room = a;
    else if (!out.base) out.base = a;
  }
  return out;
}

/** @typedef {{ room: string, monitor: string, basePowerW?: number, jitterW?: number, ip?: string }} MockEntry */

/**
 * @typedef {{
 *   baseUrl?: string,
 *   intervalS?: number,
 *   rooms: MockEntry[],
 * }} MockConfig
 */

// Per-(room, monitor) state held across ticks so the cumulative counter
// increases monotonically.
const state = new Map();

/**
 * @param {string} roomId
 * @param {string} monitorId
 * @param {MockEntry | undefined} seed
 */
function getState(roomId, monitorId, seed) {
  const key = `${roomId}|${monitorId}`;
  let s = state.get(key);
  if (!s) {
    s = {
      basePowerW: seed?.basePowerW ?? 80 + Math.floor(Math.random() * 250),
      jitterW: seed?.jitterW ?? 30 + Math.floor(Math.random() * 50),
      totalEnergyWh: 1000 + Math.floor(Math.random() * 50000),
      lastTick: Date.now(),
      stationIp:
        seed?.ip ?? `192.168.42.${10 + (state.size % 240)}`,
    };
    state.set(key, s);
  }
  return s;
}

// === verbatim from report.js ===
function isEmKey(k) {
  return (
    k.indexOf("em1:") === 0 ||
    k.indexOf("em1data:") === 0 ||
    k.indexOf("em:") === 0 ||
    k.indexOf("emdata:") === 0
  );
}

function pickEmFields(status) {
  const out = {};
  if (status && status.sys && typeof status.sys.unixtime === "number") {
    out.ts = status.sys.unixtime;
  }
  if (status && status.wifi && typeof status.wifi.sta_ip === "string") {
    out.wifi = { sta_ip: status.wifi.sta_ip };
  }
  for (const k in status) {
    if (isEmKey(k)) out[k] = status[k];
  }
  return out;
}
// === /verbatim ===

function fakeStatus(s) {
  const now = Date.now();
  const elapsedH = (now - s.lastTick) / (1000 * 60 * 60);
  const powerW = s.basePowerW + (Math.random() - 0.5) * s.jitterW;
  s.totalEnergyWh += powerW * elapsedH;
  s.lastTick = now;
  return {
    sys: { unixtime: Math.floor(now / 1000) },
    "em1:0": {
      id: 0,
      act_power: powerW,
      voltage: 237 + Math.random() * 2,
      current: powerW / 237,
      pf: 0.99,
      freq: 60,
      calibration: "factory",
    },
    "em1data:0": {
      id: 0,
      total_act_energy: s.totalEnergyWh,
      total_act_ret_energy: 0,
    },
    wifi: { sta_ip: s.stationIp },
  };
}

/**
 * @param {string} baseUrl
 * @param {{ room: string, monitor: string, seed?: MockEntry }} target
 */
async function postOnce(baseUrl, { room, monitor, seed }) {
  const s = getState(room, monitor, seed);
  const status = fakeStatus(s);
  const body = JSON.stringify({
    method: "NotifyStatus",
    params: pickEmFields(status),
  });
  const r = await fetch(`${baseUrl}/api/ingest/${room}/${monitor}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const txt = await r.text();
  const stamp = new Date().toLocaleTimeString();
  const w = status["em1:0"].act_power.toFixed(0);
  const wh = status["em1data:0"].total_act_energy.toFixed(0);
  const path = `${room}/${monitor}`;
  console.log(
    `[${stamp}] ${path.padEnd(18)} ${w.padStart(4)}W  total=${wh}Wh  -> ${r.status} ${txt}`,
  );
}

/** @param {MockConfig} cfg */
function targetsFromConfig(cfg) {
  if (!Array.isArray(cfg.rooms) || cfg.rooms.length === 0) {
    throw new Error("mock config: `rooms` must be a non-empty array");
  }
  /** @type {Array<{ room: string, monitor: string, seed?: MockEntry }>} */
  const out = [];
  for (const entry of cfg.rooms) {
    const room = entry.room;
    const monitor = entry.monitor ?? "default";
    if (typeof room !== "string" || !ID_RE.test(room)) {
      throw new Error(`mock config: invalid room id "${room}"`);
    }
    if (!ID_RE.test(monitor)) {
      throw new Error(`mock config: invalid monitor id "${monitor}"`);
    }
    if (ROOM_FILTER && room !== ROOM_FILTER) continue;
    out.push({ room, monitor, seed: entry });
  }
  if (out.length === 0) {
    throw new Error(
      ROOM_FILTER
        ? `mock config: no entries for room "${ROOM_FILTER}"`
        : "mock config: no valid room entries",
    );
  }
  return out;
}

/**
 * @param {string} baseUrl
 * @returns {Promise<Array<{ room: string, monitor: string }>>}
 */
async function discoverTargets(baseUrl) {
  const r = await fetch(`${baseUrl}/api/rooms`);
  if (!r.ok) throw new Error(`GET /api/rooms failed: ${r.status}`);
  const { rooms } = await r.json();
  /** @type {Array<{ room: string, monitor: string }>} */
  const targets = [];
  for (const room of rooms) {
    if (ROOM_FILTER && room.id !== ROOM_FILTER) continue;
    const monitors =
      Array.isArray(room.monitors) && room.monitors.length > 0
        ? room.monitors
        : ["default"];
    for (const m of monitors) targets.push({ room: room.id, monitor: m });
  }
  return targets;
}

/** @param {string} baseUrl @param {Array<{ room: string, monitor: string, seed?: MockEntry }>} targets */
async function tick(baseUrl, targets) {
  await Promise.all(targets.map((t) => postOnce(baseUrl, t)));
}

/** @param {string} path */
async function loadMockConfig(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((/** @type {NodeJS.ErrnoException} */ (err)).code === "ENOENT") {
      throw new Error(
        `mock config not found: ${path}\n` +
          "Create data/mock-rooms.json or pass --discover to use rooms.json on the server.",
      );
    }
    throw err;
  }
  const cfg = JSON.parse(text);
  if (!cfg || typeof cfg !== "object") {
    throw new Error(`mock config: expected JSON object in ${path}`);
  }
  return /** @type {MockConfig} */ (cfg);
}

async function main() {
  let baseUrl = BASE_URL;
  let intervalMs = INTERVAL_MS;
  /** @type {Array<{ room: string, monitor: string, seed?: MockEntry }>} */
  let targets;

  if (USE_DISCOVER) {
    baseUrl = baseUrl ?? "http://localhost:3000";
    targets = await discoverTargets(baseUrl);
    if (targets.length === 0) {
      console.error("no rooms on server — add to data/rooms.json or use mock config");
      process.exit(1);
    }
    intervalMs = intervalMs ?? 10 * 1000;
  } else {
    const cfg = await loadMockConfig(CONFIG_PATH);
    baseUrl = baseUrl ?? cfg.baseUrl ?? "http://localhost:3000";
    intervalMs = intervalMs ?? (cfg.intervalS ?? 60) * 1000;
    targets = targetsFromConfig(cfg);
  }

  const summary = targets.map((t) => `${t.room}/${t.monitor}`).join(", ");
  const mode = USE_DISCOVER ? "discover" : `config ${CONFIG_PATH}`;
  console.log(
    `mock sim [${mode}]: ${targets.length} monitor(s) [${summary}] -> ${baseUrl}` +
      (WATCH ? `  every ${intervalMs / 1000}s` : "  (single tick)"),
  );

  await tick(baseUrl, targets);
  if (!WATCH) return;

  setInterval(() => {
    tick(baseUrl, targets).catch((e) => console.error("tick failed:", e.message));
  }, intervalMs);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
