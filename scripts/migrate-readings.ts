#!/usr/bin/env bun
/**
 * Split legacy `data/readings.jsonl` into monthly shards:
 *
 *   data/readings/2026-07.jsonl
 *   data/readings/2026-08.jsonl
 *
 * Default is a dry run. Use `--apply` to write shards and rename the legacy
 * file out of the hot path so the server no longer scans it.
 */

import { createWriteStream } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { resolve } from "node:path";

const DATA_DIR = resolve(process.cwd(), "data");
const LEGACY_PATH = resolve(DATA_DIR, "readings.jsonl");
const READINGS_DIR = resolve(DATA_DIR, "readings");
const APPLY = process.argv.includes("--apply");

function monthFromLine(line: string): string | null {
  try {
    const parsed = JSON.parse(line) as { ts?: unknown };
    if (typeof parsed.ts !== "string") return null;
    const d = new Date(parsed.ts);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 7);
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

await mkdir(READINGS_DIR, { recursive: true });

const counts = new Map<string, number>();
const writers = new Map<string, ReturnType<typeof createWriteStream>>();
let malformed = 0;
let total = 0;

function writerFor(month: string): ReturnType<typeof createWriteStream> {
  let w = writers.get(month);
  if (!w) {
    w = createWriteStream(resolve(READINGS_DIR, `${month}.jsonl`), {
      flags: "a",
    });
    writers.set(month, w);
  }
  return w;
}

for await (const line of lines(LEGACY_PATH)) {
  total++;
  const month = monthFromLine(line);
  if (!month) {
    malformed++;
    continue;
  }
  counts.set(month, (counts.get(month) ?? 0) + 1);
  if (APPLY) writerFor(month).write(line + "\n");
}

await Promise.all(
  [...writers.values()].map(
    (w) =>
      new Promise<void>((resolvePromise, reject) => {
        w.end((err?: Error | null) => {
          if (err) reject(err);
          else resolvePromise();
        });
      }),
  ),
);

console.log(`legacy readings: ${total}`);
for (const [month, count] of [...counts].sort()) {
  console.log(`  ${month}: ${count}`);
}
if (malformed) console.log(`malformed/skipped: ${malformed}`);

if (!APPLY) {
  console.log("\ndry run only. Re-run with: bun run migrate:readings --apply");
} else {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archived = resolve(DATA_DIR, `readings.jsonl.migrated-${stamp}`);
  await rename(LEGACY_PATH, archived);
  console.log(`\nwrote monthly shards and moved legacy file to ${archived}`);
}
