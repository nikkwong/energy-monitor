export type DebugTrafficEntry = {
  id: number;
  at: string;
  method: string;
  path: string;
  roomId?: string;
  monitorId?: string;
  status: number;
  ok: boolean;
  message: string;
  remoteIp?: string;
  userAgent?: string;
  contentType?: string;
  query?: Record<string, string>;
  bodyParseOk?: boolean;
  normalized?: {
    hasReading: boolean;
    powerW: number;
    totalEnergyWh: number;
    ts: string;
    ip?: string;
  };
  autoRegistered?: {
    newRoom: boolean;
    newMonitor: boolean;
  };
};

const MAX_DEBUG_TRAFFIC = 200;
const traffic: DebugTrafficEntry[] = [];
let nextId = 1;

export function recordTraffic(
  entry: Omit<DebugTrafficEntry, "id" | "at" | "ok"> & {
    at?: string;
  },
): void {
  traffic.unshift({
    id: nextId++,
    at: entry.at ?? new Date().toISOString(),
    ok: entry.status >= 200 && entry.status < 300,
    ...entry,
  });
  if (traffic.length > MAX_DEBUG_TRAFFIC) traffic.length = MAX_DEBUG_TRAFFIC;
}

export function recentTraffic(): DebugTrafficEntry[] {
  return traffic;
}

export function requestMeta(req: Request): Pick<
  DebugTrafficEntry,
  "method" | "path" | "remoteIp" | "userAgent" | "contentType" | "query"
> {
  const url = new URL(req.url);
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return {
    method: req.method,
    path: url.pathname,
    remoteIp:
      forwarded ||
      req.headers.get("x-real-ip") ||
      req.headers.get("cf-connecting-ip") ||
      undefined,
    userAgent: req.headers.get("user-agent") ?? undefined,
    contentType: req.headers.get("content-type") ?? undefined,
    query: Object.fromEntries(url.searchParams),
  };
}
