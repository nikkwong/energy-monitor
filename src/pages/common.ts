// Small shared client helpers: number formatting, freshness, fetch.

export function fmtKWh(kwh: number): string {
  if (!Number.isFinite(kwh)) return "—";
  if (kwh >= 100) return kwh.toFixed(0);
  if (kwh >= 10) return kwh.toFixed(1);
  return kwh.toFixed(2);
}

export function fmtW(w: number | null | undefined): string {
  if (w == null || !Number.isFinite(w)) return "—";
  if (Math.abs(w) >= 1000) return (w / 1000).toFixed(2) + " kW";
  return w.toFixed(0) + " W";
}

export function fmtRelativeTime(iso: string | null): string {
  if (!iso) return "no data yet";
  const t = new Date(iso).getTime();
  const ms = Date.now() - t;
  if (ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function freshnessClass(iso: string | null): "live" | "stale" | "dead" {
  if (!iso) return "dead";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 5 * 60 * 1000) return "live";
  if (ms < 60 * 60 * 1000) return "stale";
  return "dead";
}

export async function jget<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`${r.status} ${r.statusText}: ${text || url}`);
  }
  return (await r.json()) as T;
}

export async function jpost<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`${r.status} ${r.statusText}: ${text || url}`);
  }
  return (await r.json()) as T;
}

export function startOfMonthLocal(): Date {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d;
}
