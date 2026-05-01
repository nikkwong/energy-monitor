import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Tooltip,
  Filler,
} from "chart.js";

import {
  fmtKWh,
  fmtW,
  fmtRelativeTime,
  freshnessClass,
  jget,
} from "./common.ts";

Chart.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Tooltip,
  Filler,
);

type Lease = {
  id: string;
  tenant: string;
  startDate: string;
  endDate: string | null;
  notes?: string;
};

type Room = {
  id: string;
  label: string;
  channelLabels?: Record<number, string>;
  leases: Lease[];
};

type UsageResp = {
  room: Room;
  currentLease: Lease | null;
  leaseUsage: { from: string; to: string; energyKWh: number; channels: Record<number, number> };
  monthUsage: { from: string; to: string; energyKWh: number; channels: Record<number, number> };
  latest: {
    ts: string;
    powerW: number;
    channels: Array<{ idx: number; powerW: number; totalEnergyWh: number }>;
  } | null;
};

type SeriesResp = {
  from: string;
  to: string;
  bucket: "hour" | "day" | "month";
  series: Array<{ ts: string; energyKWh: number }>;
};

let chart: Chart | null = null;

function getRoomId(): string {
  const path = window.location.pathname.replace(/^\/+|\/+$/g, "");
  return decodeURIComponent(path);
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function showError(msg: string): void {
  const el = document.getElementById("errorBox")!;
  el.innerHTML = `<div class="error">${escapeHtml(msg)}</div>`;
}

function renderHeader(data: UsageResp): void {
  document.getElementById("roomTitle")!.textContent = data.room.label;
  document.title = `5214 · ${data.room.label}`;

  const lease = data.currentLease;
  const sub = lease
    ? `${escapeHtml(lease.tenant)} · lease started ${lease.startDate}`
    : `<span class="muted">no active lease</span>`;
  document.getElementById("roomSubtitle")!.innerHTML = sub;
}

function renderStats(data: UsageResp): void {
  const latest = data.latest;
  const cls = freshnessClass(latest?.ts ?? null);

  const channelBreakdown = (data.monthUsage.channels &&
    Object.keys(data.monthUsage.channels).length > 1)
    ? Object.entries(data.monthUsage.channels)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([idx, kwh]) => {
          const label = data.room.channelLabels?.[Number(idx)] ?? `Ch ${idx}`;
          return `<span class="muted">${escapeHtml(label)}:</span> ${fmtKWh(kwh)}`;
        })
        .join(" · ")
    : "";

  const el = document.getElementById("stats")!;
  el.innerHTML = `
    <div class="card">
      <div class="label">This month</div>
      <div class="value tabular">${fmtKWh(data.monthUsage.energyKWh)}<span class="unit">kWh</span></div>
      <div class="sub">${channelBreakdown || "&nbsp;"}</div>
    </div>
    <div class="card">
      <div class="label">Lease to date</div>
      <div class="value tabular">${fmtKWh(data.leaseUsage.energyKWh)}<span class="unit">kWh</span></div>
      <div class="sub">${
        data.currentLease
          ? `since ${data.currentLease.startDate}`
          : "no active lease"
      }</div>
    </div>
    <div class="card">
      <div class="label">Right now</div>
      <div class="value tabular">${fmtW(latest?.powerW ?? null)}</div>
      <div class="sub"><span class="dot ${cls}"></span>${fmtRelativeTime(latest?.ts ?? null)}</div>
    </div>
  `;
}

type RangeKey = "month" | "lease" | "30d" | "7d" | "24h";

function rangeFor(
  key: RangeKey,
  leaseStart: string | null,
): { from: Date; to: Date; bucket: "hour" | "day" | "month"; title: string } {
  const to = new Date();
  if (key === "24h") {
    return {
      from: new Date(to.getTime() - 24 * 60 * 60 * 1000),
      to,
      bucket: "hour",
      title: "Last 24 hours · per hour",
    };
  }
  if (key === "7d") {
    return {
      from: new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000),
      to,
      bucket: "day",
      title: "Last 7 days · per day",
    };
  }
  if (key === "30d") {
    return {
      from: new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000),
      to,
      bucket: "day",
      title: "Last 30 days · per day",
    };
  }
  if (key === "month") {
    const from = new Date();
    from.setDate(1);
    from.setHours(0, 0, 0, 0);
    return { from, to, bucket: "day", title: "This month · per day" };
  }
  // lease
  if (leaseStart) {
    const from = new Date(leaseStart + "T00:00:00");
    const days = Math.floor((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
    const bucket = days > 90 ? "month" : "day";
    return {
      from,
      to,
      bucket,
      title: `Lease to date · per ${bucket}`,
    };
  }
  // No lease — fall back to 30d.
  return {
    from: new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000),
    to,
    bucket: "day",
    title: "Last 30 days · per day",
  };
}

function formatLabel(iso: string, bucket: "hour" | "day" | "month"): string {
  const d = new Date(iso);
  if (bucket === "hour") {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (bucket === "day") {
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString([], { month: "short", year: "2-digit" });
}

async function renderChart(roomId: string, range: RangeKey, leaseStart: string | null): Promise<void> {
  const r = rangeFor(range, leaseStart);
  document.getElementById("chartTitle")!.textContent = r.title;
  const url =
    `/api/rooms/${encodeURIComponent(roomId)}/series` +
    `?from=${r.from.toISOString()}&to=${r.to.toISOString()}&bucket=${r.bucket}`;
  const data = await jget<SeriesResp>(url);

  const labels = data.series.map((p) => formatLabel(p.ts, r.bucket));
  const values = data.series.map((p) => p.energyKWh);

  const canvas = document.getElementById("chart") as HTMLCanvasElement;
  if (chart) chart.destroy();
  chart = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "kWh",
          data: values,
          borderColor: "#a78bfa",
          backgroundColor: "rgba(167, 139, 250, 0.15)",
          fill: true,
          tension: 0.25,
          pointRadius: 0,
          pointHoverRadius: 4,
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#14181d",
          borderColor: "#232a32",
          borderWidth: 1,
          titleColor: "#e6e9ee",
          bodyColor: "#e6e9ee",
          callbacks: {
            label: (ctx) => `${(ctx.parsed.y as number).toFixed(2)} kWh`,
          },
        },
      },
      scales: {
        x: {
          grid: { color: "#1b2026" },
          ticks: { color: "#8d96a4", maxRotation: 0, autoSkipPadding: 12 },
        },
        y: {
          grid: { color: "#1b2026" },
          ticks: { color: "#8d96a4" },
          beginAtZero: true,
        },
      },
    },
  });
}

async function main(): Promise<void> {
  const roomId = getRoomId();
  if (!roomId) {
    showError("No room id in URL.");
    return;
  }

  let data: UsageResp;
  try {
    data = await jget<UsageResp>(`/api/rooms/${encodeURIComponent(roomId)}/usage`);
  } catch (err) {
    document.getElementById("roomTitle")!.textContent = `Room ${roomId}`;
    showError(
      `Could not load room: ${String(err)}. ` +
        `Make sure "${roomId}" is in data/rooms.json.`,
    );
    return;
  }

  renderHeader(data);
  renderStats(data);

  const leaseStart = data.currentLease?.startDate ?? null;
  let range: RangeKey = "month";
  await renderChart(roomId, range, leaseStart);

  const toggle = document.getElementById("ranges")!;
  toggle.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    if (t.tagName !== "BUTTON") return;
    toggle.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
    t.classList.add("active");
    range = t.dataset.range as RangeKey;
    await renderChart(roomId, range, leaseStart);
  });
}

main().catch((err) => {
  console.error(err);
  showError(String(err));
});
