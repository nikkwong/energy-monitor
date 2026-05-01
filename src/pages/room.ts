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

type Monitor = {
  label: string;
  ip?: string;
};

type Room = {
  id: string;
  label: string;
  monitors?: Record<string, Monitor>;
  leases: Lease[];
};

type Usage = {
  from: string;
  to: string;
  energyKWh: number;
  monitors: Record<string, number>;
};

type UsageResp = {
  room: Room;
  currentLease: Lease | null;
  leaseUsage: Usage;
  monthUsage: Usage;
  latest: {
    ts: string;
    powerW: number;
    monitors: Record<string, { ts: string; powerW: number; totalEnergyWh: number }>;
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
  const leaseLine = lease
    ? `${escapeHtml(lease.tenant)} · lease started ${lease.startDate}`
    : `<span class="muted">no active lease</span>`;

  // Each monitor with a known IP becomes a clickable link to its admin UI.
  // Shown unconditionally so even single-monitor rooms get the click-through.
  const monitors = data.room.monitors ?? {};
  const devicePieces = Object.keys(monitors)
    .sort()
    .map((id) => {
      const m = monitors[id]!;
      const label = escapeHtml(m.label || id);
      if (!m.ip) return label;
      const ip = escapeHtml(m.ip);
      return `<a href="http://${ip}" target="_blank" rel="noopener" title="Shelly admin · ${ip}">${label}</a>`;
    });
  const devicesLine = devicePieces.length
    ? `<span class="muted">devices:</span> ${devicePieces.join(" · ")}`
    : "";

  document.getElementById("roomSubtitle")!.innerHTML = devicesLine
    ? `${leaseLine}<br>${devicesLine}`
    : leaseLine;
}

function monitorLabel(room: Room, id: string): string {
  return room.monitors?.[id]?.label ?? id;
}

/**
 * Render a monitor's label, wrapping it in an `<a>` to the device's admin UI
 * when we know its LAN IP. The link only resolves while the viewer is on the
 * same network as the Shelly, but that's fine — managing the device is a
 * lan-side activity anyway.
 */
function monitorLabelHtml(room: Room, id: string): string {
  const safeLabel = escapeHtml(monitorLabel(room, id));
  const ip = room.monitors?.[id]?.ip;
  if (!ip) return safeLabel;
  return `<a href="http://${escapeHtml(ip)}" target="_blank" rel="noopener" title="Open ${escapeHtml(ip)} (Shelly admin)">${safeLabel}</a>`;
}

function renderStats(data: UsageResp): void {
  const latest = data.latest;
  const cls = freshnessClass(latest?.ts ?? null);

  // Per-monitor breakdowns only add value once a room has more than one feed.
  const monthIds = Object.keys(data.monthUsage.monitors);
  const monthBreakdown =
    monthIds.length > 1
      ? monthIds
          .sort()
          .map((id) => {
            const kwh = data.monthUsage.monitors[id] ?? 0;
            return `<span class="muted">${monitorLabelHtml(data.room, id)}:</span> ${fmtKWh(kwh)}`;
          })
          .join(" · ")
      : "";

  const liveIds = latest ? Object.keys(latest.monitors) : [];
  const liveBreakdown =
    latest && liveIds.length > 1
      ? liveIds
          .sort()
          .map((id) => {
            const m = latest.monitors[id]!;
            return `<span class="muted">${monitorLabelHtml(data.room, id)}:</span> ${fmtW(m.powerW)}`;
          })
          .join(" · ")
      : "";

  const el = document.getElementById("stats")!;
  el.innerHTML = `
    <div class="card">
      <div class="label">This month</div>
      <div class="value tabular">${fmtKWh(data.monthUsage.energyKWh)}<span class="unit">kWh</span></div>
      <div class="sub">${monthBreakdown || "&nbsp;"}</div>
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
      <div class="sub">
        <span class="dot ${cls}"></span>${fmtRelativeTime(latest?.ts ?? null)}
        ${liveBreakdown ? `<div style="margin-top:4px;">${liveBreakdown}</div>` : ""}
      </div>
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
