import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  TimeScale,
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
  startOfMonthLocal,
} from "./common.ts";

Chart.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  TimeScale,
  CategoryScale,
  Tooltip,
  Filler,
);

type RoomSummary = {
  id: string;
  label: string;
  currentTenant: string | null;
  leaseStart: string | null;
  leaseKWh: number;
  monthKWh: number;
  powerW: number | null;
  lastSeen: string | null;
};

type SeriesResp = {
  from: string;
  to: string;
  bucket: "hour" | "day" | "month";
  series: Array<{ ts: string; energyKWh: number }>;
};

let chart: Chart | null = null;

function renderTotals(rooms: RoomSummary[]): void {
  const monthTotal = rooms.reduce((s, r) => s + r.monthKWh, 0);
  const leaseTotal = rooms.reduce((s, r) => s + r.leaseKWh, 0);
  const powerTotal = rooms.reduce((s, r) => s + (r.powerW ?? 0), 0);
  const live = rooms.filter((r) => freshnessClass(r.lastSeen) === "live").length;

  const el = document.getElementById("totals")!;
  el.innerHTML = `
    <div class="card">
      <div class="label">This month</div>
      <div class="value tabular">${fmtKWh(monthTotal)}<span class="unit">kWh</span></div>
      <div class="sub">across all rooms</div>
    </div>
    <div class="card">
      <div class="label">Right now</div>
      <div class="value tabular">${fmtW(powerTotal)}</div>
      <div class="sub">${live}/${rooms.length} rooms reporting</div>
    </div>
    <div class="card">
      <div class="label">Since lease starts</div>
      <div class="value tabular">${fmtKWh(leaseTotal)}<span class="unit">kWh</span></div>
      <div class="sub">summed across active leases</div>
    </div>
  `;
}

function renderRooms(rooms: RoomSummary[]): void {
  const el = document.getElementById("rooms")!;
  if (rooms.length === 0) {
    el.innerHTML = `
      <div class="empty" style="grid-column: 1 / -1;">
        No rooms configured. Edit <code>data/rooms.json</code> to add rooms.
      </div>`;
    return;
  }
  el.innerHTML = rooms
    .map((r) => {
      const cls = freshnessClass(r.lastSeen);
      return `
        <a href="/${encodeURIComponent(r.id)}" class="card room">
          <h3><span class="dot ${cls}"></span>${escapeHtml(r.label)}</h3>
          <div class="tenant">${
            r.currentTenant ? escapeHtml(r.currentTenant) : "<i>vacant</i>"
          } · ${fmtRelativeTime(r.lastSeen)}</div>
          <div class="row"><span class="k">This month</span>
            <span class="v tabular">${fmtKWh(r.monthKWh)} kWh</span></div>
          <div class="row"><span class="k">Since lease start</span>
            <span class="v tabular">${fmtKWh(r.leaseKWh)} kWh</span></div>
          <div class="row"><span class="k">Now</span>
            <span class="v tabular">${fmtW(r.powerW)}</span></div>
        </a>`;
    })
    .join("");
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

async function renderChart(bucket: "hour" | "day" | "month", days: number): Promise<void> {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const url = `/api/series?from=${from.toISOString()}&to=${to.toISOString()}&bucket=${bucket}`;
  const data = await jget<SeriesResp>(url);

  const labels = data.series.map((p) => formatBucketLabel(p.ts, bucket));
  const values = data.series.map((p) => p.energyKWh);

  const canvas = document.getElementById("totalChart") as HTMLCanvasElement;
  if (chart) chart.destroy();
  chart = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "kWh",
          data: values,
          borderColor: "#7dd3fc",
          backgroundColor: "rgba(125, 211, 252, 0.15)",
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

function formatBucketLabel(iso: string, bucket: "hour" | "day" | "month"): string {
  const d = new Date(iso);
  if (bucket === "hour") {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (bucket === "day") {
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString([], { month: "short", year: "2-digit" });
}

async function main(): Promise<void> {
  void startOfMonthLocal; // imported for symmetry, not needed here yet
  const { rooms } = await jget<{ rooms: RoomSummary[] }>("/api/rooms");
  renderTotals(rooms);
  renderRooms(rooms);

  let bucket: "hour" | "day" | "month" = "day";
  let days = 30;
  await renderChart(bucket, days);

  const toggle = document.getElementById("ranges")!;
  toggle.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    if (t.tagName !== "BUTTON") return;
    toggle.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
    t.classList.add("active");
    bucket = t.dataset.bucket as typeof bucket;
    days = Number(t.dataset.days);
    await renderChart(bucket, days);
  });
}

main().catch((err) => {
  console.error(err);
  document.querySelector(".container")!.insertAdjacentHTML(
    "afterbegin",
    `<div class="error">Failed to load: ${escapeHtml(String(err))}</div>`,
  );
});
