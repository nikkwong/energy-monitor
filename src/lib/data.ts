import { mkdir, readFile, writeFile, appendFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import type { Reading, RoomsConfig } from "./types.ts";

const DATA_DIR = resolve(process.cwd(), "data");
const ROOMS_PATH = resolve(DATA_DIR, "rooms.json");
const READINGS_PATH = resolve(DATA_DIR, "readings.jsonl");

// Single in-process write queue. Serializes appends and atomic rewrites so we
// never interleave a reading append with a rooms.json rewrite, and so concurrent
// Shelly POSTs don't tear lines.
let writeChain: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  // Swallow rejection on the chain so one failure doesn't poison subsequent writes,
  // but still surface the error to the caller.
  writeChain = next.catch(() => {});
  return next;
}

async function ensureDataDir(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}

export async function readRooms(): Promise<RoomsConfig> {
  await ensureDataDir();
  try {
    const text = await readFile(ROOMS_PATH, "utf8");
    const parsed = JSON.parse(text) as RoomsConfig;
    if (!parsed.rooms || typeof parsed.rooms !== "object") {
      return { rooms: {} };
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      const empty: RoomsConfig = { rooms: {} };
      await writeRooms(empty);
      return empty;
    }
    throw err;
  }
}

export async function writeRooms(cfg: RoomsConfig): Promise<void> {
  await ensureDataDir();
  await enqueue(async () => {
    const tmp = ROOMS_PATH + ".tmp";
    await writeFile(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    await rename(tmp, ROOMS_PATH);
  });
}

export async function appendReading(r: Reading): Promise<void> {
  await ensureDataDir();
  const line = JSON.stringify(r) + "\n";
  await enqueue(() => appendFile(READINGS_PATH, line, "utf8"));
}

/**
 * Stream readings in file order. The file is append-only, so this is roughly
 * chronological — but callers that need strict order should sort by `ts`.
 */
export async function* iterReadings(): AsyncGenerator<Reading> {
  await ensureDataDir();
  const file = Bun.file(READINGS_PATH);
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
      if (!line) continue;
      try {
        yield JSON.parse(line) as Reading;
      } catch {
        // skip malformed line
      }
    }
  }
  buf += decoder.decode();
  const tail = buf.trim();
  if (tail) {
    try {
      yield JSON.parse(tail) as Reading;
    } catch {
      // skip malformed tail
    }
  }
}

export const paths = {
  dataDir: DATA_DIR,
  rooms: ROOMS_PATH,
  readings: READINGS_PATH,
} as const;
