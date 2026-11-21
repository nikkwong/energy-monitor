import { rm } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { emptySeries } from "./aggregate.ts";
import {
  pathsForTenant,
  readRooms,
  saveRoomLeases,
  setLeaseEmail,
  writeRooms,
} from "./data.ts";
import { isValidEmail } from "./email.ts";
import { normalizeRoomModalities, sanitizeRoom } from "./monitors.ts";
import { fmtAxisDollars } from "../pages/common.ts";
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
});
