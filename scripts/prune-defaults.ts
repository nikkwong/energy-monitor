#!/usr/bin/env bun
/**
 * One-shot cleanup after mock ingest polluted rooms.json:
 *
 *   1. Drop `default` monitor entries from any room that has other monitors.
 *   2. Optionally delete whole rooms that look mock-only (--mock-rooms).
 *
 * Mock-only heuristic: the room's only monitor is `default` and its IP is in
 * the 192.168.42.0/24 block the simulator uses. Real Shellys won't match.
 *
 * Usage:
 *   bun run prune              # strip ghost default monitors
 *   bun run prune --mock-rooms # also delete mock-only rooms
 */

import { readRooms, writeRooms } from "../src/lib/data.ts";

const MOCK_IP_RE = /^192\.168\.42\./;
const args = new Set(process.argv.slice(2));
const dropMockRooms = args.has("--mock-rooms");

const cfg = await readRooms();
let changed = false;

for (const [roomId, room] of Object.entries(cfg.rooms)) {
  const monitors = room.monitors ?? {};
  const ids = Object.keys(monitors);

  if (
    dropMockRooms &&
    ids.length === 1 &&
    ids[0] === "default" &&
    MOCK_IP_RE.test(monitors.default?.ip ?? "")
  ) {
    console.log(`delete mock-only room ${roomId} (default @ ${monitors.default?.ip})`);
    delete cfg.rooms[roomId];
    changed = true;
    continue;
  }

  if (ids.length > 1 && monitors.default) {
    console.log(`drop ghost default monitor from ${roomId} (kept: ${ids.filter((id) => id !== "default").join(", ")})`);
    delete monitors.default;
    changed = true;
  }
}

if (!changed) {
  console.log("nothing to prune");
} else {
  await writeRooms(cfg);
  console.log("wrote data/rooms.json");
}
