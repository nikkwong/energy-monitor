// Small shared client helpers: number formatting, freshness, fetch.

export const DEFAULT_ELECTRICITY_RATE_PER_KWH = 0.1338;
export const DEFAULT_WATER_RATE_PER_GAL = 0.015;
const LEGACY_ELECTRICITY_RATE_STORAGE_KEY = "5214:electricityRatePerKWh";
const LEGACY_THEME_STORAGE_KEY = "5214:theme";

export type Theme = "dark" | "light";

function tenantStorageKey(tenantId: string, key: string): string {
  return `energy-monitor:${tenantId}:${key}`;
}

function readTenantStorage(tenantId: string, key: string, legacyKey?: string): string | null {
  const current = window.localStorage.getItem(tenantStorageKey(tenantId, key));
  if (current != null) return current;
  if (tenantId !== "5214" || !legacyKey) return null;
  const legacy = window.localStorage.getItem(legacyKey);
  if (legacy != null) window.localStorage.setItem(tenantStorageKey(tenantId, key), legacy);
  return legacy;
}

export function getStoredTheme(tenantId = "global"): Theme {
  try {
    const raw = readTenantStorage(tenantId, "theme", LEGACY_THEME_STORAGE_KEY);
    return raw === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(theme: Theme, tenantId = "global"): void {
  const root = document.documentElement;
  if (theme === "light") {
    root.setAttribute("data-theme", "light");
  } else {
    root.removeAttribute("data-theme");
  }
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) {
    meta.setAttribute("content", theme === "light" ? "light" : "dark");
  }
  try {
    window.localStorage.setItem(tenantStorageKey(tenantId, "theme"), theme);
  } catch {
    // Ignore storage failures.
  }
  document
    .querySelectorAll<HTMLButtonElement>("[data-theme-toggle]")
    .forEach((btn) => syncThemeToggleButton(btn, theme));
}

function syncThemeToggleButton(btn: HTMLButtonElement, theme: Theme): void {
  const isLight = theme === "light";
  btn.setAttribute("aria-pressed", isLight ? "true" : "false");
  btn.setAttribute(
    "aria-label",
    isLight ? "Switch to dark mode" : "Switch to light mode",
  );
  btn.title = isLight ? "Dark mode" : "Light mode";
  btn.textContent = isLight ? "☀" : "☾";
}

/** Read a `--token` from the document root (for Chart.js and other canvas APIs). */
export function themeCssVar(name: `--${string}`): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export type ChartAxisAndTooltipConfig = {
  yAxisLabel?: string;
  showLegend?: boolean;
  yTickCallback?: (tickValue: string | number) => string;
};

export function chartAxisAndTooltipOptions(cfg?: ChartAxisAndTooltipConfig): {
  plugins: {
    legend: {
      display: boolean;
      align?: "start" | "center" | "end";
      labels?: { color: string; usePointStyle: boolean; boxWidth: number };
    };
    tooltip: {
      backgroundColor: string;
      borderColor: string;
      borderWidth: number;
      titleColor: string;
      bodyColor: string;
    };
  };
  scales: {
    x: {
      grid: { color: string };
      ticks: { color: string; maxRotation: number; autoSkipPadding: number };
    };
    y: {
      grid: { color: string };
      ticks: {
        color: string;
        callback?: (tickValue: string | number) => string;
      };
      beginAtZero: boolean;
      title: { display: boolean; text: string; color: string };
    };
  };
} {
  const grid = themeCssVar("--chart-grid");
  const ticks = themeCssVar("--text-dim");
  const tooltipBg = themeCssVar("--bg-elev");
  const tooltipBorder = themeCssVar("--border");
  const tooltipText = themeCssVar("--text");
  const yAxisLabel = cfg?.yAxisLabel ?? "kWh";
  const showLegend = cfg?.showLegend ?? false;
  return {
    plugins: {
      legend: showLegend
        ? {
            display: true,
            align: "end",
            labels: {
              color: tooltipText,
              usePointStyle: true,
              boxWidth: 8,
            },
          }
        : { display: false },
      tooltip: {
        backgroundColor: tooltipBg,
        borderColor: tooltipBorder,
        borderWidth: 1,
        titleColor: tooltipText,
        bodyColor: tooltipText,
      },
    },
    scales: {
      x: {
        grid: { color: grid },
        ticks: { color: ticks, maxRotation: 0, autoSkipPadding: 12 },
      },
      y: {
        grid: { color: grid },
        ticks: cfg?.yTickCallback
          ? { color: ticks, callback: cfg.yTickCallback }
          : { color: ticks },
        beginAtZero: true,
        title: { display: true, text: yAxisLabel, color: ticks },
      },
    },
  };
}

export function setupThemeToggle(
  tenantId = "global",
  onChange?: (theme: Theme) => void,
): void {
  const theme = getStoredTheme(tenantId);
  applyTheme(theme, tenantId);
  document.querySelectorAll<HTMLButtonElement>("[data-theme-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next: Theme = getStoredTheme(tenantId) === "light" ? "dark" : "light";
      applyTheme(next, tenantId);
      onChange?.(next);
    });
  });
}

export function fmtKWh(kwh: number): string {
  if (!Number.isFinite(kwh)) return "—";
  if (kwh >= 100) return kwh.toFixed(0);
  if (kwh >= 10) return kwh.toFixed(1);
  return kwh.toFixed(2);
}

export function fmtGal(gal: number): string {
  if (!Number.isFinite(gal)) return "—";
  if (gal >= 100) return gal.toFixed(0);
  if (gal >= 10) return gal.toFixed(1);
  return gal.toFixed(2);
}

export function fmtGpm(gpm: number | null | undefined): string {
  if (gpm == null || !Number.isFinite(gpm)) return "—";
  return gpm.toFixed(1) + " gpm";
}

export function fmtAxisDollars(v: number): string {
  if (!Number.isFinite(v)) return "";
  if (v === 0) return "$0";
  if (Math.abs(v) >= 100 || (Math.abs(v) >= 10 && Number.isInteger(v))) {
    return `$${v.toFixed(0)}`;
  }
  return `$${v.toFixed(2)}`;
}

export function fmtW(w: number | null | undefined): string {
  if (w == null || !Number.isFinite(w)) return "—";
  if (Math.abs(w) >= 1000) return (w / 1000).toFixed(2) + " kW";
  return w.toFixed(0) + " W";
}

export function fmtMoney(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return new Intl.NumberFormat([], {
    style: "currency",
    currency: "USD",
  }).format(v);
}

export function getElectricityRatePerKWh(
  tenantId = "global",
  fallback = DEFAULT_ELECTRICITY_RATE_PER_KWH,
): number {
  try {
    const raw = readTenantStorage(
      tenantId,
      "electricityRatePerKWh",
      LEGACY_ELECTRICITY_RATE_STORAGE_KEY,
    );
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

export function saveElectricityRatePerKWh(tenantId: string, rate: number): void {
  if (!Number.isFinite(rate) || rate <= 0) return;
  try {
    window.localStorage.setItem(
      tenantStorageKey(tenantId, "electricityRatePerKWh"),
      String(rate),
    );
  } catch {
    // Ignore storage failures; the UI can still use the in-memory value.
  }
}

export function getWaterRatePerGal(
  tenantId = "global",
  fallback = DEFAULT_WATER_RATE_PER_GAL,
): number {
  try {
    const raw = readTenantStorage(tenantId, "waterRatePerGal");
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

export function saveWaterRatePerGal(tenantId: string, rate: number): void {
  if (!Number.isFinite(rate) || rate <= 0) return;
  try {
    window.localStorage.setItem(
      tenantStorageKey(tenantId, "waterRatePerGal"),
      String(rate),
    );
  } catch {
    // Ignore storage failures; the UI can still use the in-memory value.
  }
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

export async function jput<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "PUT",
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

export function startOfTodayLocal(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d;
}
