// Local simulation of the Shelly reporter — mirrors report.js exactly.
// For testing only; NOT shipped to the device.
//
// Usage:
//   bun run sim                         # one tick per active (room, monitor), then exit
//   bun run sim --watch                 # continuous, every 10s
//   bun run sim --watch --interval 5    # continuous, every 5s
//   bun run sim --room 301              # only one room (all its monitors)
//   bun run sim --base http://host:3000 # custom server URL
//
// Each (room, monitor) pair gets its own randomized "load profile" stable
// across ticks so the dashboard chart looks plausible. Energy counters
// increment realistically based on power × elapsed time.

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

// Per-(room, monitor) state held across ticks so the cumulative counter
// increases monotonically.
const state = new Map();

function getState(roomId, monitorId) {
  const key = `${roomId}|${monitorId}`;
  let s = state.get(key);
  if (!s) {
    s = {
      // Seed each monitor with a random "typical load" so the chart has variety.
      basePowerW: 80 + Math.floor(Math.random() * 250),
      jitterW: 30 + Math.floor(Math.random() * 50),
      totalEnergyWh: 1000 + Math.floor(Math.random() * 50000),
      lastTick: Date.now(),
      // Stable per-key fake LAN IP so each simulated device gets its own
      // click-through link in the dashboard.
      stationIp: `192.168.42.${10 + (state.size % 240)}`,
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

async function postOnce(roomId, monitorId) {
  const s = getState(roomId, monitorId);
  const status = fakeStatus(s);
  const body = JSON.stringify({
    method: "NotifyStatus",
    params: pickEmFields(status),
  });
  const r = await fetch(
    `${BASE_URL}/api/ingest/${roomId}/${monitorId}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    },
  );
  const txt = await r.text();
  const stamp = new Date().toLocaleTimeString();
  const w = status["em1:0"].act_power.toFixed(0);
  const wh = status["em1data:0"].total_act_energy.toFixed(0);
  const path = `${roomId}/${monitorId}`;
  console.log(
    `[${stamp}] ${path.padEnd(18)} ${w.padStart(4)}W  total=${wh}Wh  -> ${r.status} ${txt}`,
  );
}

/**
 * Pull room ids and their monitor lists from the running server.
 * Falls back to monitor=`default` for any room without an explicit list,
 * matching the server's implicit-default behavior.
 */
async function discoverTargets() {
  const r = await fetch(`${BASE_URL}/api/rooms`);
  if (!r.ok) throw new Error(`GET /api/rooms failed: ${r.status}`);
  const { rooms } = await r.json();
  const targets = [];
  for (const room of rooms) {
    const monitors =
      Array.isArray(room.monitors) && room.monitors.length > 0
        ? room.monitors
        : ["default"];
    for (const m of monitors) targets.push([room.id, m]);
  }
  return targets;
}

async function tick(targets) {
  await Promise.all(targets.map(([r, m]) => postOnce(r, m)));
}

async function main() {
  let targets;
  if (ROOM_FILTER) {
    // Without /api/rooms we don't know the monitor list; ping every monitor
    // declared on that room by hitting /api/rooms first and filtering.
    const all = await discoverTargets();
    targets = all.filter(([r]) => r === ROOM_FILTER);
    if (targets.length === 0) {
      console.error(`no monitors for room "${ROOM_FILTER}" — check data/rooms.json`);
      process.exit(1);
    }
  } else {
    targets = await discoverTargets();
    if (targets.length === 0) {
      console.error("no rooms in data/rooms.json — add one and retry");
      process.exit(1);
    }
  }
  const summary = targets.map(([r, m]) => `${r}/${m}`).join(", ");
  console.log(
    `simulating ${targets.length} monitor(s) [${summary}] -> ${BASE_URL}` +
      (WATCH ? `  every ${INTERVAL_MS / 1000}s` : "  (single tick)"),
  );
  await tick(targets);
  if (!WATCH) return;
  setInterval(() => {
    tick(targets).catch((e) => console.error("tick failed:", e.message));
  }, INTERVAL_MS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
