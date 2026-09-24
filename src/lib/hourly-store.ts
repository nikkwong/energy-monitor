import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import type { DailyRollup, Reading } from "./types.ts";

export type HourlyUsageRow = {
  hourMs: number;
  room: string;
  monitor: string;
  energyWh: number;
};

export type LatestStoredReading = {
  room: string;
  monitor: string;
  ts: string;
  tsMs: number;
  powerW: number;
  totalEnergyWh: number;
};

const DATA_DIR = resolve(process.env.DATA_DIR ?? resolve(process.cwd(), "data"));
export const HOURLY_DB_PATH = resolve(DATA_DIR, "usage.sqlite");
const HOUR_MS = 60 * 60 * 1000;

function hourStartMs(tsMs: number): number {
  return Math.floor(tsMs / HOUR_MS) * HOUR_MS;
}

export class HourlyStore {
  readonly db: Database;

  constructor(path = HOURLY_DB_PATH, opts: { wal?: boolean } = {}) {
    this.db = new Database(path, { create: true, strict: true });
    if (opts.wal) this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS hourly_usage (
        room TEXT NOT NULL,
        monitor TEXT NOT NULL,
        hour_ms INTEGER NOT NULL,
        energy_wh REAL NOT NULL,
        PRIMARY KEY (room, monitor, hour_ms)
      ) WITHOUT ROWID
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS hourly_usage_by_time
      ON hourly_usage (hour_ms, room, monitor)
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS counter_state (
        room TEXT NOT NULL,
        monitor TEXT NOT NULL,
        total_energy_wh REAL NOT NULL,
        PRIMARY KEY (room, monitor)
      ) WITHOUT ROWID
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS latest_readings (
        room TEXT NOT NULL,
        monitor TEXT NOT NULL,
        ts TEXT NOT NULL,
        ts_ms INTEGER NOT NULL,
        power_w REAL NOT NULL,
        total_energy_wh REAL NOT NULL,
        PRIMARY KEY (room, monitor)
      ) WITHOUT ROWID
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) WITHOUT ROWID
    `);
  }

  isReady(): boolean {
    const row = this.db
      .query<{ value: string }, []>(
        "SELECT value FROM metadata WHERE key = 'ready'",
      )
      .get();
    return row?.value === "1";
  }

  markReady(): void {
    this.db
      .query(
        `INSERT INTO metadata (key, value) VALUES ('ready', '1')
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run();
    this.db
      .query(
        `INSERT INTO metadata (key, value) VALUES ('rebuilt_at', ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(new Date().toISOString());
  }

  addReading(
    reading: Reading,
    opts: { transaction?: boolean } = {},
  ): void {
    const tsMs = new Date(reading.ts).getTime();
    if (!Number.isFinite(tsMs)) return;

    const write = () => {
      const previous = this.db
        .query<
          { totalEnergyWh: number },
          [string, string]
        >(
          `SELECT total_energy_wh AS totalEnergyWh
           FROM counter_state WHERE room = ? AND monitor = ?`,
        )
        .get(reading.room, reading.monitor);
      const deltaWh =
        previous && reading.totalEnergyWh > previous.totalEnergyWh
          ? reading.totalEnergyWh - previous.totalEnergyWh
          : 0;

      if (deltaWh > 0) {
        this.db
          .query(
            `INSERT INTO hourly_usage (room, monitor, hour_ms, energy_wh)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (room, monitor, hour_ms)
             DO UPDATE SET energy_wh = energy_wh + excluded.energy_wh`,
          )
          .run(
            reading.room,
            reading.monitor,
            hourStartMs(tsMs),
            deltaWh,
          );
      }

      this.db
        .query(
          `INSERT INTO counter_state (room, monitor, total_energy_wh)
           VALUES (?, ?, ?)
           ON CONFLICT (room, monitor)
           DO UPDATE SET total_energy_wh = excluded.total_energy_wh`,
        )
        .run(reading.room, reading.monitor, reading.totalEnergyWh);

      this.db
        .query(
          `INSERT INTO latest_readings
             (room, monitor, ts, ts_ms, power_w, total_energy_wh)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (room, monitor) DO UPDATE SET
             ts = excluded.ts,
             ts_ms = excluded.ts_ms,
             power_w = excluded.power_w,
             total_energy_wh = excluded.total_energy_wh
           WHERE excluded.ts_ms >= latest_readings.ts_ms`,
        )
        .run(
          reading.room,
          reading.monitor,
          reading.ts,
          tsMs,
          reading.powerW,
          reading.totalEnergyWh,
        );
    };
    if (opts.transaction === false) write();
    else this.db.transaction(write)();
  }

  addDailyRollup(row: DailyRollup): void {
    const hourMs = new Date(row.date + "T00:00:00Z").getTime();
    if (!Number.isFinite(hourMs) || row.energyKWh <= 0) return;
    this.db
      .query(
        `INSERT INTO hourly_usage (room, monitor, hour_ms, energy_wh)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (room, monitor, hour_ms)
         DO UPDATE SET energy_wh = energy_wh + excluded.energy_wh`,
      )
      .run(row.room, row.monitor, hourMs, row.energyKWh * 1000);
  }

  usageRows(from: Date, to: Date): HourlyUsageRow[] {
    const fromMs = Math.floor(from.getTime() / HOUR_MS) * HOUR_MS;
    return this.db
      .query<
        HourlyUsageRow,
        [number, number]
      >(
        `SELECT hour_ms AS hourMs, room, monitor, energy_wh AS energyWh
         FROM hourly_usage
         WHERE hour_ms >= ? AND hour_ms < ?
         ORDER BY hour_ms`,
      )
      .all(fromMs, to.getTime());
  }

  allUsageRows(to: Date): HourlyUsageRow[] {
    return this.db
      .query<
        HourlyUsageRow,
        [number]
      >(
        `SELECT hour_ms AS hourMs, room, monitor, energy_wh AS energyWh
         FROM hourly_usage
         WHERE hour_ms < ?
         ORDER BY hour_ms`,
      )
      .all(to.getTime());
  }

  latest(room?: string): LatestStoredReading[] {
    if (room) {
      return this.db
        .query<
          LatestStoredReading,
          [string]
        >(
          `SELECT room, monitor, ts, ts_ms AS tsMs, power_w AS powerW,
                  total_energy_wh AS totalEnergyWh
           FROM latest_readings WHERE room = ?`,
        )
        .all(room);
    }
    return this.db
      .query<LatestStoredReading, []>(
        `SELECT room, monitor, ts, ts_ms AS tsMs, power_w AS powerW,
                total_energy_wh AS totalEnergyWh
         FROM latest_readings`,
      )
      .all();
  }

  close(): void {
    this.db.close();
  }
}

let defaultStore: HourlyStore | null = null;

export function hourlyStore(): HourlyStore {
  defaultStore ??= new HourlyStore(HOURLY_DB_PATH, { wal: true });
  return defaultStore;
}

export function hourlyStoreReady(): boolean {
  return hourlyStore().isReady();
}
