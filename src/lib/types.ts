// Shared types between server, data layer, and (typed) client code.

export type Lease = {
  id: string;
  tenant: string;
  /** Inclusive lease start, ISO date (YYYY-MM-DD) interpreted as local midnight. */
  startDate: string;
  /** Exclusive lease end, ISO date. `null` means current tenant. */
  endDate: string | null;
  notes?: string;
};

/**
 * One physical Shelly device installed in a room. Each monitor owns its own
 * cumulative energy counter, so deltas are computed per `(room, monitor)`.
 *
 * The id is the path segment used in `POST /api/ingest/:roomId/:monitorId`
 * — pick something descriptive of the feed the CT clamp is on, e.g.
 * `"south"`, `"hvac"`, `"in-bathroom"`. Must match `MONITOR_ID_RE` in
 * server.ts.
 */
export type Monitor = {
  /**
   * Display label, e.g. "South wall mains". Defaults to the monitor id on
   * auto-registration; edit `data/rooms.json` to override.
   */
  label: string;
  /**
   * LAN IP the device last reported (from `Shelly.GetStatus().wifi.sta_ip`).
   * Updated on every ingest so it follows DHCP renewals — operator edits to
   * this field will be overwritten by the next POST. Used by the dashboard
   * to render a click-through link to the device's admin UI.
   */
  ip?: string;
};

/**
 * `rooms.json` is operator-editable overlay metadata. Entries are
 * auto-created on the first POST from a new `(room, monitor)` pair (see
 * `ensureRoomAndMonitor` in `data.ts`); the operator then fills in lease
 * history and friendly labels by editing the file. Subsequent
 * auto-registrations only fill in *missing* fields, never overwrite.
 */
export type Room = {
  /** Display label, e.g. "Room 301". Defaults to `"Room <id>"` on auto-register. */
  label: string;
  /**
   * Monitors known to belong to this room. Auto-populated from ingest POSTs;
   * the operator can edit the labels here. Always present after first POST,
   * but optional in the type for hand-edited rooms with no readings yet.
   */
  monitors?: Record<string, Monitor>;
  /** Lease history, oldest first. The current tenant is the entry with endDate === null. */
  leases: Lease[];
};

export type RoomsConfig = {
  rooms: Record<string, Room>;
};

/**
 * One report from one Shelly device.
 *
 * EM Mini Gen4 is single-channel by design, so we collapse the wire payload
 * into a single (power, energy) tuple here. If a future multi-channel device
 * (Pro EM 4-channel etc.) is ever wired up, the recommended approach is to
 * run one logical monitor per channel — keeps the schema uniform.
 */
export type Reading = {
  /** ISO-8601 timestamp of the reading. */
  ts: string;
  /** Room id this reading belongs to (e.g. "301", "b4"). */
  room: string;
  /** Monitor id within the room (e.g. "south", "default"). */
  monitor: string;
  /** Instantaneous active power in watts. */
  powerW: number;
  /** Cumulative active energy counter in watt-hours. Monotonic except for resets. */
  totalEnergyWh: number;
  /** Optional raw Shelly payload, kept for debugging. */
  raw?: unknown;
};

/**
 * Precomputed daily energy total. Rollups are used for old data after raw
 * monthly shards have been gzipped/archived.
 */
export type DailyRollup = {
  /** UTC date (YYYY-MM-DD). */
  date: string;
  room: string;
  monitor: string;
  energyKWh: number;
};
