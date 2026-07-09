#!/usr/bin/env bun
/**
 * Roll monthly raw shards into daily totals, then gzip the raw shard.
 *
 * Examples:
 *   bun run rollup --before 2025-07        # dry run
 *   bun run rollup --before 2025-07 --apply
 *
 * `--before YYYY-MM` archives shards strictly older than that month.
 */

import { gzipSync } from "node:zlib";
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { DailyRollup, Reading } from "../src/lib/types.ts";

const DATA_DIR = resolve(process.cwd(), "data");
const READINGS_DIR = resolve(DATA_DIR, "readings");
const ROLLUPS_DIR = resolve(DATA_DIR, "rollups");
const ARCHIVE_DIR = resolve(DATA_DIR, "archive", "readings");
const DAILY_ROLLUP_PATH = resolve(ROLLUPS_DIR, "daily.jsonl");

const APPLY = process.argv.includes("--apply");
const before = argValue("--before");

if (!before || !/^\d{4}-\d{2}$/.test(before)) {
  console.error("usage: bun run rollup --before YYYY-MM [--apply]");
  process.exit(1);
}

function argValue(name: string): string | null {
  const idx = process.argv.indexOf(name);
  return idx === -1 ? null : (process.argv[idx + 1] ?? null);
}

function shardMonth(name: string): string | null {
  return /^\d{4}-\d{2}\.jsonl$/.test(name) ? name.slice(0, 7) : null;
}

function readingFromLine(line: string): Reading | null {
  try {
    const parsed = JSON.parse(line) as Partial<Reading>;
    if (
      typeof parsed.ts !== "string" ||
      typeof parsed.room !== "string" ||
      typeof parsed.monitor !== "string" ||
      typeof parsed.powerW !== "number" ||
      typeof parsed.totalEnergyWh !== "number"
    ) {
      return null;
    }
    return parsed as Reading;
  } catch {
    return null;
  }
}

async function* lines(path: string): AsyncGenerator<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) return;
  const decoder = new TextDecoder();
  let buf = "";
  // @ts-expect-error - Bun's file stream is async iterable of Uint8Array
  for await (const chunk of file.stream()) {
    buf += decoder.decode(chunk as Uint8Array, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield line;
    }
  }
  buf += decoder.decode();
  const tail = buf.trim();
  if (tail) yield tail;
}

const entries = await readdir(READINGS_DIR).catch((err) => {
  if ((err as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
  throw err;
});

const shards = entries
  .map((name) => ({ name, month: shardMonth(name) }))
  .filter((x): x is { name: string; month: string } => !!x.month)
  .filter((x) => x.month < before)
  .sort((a, b) => a.month.localeCompare(b.month));

if (shards.length === 0) {
  console.log(`no shards older than ${before}`);
  process.exit(0);
}

console.log(`rolling ${shards.length} shard(s) older than ${before}`);

const last = new Map<string, number>();
const daily = new Map<string, DailyRollup>();
let rawLines = 0;
let malformed = 0;

for (const shard of shards) {
  const path = resolve(READINGS_DIR, shard.name);
  for await (const line of lines(path)) {
    rawLines++;
    const r = readingFromLine(line);
    if (!r) {
      malformed++;
      continue;
    }

    const key = `${r.room}|${r.monitor}`;
    const prev = last.get(key);
    last.set(key, r.totalEnergyWh);
    if (prev === undefined) continue;

    const delta = r.totalEnergyWh - prev;
    if (delta <= 0) continue;

    const date = new Date(r.ts).toISOString().slice(0, 10);
    const rollupKey = `${date}|${r.room}|${r.monitor}`;
    const row =
      daily.get(rollupKey) ??
      ({ date, room: r.room, monitor: r.monitor, energyKWh: 0 } satisfies DailyRollup);
    row.energyKWh += delta / 1000;
    daily.set(rollupKey, row);
  }
}

console.log(`raw lines: ${rawLines}`);
console.log(`daily rollup rows: ${daily.size}`);
if (malformed) console.log(`malformed/skipped: ${malformed}`);

if (!APPLY) {
  console.log("\ndry run only. Re-run with --apply to write rollups and gzip shards.");
  process.exit(0);
}

await mkdir(ROLLUPS_DIR, { recursive: true });
await mkdir(ARCHIVE_DIR, { recursive: true });

const rows = [...daily.values()].sort((a, b) =>
  `${a.date}|${a.room}|${a.monitor}`.localeCompare(`${b.date}|${b.room}|${b.monitor}`),
);
await appendFile(
  DAILY_ROLLUP_PATH,
  rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
  "utf8",
);

for (const shard of shards) {
  const src = resolve(READINGS_DIR, shard.name);
  const gz = resolve(ARCHIVE_DIR, `${shard.name}.gz`);
  const data = await readFile(src);
  await writeFile(gz, gzipSync(data));
  await rm(src);
  console.log(`archived ${shard.name} -> ${gz}`);
}

console.log(`wrote ${rows.length} daily rows to ${DAILY_ROLLUP_PATH}`);
