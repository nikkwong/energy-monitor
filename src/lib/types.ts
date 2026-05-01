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

export type Room = {
  /** Display label, e.g. "Room 301". */
  label: string;
  /** Optional human note about which Shelly channel maps to which sub-load. */
  channelLabels?: Record<number, string>;
  /** Lease history, oldest first. The current tenant is the entry with endDate === null. */
  leases: Lease[];
};

export type RoomsConfig = {
  rooms: Record<string, Room>;
};

export type ChannelReading = {
  /** Shelly channel index. EM Mini = always 0; multi-channel meters use 0..N-1. */
  idx: number;
  /** Instantaneous active power in watts. */
  powerW: number;
  /** Cumulative active energy counter in watt-hours. Monotonic except for resets. */
  totalEnergyWh: number;
};

export type Reading = {
  /** ISO-8601 timestamp of the reading. */
  ts: string;
  /** Room id this reading belongs to (e.g. "301", "b4"). */
  room: string;
  /** Per-channel data. EM Mini Gen4 reports a single entry at idx 0. */
  channels: ChannelReading[];
  /** Optional raw Shelly payload, kept for debugging. */
  raw?: unknown;
};
