#!/usr/bin/env bun

import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { DATA_DIR, requireTenant } from "../src/lib/tenants.ts";
import { pathsForTenant } from "../src/lib/data.ts";

const tenantArgIndex = process.argv.indexOf("--tenant");
const tenantId = tenantArgIndex === -1 ? null : (process.argv[tenantArgIndex + 1] ?? null);
const apply = process.argv.includes("--apply");

if (!tenantId) {
  console.error("usage: bun run migrate:tenant-layout --tenant TENANT_ID [--apply]");
  process.exit(1);
}

await requireTenant(tenantId);
const destination = pathsForTenant(tenantId);

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true).catch((err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  });
}

async function move(name: string, target: string): Promise<void> {
  const source = resolve(DATA_DIR, name);
  if (!(await exists(source))) return;
  if (await exists(target)) {
    if (name === "rooms.json") {
      const [sourceText, targetText] = await Promise.all([
        readFile(source, "utf8"),
        readFile(target, "utf8"),
      ]);
      if (sourceText === targetText) {
        console.log(`${source} already matches ${target}`);
        if (apply) await rm(source);
        return;
      }
    }
    throw new Error(`refusing to overwrite existing ${target}; merge it manually`);
  }
  console.log(`${source} -> ${target}`);
  if (!apply) return;
  await mkdir(resolve(target, ".."), { recursive: true });
  await rename(source, target);
}

if (apply) await mkdir(destination.dataDir, { recursive: true });
await move("rooms.json", destination.rooms);
await move("readings.jsonl", destination.readings);
await move("readings", destination.readingsDir);
await move("rollups", destination.rollupsDir);
await move("archive", resolve(destination.dataDir, "archive"));

if (!apply) {
  console.log("\ndry run only; rerun with --apply after reviewing the moves.");
} else {
  console.log(`\nlegacy data moved into tenant ${tenantId}.`);
}
