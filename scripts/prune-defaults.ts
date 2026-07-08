#!/usr/bin/env bun
/**
 * One-shot cleanup after mock ingest polluted rooms.json:
 *
 *   bun run prune              # drop `default` when a room has other monitors
 *   bun run prune:mock-rooms   # also delete rooms that look mock-only
 *
 * Mock-only = listed in data/mock-rooms.json, has no leases, and every monitor
 * is `default` or `sim` (the simulator ids). Skips rooms you've curated with
 * named monitors (south, bathroom, …) or an active lease.
 *
 * Always prints a short audit so "nothing to prune" is explainable.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readRooms, writeRooms } from "../src/lib/data.ts";
import { visibleMonitorIds } from "../src/lib/monitors.ts";

const MOCK_CONFIG = resolve(process.cwd(), "data/mock-rooms.json");
const args = new Set(process.argv.slice(2));
const dropMockRooms = args.has("--mock-rooms");

async function mockRoomIds(): Promise<Set<string>> {
  try {
    const text = await readFile(MOCK_CONFIG, "utf8");
    const cfg = JSON.parse(text) as { rooms?: Array<{ room?: string }> };
    const ids = new Set<string>();
    for (const entry of cfg.rooms ?? []) {
      if (typeof entry.room === "string") ids.add(entry.room);
    }
    return ids;
  } catch {
    return new Set();
  }
}

function isMockMonitor(id: string): boolean {
  return id === "default" || id === "sim";
}

function roomLooksMockOnly(
  roomId: string,
  monitors: Record<string, { label: string }>,
  mockIds: Set<string>,
): boolean {
  if (!mockIds.has(roomId)) return false;
  const ids = Object.keys(monitors);
  if (ids.length === 0) return true;
  return ids.every(isMockMonitor);
}

const cfg = await readRooms();
const mockIds = dropMockRooms ? await mockRoomIds() : new Set<string>();
let changed = false;

console.log(`rooms.json: ${Object.keys(cfg.rooms).length} room(s)`);

for (const [roomId, room] of Object.entries(cfg.rooms)) {
  const monitors = room.monitors ?? {};
  const ids = Object.keys(monitors);
  const visible = visibleMonitorIds(monitors);

  console.log(
    `  ${roomId}: monitors=[${ids.join(", ") || "(none)"}]` +
      (ids.length !== visible.length ? ` visible=[${visible.join(", ")}]` : "") +
      ` leases=${room.leases.length}`,
  );

  if (dropMockRooms && room.leases.length === 0 && roomLooksMockOnly(roomId, monitors, mockIds)) {
    console.log(`  -> delete mock-only room ${roomId}`);
    delete cfg.rooms[roomId];
    changed = true;
    continue;
  }

  if (ids.length > 1 && monitors.default) {
    console.log(
      `  -> drop ghost default (kept: ${ids.filter((id) => id !== "default").join(", ")})`,
    );
    delete monitors.default;
    changed = true;
  }
}

if (!changed) {
  console.log("\nnothing to prune — file already clean for these rules.");
  console.log(
    "If the live site still shows `default`, the server is probably reading a",
  );
  console.log(
    "different data/ dir (e.g. /var/lib/5214). Run prune there, or check:",
  );
  console.log("  curl -s http://<host>:3000/api/config/rooms | jq");
} else {
  await writeRooms(cfg);
  console.log("\nwrote data/rooms.json");
}
