// Local simulation of the Shelly reporter — mirrors report.js exactly.
// For testing only; NOT shipped to the device.
//
// Usage:
//   bun run sim                         # one tick per active room, then exit
//   bun run sim --watch                 # continuous, every 10s
//   bun run sim --watch --interval 5    # continuous, every 5s
//   bun run sim --room 301              # only one room
//   bun run sim --base http://host:3000 # custom server URL
//
// Each room's "load profile" is randomized but stable across ticks so the
// dashboard chart looks plausible. Energy counters increment realistically
// based on power × elapsed time.

const args = parseArgs(process.argv.slice(2));
const BASE_URL = args.base ?? "http://localhost:3000";
const ROOM_FILTER = args.room ?? null;
const WATCH = args.watch ?? false;
const INTERVAL_MS = (args.interval ?? 10) * 1000;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--watch") out.watch = true;
    else if (a === "--interval") out.interval = Number(argv[++i]);
    else if (a === "--room") out.room = argv[++i];
    else if (a === "--base") out.base = argv[++i];
    else if (a.startsWith("--")) console.warn("unknown flag:", a);
    else if (!out.room) out.room = a;
    else if (!out.base) out.base = a;
  }
  return out;
}

// Per-room state held across ticks so the cumulative counter increases monotonically.
const state = new Map();

function getState(roomId) {
  let s = state.get(roomId);
  if (!s) {
    s = {
      // Seed each room with a random "typical load" so the chart has variety.
      basePowerW: 80 + Math.floor(Math.random() * 250),
      jitterW: 30 + Math.floor(Math.random() * 50),
      totalEnergyWh: 1000 + Math.floor(Math.random() * 50000),
      lastTick: Date.now(),
    };
    state.set(roomId, s);
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
    wifi: { sta_ip: "192.168.1.42" },
  };
}

async function postOnce(roomId) {
  const s = getState(roomId);
  const status = fakeStatus(s);
  const body = JSON.stringify({
    method: "NotifyStatus",
    params: pickEmFields(status),
  });
  const r = await fetch(`${BASE_URL}/api/ingest/${roomId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const txt = await r.text();
  const stamp = new Date().toLocaleTimeString();
  const w = status["em1:0"].act_power.toFixed(0);
  const wh = status["em1data:0"].total_act_energy.toFixed(0);
  console.log(
    `[${stamp}] room=${roomId.padEnd(5)} ${w.padStart(4)}W  total=${wh}Wh  -> ${r.status} ${txt}`,
  );
}

async function discoverRooms() {
  const r = await fetch(`${BASE_URL}/api/rooms`);
  if (!r.ok) throw new Error(`GET /api/rooms failed: ${r.status}`);
  const { rooms } = await r.json();
  return rooms.map((x) => x.id);
}

async function tick(roomIds) {
  await Promise.all(roomIds.map(postOnce));
}

async function main() {
  let roomIds;
  if (ROOM_FILTER) {
    roomIds = [ROOM_FILTER];
  } else {
    roomIds = await discoverRooms();
    if (roomIds.length === 0) {
      console.error("no rooms in data/rooms.json — add one and retry");
      process.exit(1);
    }
  }
  console.log(
    `simulating ${roomIds.length} room(s) [${roomIds.join(", ")}] -> ${BASE_URL}` +
      (WATCH ? `  every ${INTERVAL_MS / 1000}s` : "  (single tick)"),
  );
  await tick(roomIds);
  if (!WATCH) return;
  setInterval(() => {
    tick(roomIds).catch((e) => console.error("tick failed:", e.message));
  }, INTERVAL_MS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
