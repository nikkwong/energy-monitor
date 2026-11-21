#!/usr/bin/env bun

import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { DATA_DIR, loadTenantsConfig, requireTenant } from "../src/lib/tenants.ts";
import { pathsForTenant } from "../src/lib/data.ts";
import type { RoomsConfig } from "../src/lib/types.ts";

const tenantArgIndex = process.argv.indexOf("--tenant");
const explicitTenantId =
  tenantArgIndex === -1 ? null : (process.argv[tenantArgIndex + 1] ?? null);
const apply = process.argv.includes("--apply");

const cfg = await loadTenantsConfig();
const tenantId = explicitTenantId ?? cfg.defaultTenantId;
await requireTenant(tenantId);
const destination = pathsForTenant(tenantId);

console.log(`DATA_DIR: ${DATA_DIR}`);
console.log(`Target tenant: ${tenantId} (${destination.dataDir})\n`);

async function exists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch((err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    });
}

async function migrateRoomsJson(): Promise<void> {
  const source = resolve(DATA_DIR, "rooms.json");
  const target = destination.rooms;
  if (!(await exists(source))) return;

  if (await exists(target)) {
    const [sourceText, targetText] = await Promise.all([
      readFile(source, "utf8"),
      readFile(target, "utf8"),
    ]);
    if (sourceText === targetText) {
      console.log(`${source} already matches ${target} (removing legacy copy)`);
      if (apply) await rm(source);
      return;
    }
    const sourceCfg = JSON.parse(sourceText) as RoomsConfig;
    const targetCfg = JSON.parse(targetText) as RoomsConfig;
    const targetCount = Object.keys(targetCfg.rooms ?? {}).length;
    if (targetCount === 0) {
      console.log(`${source} -> ${target} (replacing empty auto-created rooms.json)`);
      if (apply) {
        await mkdir(resolve(target, ".."), { recursive: true });
        await rename(source, target);
      }
      return;
    }
    // Merge: keep any new target rooms, but let curated legacy rooms win on conflict.
    const merged: RoomsConfig = {
      rooms: {
        ...(targetCfg.rooms ?? {}),
        ...(sourceCfg.rooms ?? {}),
      },
    };
    console.log(
      `${source} + ${target} -> ${target} (merging ${Object.keys(sourceCfg.rooms ?? {}).length} legacy room(s) with ${targetCount} existing room(s))`,
    );
    if (apply) {
      const tmp = target + ".tmp";
      await writeFile(tmp, JSON.stringify(merged, null, 2) + "\n", "utf8");
      await rename(tmp, target);
      await rename(source, `${source}.migrated-${Date.now()}`);
    }
    return;
  }

  console.log(`${source} -> ${target}`);
  if (!apply) return;
  await mkdir(resolve(target, ".."), { recursive: true });
  await rename(source, target);
}

let mergedAnyReadingShards = false;

async function migrateReadingsDir(): Promise<void> {
  const sourceDir = resolve(DATA_DIR, "readings");
  const targetDir = destination.readingsDir;
  if (!(await exists(sourceDir))) return;

  if (!(await exists(targetDir))) {
    console.log(`${sourceDir} -> ${targetDir}`);
    if (apply) {
      await mkdir(resolve(targetDir, ".."), { recursive: true });
      await rename(sourceDir, targetDir);
    }
    return;
  }

  const entries = (await readdir(sourceDir)).sort();
  if (entries.length === 0) {
    console.log(`${sourceDir} is empty (removing)`);
    if (apply) await rm(sourceDir, { recursive: true });
    return;
  }

  for (const name of entries) {
    const srcFile = resolve(sourceDir, name);
    const dstFile = resolve(targetDir, name);
    if (!(await exists(dstFile))) {
      console.log(`${srcFile} -> ${dstFile}`);
      if (apply) await rename(srcFile, dstFile);
    } else {
      mergedAnyReadingShards = true;
      console.log(`${srcFile} + ${dstFile} -> ${dstFile} (prepending legacy history before newer readings)`);
      if (apply) {
        const [legacyContent, newerContent] = await Promise.all([
          readFile(srcFile, "utf8"),
          readFile(dstFile, "utf8"),
        ]);
        const sep = legacyContent.endsWith("\n") || !legacyContent ? "" : "\n";
        const tmp = dstFile + ".tmp";
        await writeFile(tmp, legacyContent + sep + newerContent, "utf8");
        await rename(tmp, dstFile);
        await rm(srcFile);
      }
    }
  }
  if (apply) {
    const remaining = await readdir(sourceDir);
    if (remaining.length === 0) await rm(sourceDir, { recursive: true });
  }
}

async function moveSimple(name: string, target: string): Promise<void> {
  const source = resolve(DATA_DIR, name);
  if (!(await exists(source))) return;
  if (await exists(target)) {
    throw new Error(`refusing to overwrite existing ${target}; move or merge it manually`);
  }
  console.log(`${source} -> ${target}`);
  if (!apply) return;
  await mkdir(resolve(target, ".."), { recursive: true });
  await rename(source, target);
}

if (apply) await mkdir(destination.dataDir, { recursive: true });
await migrateRoomsJson();
await moveSimple("readings.jsonl", destination.readings);
await migrateReadingsDir();
await moveSimple("rollups", destination.rollupsDir);
await moveSimple("archive", resolve(destination.dataDir, "archive"));

const sqliteTarget = resolve(destination.dataDir, "usage.sqlite");
if (!mergedAnyReadingShards && !(await exists(sqliteTarget))) {
  await moveSimple("usage.sqlite", sqliteTarget);
  await moveSimple("usage.sqlite-wal", `${sqliteTarget}-wal`);
  await moveSimple("usage.sqlite-shm", `${sqliteTarget}-shm`);
} else if (await exists(resolve(DATA_DIR, "usage.sqlite"))) {
  console.log(
    `\nnote: reading shards were merged or ${sqliteTarget} already exists; after migration run:\n` +
      `  DATA_DIR=${DATA_DIR} bun run rebuild:index --tenant ${tenantId} --apply`,
  );
}

if (!apply) {
  console.log(
    `\ndry run only; stop the service and rerun with:\n` +
      `  DATA_DIR=${DATA_DIR} bun run migrate:tenant-layout --tenant ${tenantId} --apply`,
  );
} else {
  console.log(`\nlegacy data migrated into tenant ${tenantId}.`);
}
