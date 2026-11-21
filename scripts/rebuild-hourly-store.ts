#!/usr/bin/env bun
/**
 * Rebuild data/tenants/<tenantId>/usage.sqlite from the JSONL source-of-truth files.
 *
 * Stop the dashboard before running with --apply so no reading can arrive
 * between the final import and the atomic database replacement.
 */

import { mkdir, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  hourlyDbPathForTenant,
  HourlyStore,
} from "../src/lib/hourly-store.ts";
import { iterDailyRollups, iterReadings, pathsForTenant } from "../src/lib/data.ts";
import { loadTenantsConfig, requireTenant } from "../src/lib/tenants.ts";

function argValue(name: string): string | null {
  const idx = process.argv.indexOf(name);
  return idx === -1 ? null : (process.argv[idx + 1] ?? null);
}

const APPLY = process.argv.includes("--apply");
const ALLOW_SMALL = process.argv.includes("--allow-small");
const cfg = await loadTenantsConfig();
const tenantId = argValue("--tenant") ?? cfg.defaultTenantId;
await requireTenant(tenantId);

const tenantPaths = pathsForTenant(tenantId);
const dbPath = hourlyDbPathForTenant(tenantId);
const TEMP_PATH = resolve(tenantPaths.dataDir, `usage.sqlite.rebuild-${process.pid}`);

if (!APPLY) {
  console.log("Hourly SQLite store rebuild (dry run).");
  console.log(`Tenant: ${tenantId}`);
  console.log(`Data directory: ${tenantPaths.dataDir}`);
  console.log("Stop the dashboard, then run:");
  console.log(`  bun run rebuild:index --tenant ${tenantId} --apply`);
  process.exit(0);
}

console.log(`reading source data from ${tenantPaths.dataDir}`);
await mkdir(tenantPaths.dataDir, { recursive: true });
await rm(TEMP_PATH, { force: true });
const store = new HourlyStore(TEMP_PATH);
let rollups = 0;
let readings = 0;
let pending = 0;

function begin(): void {
  store.db.run("BEGIN");
}

function checkpoint(): void {
  store.db.run("COMMIT");
  pending = 0;
  begin();
}

try {
  begin();
  for await (const row of iterDailyRollups(tenantId)) {
    store.addDailyRollup(row);
    rollups++;
    pending++;
    if (pending >= 100_000) checkpoint();
  }

  for await (const reading of iterReadings(tenantId)) {
    store.addReading(reading, { transaction: false });
    readings++;
    pending++;
    if (pending >= 100_000) {
      checkpoint();
      console.log(`imported ${readings.toLocaleString()} raw readings`);
    }
  }

  if (!ALLOW_SMALL && readings + rollups < 100) {
    throw new Error(
      `refusing to activate an index built from only ${readings} readings and ` +
        `${rollups} rollups; check DATA_DIR or pass --allow-small if intentional`,
    );
  }

  store.db.run("COMMIT");
  store.markReady();
  store.db.run("ANALYZE");
  store.close();

  await rm(dbPath + "-wal", { force: true });
  await rm(dbPath + "-shm", { force: true });
  await rm(dbPath, { force: true });
  await rename(TEMP_PATH, dbPath);

  console.log(`imported ${rollups.toLocaleString()} daily rollups`);
  console.log(`imported ${readings.toLocaleString()} raw readings`);
  console.log(`rebuilt ${dbPath}`);
} catch (err) {
  try {
    store.db.run("ROLLBACK");
  } catch {
    // The transaction may already have committed.
  }
  store.close();
  await rm(TEMP_PATH, { force: true });
  throw err;
}
