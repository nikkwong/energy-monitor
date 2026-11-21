import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { emptySeries } from "./aggregate.ts";
import {
  appendReading,
  pathsForTenant,
  readRooms,
  roomHasPowerReadings,
  saveRoomLeases,
  setLeaseEmail,
  setRoomModalities,
  writeRooms,
} from "./data.ts";
import { isValidEmail } from "./email.ts";
import { normalizeRoomModalities, sanitizeRoom } from "./monitors.ts";
import {
  buildModalityViewSearch,
  deriveModalityView,
  fmtAxisDollars,
} from "../pages/common.ts";
import {
  getTenant,
  type TenantsConfig,
  validateTenantsConfig,
} from "./tenants.ts";

const valid: TenantsConfig = {
  schemaVersion: 1,
  defaultTenantId: "alpha",
  tenants: [
    {
      tenantId: "alpha",
      label: "Alpha",
      modalities: { power: true, water: false },
    },
    {
      tenantId: "beta",
      label: "Beta",
      modalities: { power: false, water: true },
    },
  ],
};

describe("tenant registry", () => {
  test("validates modalities and default tenant", () => {
    expect(validateTenantsConfig(valid)).toEqual(valid);
  });

  test("rejects duplicate tenant ids", () => {
    expect(() =>
      validateTenantsConfig({
        ...valid,
        tenants: [valid.tenants[0], valid.tenants[0]],
      }),
    ).toThrow("duplicate tenantId");
  });

  test("rejects path traversal ids", () => {
    expect(() =>
      validateTenantsConfig({
        ...valid,
        defaultTenantId: "../alpha",
        tenants: [{ ...valid.tenants[0], tenantId: "../alpha" }],
      }),
    ).toThrow("safe path segment");
    expect(() => pathsForTenant("../alpha")).toThrow("invalid tenantId");
  });

  test("isolates identical room filenames by tenant", () => {
    const alpha = pathsForTenant("alpha");
    const beta = pathsForTenant("beta");
    expect(alpha.rooms).not.toBe(beta.rooms);
    expect(alpha.rooms).toEndWith("/tenants/alpha/rooms.json");
    expect(beta.rooms).toEndWith("/tenants/beta/rooms.json");
  });

  test("unknown tenant lookup returns null", async () => {
    expect(await getTenant("missing")).toBeNull();
  });

  test("builds bucketed empty series and formats dollar y-axis ticks", () => {
    const pts = emptySeries({
      from: new Date("2026-11-01T00:00:00Z"),
      to: new Date("2026-11-04T00:00:00Z"),
      bucket: "day",
    });
    expect(pts).toHaveLength(3);
    expect(pts.every((p) => p.energyKWh === 0)).toBe(true);

    expect(fmtAxisDollars(0)).toBe("$0");
    expect(fmtAxisDollars(1.5)).toBe("$1.50");
    expect(fmtAxisDollars(25)).toBe("$25");

    const both = { power: true, water: true };
    expect(deriveModalityView("", both)).toBe("all");
    expect(deriveModalityView("?view=water", both)).toBe("water");
    expect(deriveModalityView("?view=power", both)).toBe("power");
    expect(deriveModalityView("?view=bogus", both)).toBe("all");
    expect(deriveModalityView("?view=water", { power: true, water: false })).toBe("power");
    expect(deriveModalityView("?view=power", { power: false, water: true })).toBe("water");
    expect(buildModalityViewSearch("?foo=1", "power")).toBe("?foo=1&view=power");
    expect(buildModalityViewSearch("?view=power", "all")).toBe("?view=all");
  });

  test("normalizes per-room modalities with true defaults", () => {
    expect(normalizeRoomModalities()).toEqual({ power: true, water: true });
    expect(normalizeRoomModalities({ power: false })).toEqual({ power: false, water: true });
    expect(
      sanitizeRoom({
        label: "Room 301",
        modalities: { power: true, water: false },
        leases: [],
      }).modalities,
    ).toEqual({ power: true, water: false });
  });

  test("validates and persists lease email attached to a time period", async () => {
    expect(isValidEmail("tenant@example.com")).toBe(true);
    expect(isValidEmail("first.last+301@sub.domain.org")).toBe(true);
    expect(isValidEmail("")).toBe(false);
    expect(isValidEmail("not-an-email")).toBe(false);
    expect(isValidEmail("bad@localhost")).toBe(false);
    expect(isValidEmail("two@@example.com")).toBe(false);
    expect(isValidEmail("a..b@example.com")).toBe(false);

    const tmpTenant = `__test_lease_email_${process.pid}`;
    const tmpPaths = pathsForTenant(tmpTenant);
    try {
      await writeRooms(tmpTenant, {
        rooms: {
          "301": {
            label: "Room 301",
            leases: [
              {
                id: "lease-301-1",
                tenant: "",
                startDate: "2026-09-01",
                endDate: null,
              },
            ],
          },
        },
      });

      const saved = await setLeaseEmail(
        tmpTenant,
        "301",
        "lease-301-1",
        "  resident@example.com  ",
      );
      expect(saved.email).toBe("resident@example.com");

      // Editing start/end dates via saveRoomLeases preserves the attached email.
      const updated = await saveRoomLeases(tmpTenant, "301", [
        {
          id: "lease-301-1",
          startDate: "2026-08-15",
          endDate: null,
        },
      ]);
      expect(updated[0]?.email).toBe("resident@example.com");

      await expect(
        setLeaseEmail(tmpTenant, "301", "lease-301-1", "invalid-email"),
      ).rejects.toThrow("invalid email address");

      const cleared = await setLeaseEmail(tmpTenant, "301", "lease-301-1", "");
      expect(cleared.email).toBeUndefined();
      const reloaded = await readRooms(tmpTenant);
      expect(reloaded.rooms["301"]?.leases[0]?.email).toBeUndefined();
    } finally {
      await rm(tmpPaths.dataDir, { recursive: true, force: true });
    }
  });

  test("prevents turning off a room utility once reading data exists", async () => {
    const tmpTenant = `__test_room_mod_lock_${process.pid}`;
    const tmpPaths = pathsForTenant(tmpTenant);
    try {
      await writeRooms(tmpTenant, {
        rooms: {
          "301": {
            label: "Room 301",
            leases: [],
          },
        },
      });

      expect(await roomHasPowerReadings(tmpTenant, "301")).toBe(false);
      // With no readings, power can be turned off and back on.
      expect(await setRoomModalities(tmpTenant, "301", { power: false })).toEqual({
        power: false,
        water: true,
      });
      expect(await setRoomModalities(tmpTenant, "301", { power: true })).toEqual({
        power: true,
        water: true,
      });

      await appendReading(tmpTenant, {
        ts: "2026-11-21T10:00:00Z",
        room: "301",
        monitor: "default",
        powerW: 110,
        totalEnergyWh: 5000,
      });
      expect(await roomHasPowerReadings(tmpTenant, "301")).toBe(true);

      // Now turning power off is rejected, while water (no readings) can still be toggled.
      await expect(
        setRoomModalities(tmpTenant, "301", { power: false }),
      ).rejects.toThrow("has reading data");
      expect(await setRoomModalities(tmpTenant, "301", { water: false })).toEqual({
        power: true,
        water: false,
      });
    } finally {
      await rm(tmpPaths.dataDir, { recursive: true, force: true });
    }
  });

  test("migrate-tenant-layout moves external DATA_DIR layout into tenants/5214", async () => {
    const tmpDataDir = await mkdtemp(join(tmpdir(), "energy-monitor-data-"));
    try {
      await mkdir(join(tmpDataDir, "readings"), { recursive: true });
      await mkdir(join(tmpDataDir, "tenants", "5214"), { recursive: true });
      await writeFile(
        join(tmpDataDir, "rooms.json"),
        JSON.stringify({ rooms: { "301": { label: "Room 301", leases: [] } } }) + "\n",
      );
      // Simulate auto-created empty rooms.json from booting before migration.
      await writeFile(
        join(tmpDataDir, "tenants", "5214", "rooms.json"),
        JSON.stringify({ rooms: {} }) + "\n",
      );
      await writeFile(
        join(tmpDataDir, "readings", "2026-11.jsonl"),
        '{"ts":"2026-11-01T00:00:00Z","room":"301","monitor":"default","powerW":50,"totalEnergyWh":100}\n',
      );
      await writeFile(join(tmpDataDir, "usage.sqlite"), "sqlite-bytes");
      await writeFile(join(tmpDataDir, "usage.sqlite-wal"), "wal-bytes");
      await writeFile(join(tmpDataDir, "usage.sqlite-shm"), "shm-bytes");

      const proc = Bun.spawn(
        ["bun", "run", "scripts/migrate-tenant-layout.ts", "--tenant", "5214", "--apply"],
        {
          cwd: process.cwd(),
          env: { ...process.env, DATA_DIR: tmpDataDir },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);

      const migratedRooms = JSON.parse(
        await readFile(join(tmpDataDir, "tenants", "5214", "rooms.json"), "utf8"),
      );
      expect(migratedRooms.rooms["301"].label).toBe("Room 301");
      const migratedShard = await readFile(
        join(tmpDataDir, "tenants", "5214", "readings", "2026-11.jsonl"),
        "utf8",
      );
      expect(migratedShard).toContain('"totalEnergyWh":100');
      expect(await readFile(join(tmpDataDir, "tenants", "5214", "usage.sqlite"), "utf8")).toBe(
        "sqlite-bytes",
      );
    } finally {
      await rm(tmpDataDir, { recursive: true, force: true });
    }
  });
});
