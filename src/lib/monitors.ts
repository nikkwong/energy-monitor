import type { Monitor, Room } from "./types.ts";

export const DEFAULT_MONITOR_ID = "default";

/** User-facing label — never surface the raw id `default`. */
export function displayMonitorLabel(
  monitor: Monitor | undefined,
  id: string,
): string {
  const label = monitor?.label;
  if (label && label !== DEFAULT_MONITOR_ID) return label;
  if (id === DEFAULT_MONITOR_ID) return "Mains";
  return label ?? id;
}

/**
 * Drop the ghost `default` feed when a room has other monitors. Mock ingest
 * and legacy shorthand URLs used to register `default` alongside real feeds
 * like `south` / `bathroom`; those entries linger in `rooms.json` until pruned.
 */
export function visibleMonitorIds(
  monitors: Record<string, Monitor> | undefined,
): string[] {
  if (!monitors) return [];
  const ids = Object.keys(monitors);
  if (ids.length <= 1) return ids;
  return ids.filter((id) => id !== DEFAULT_MONITOR_ID);
}

export function sanitizeMonitors(
  monitors: Record<string, Monitor> | undefined,
): Record<string, Monitor> | undefined {
  if (!monitors) return monitors;
  const ids = visibleMonitorIds(monitors);
  const out: Record<string, Monitor> = {};
  for (const id of ids) out[id] = monitors[id]!;
  return Object.keys(out).length > 0 ? out : monitors;
}

export function sanitizeRoom<T extends Room>(room: T): T {
  if (!room.monitors) return room;
  return { ...room, monitors: sanitizeMonitors(room.monitors) };
}

export function roomUsesNamedMonitors(room: Room | undefined): boolean {
  if (!room?.monitors) return false;
  const ids = Object.keys(room.monitors);
  return ids.length > 0 && !(ids.length === 1 && ids[0] === DEFAULT_MONITOR_ID);
}

export function filterMonitorRecord<T>(
  monitors: Record<string, T> | undefined,
  room: Room | undefined,
): Record<string, T> {
  if (!monitors) return {};
  const allowed = new Set(visibleMonitorIds(room?.monitors));
  const out: Record<string, T> = {};
  for (const [id, val] of Object.entries(monitors)) {
    if (allowed.has(id)) out[id] = val;
  }
  return out;
}
