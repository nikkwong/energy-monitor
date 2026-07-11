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
  DEFAULT_ELECTRICITY_RATE_PER_KWH,
  fmtKWh,
  fmtMoney,
  fmtW,
  fmtRelativeTime,
  freshnessClass,
  getElectricityRatePerKWh,
  jget,
  saveElectricityRatePerKWh,
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
  dayKWh: number;
  weekKWh: number;
  thirtyDayKWh: number;
  allTimeKWh: number;
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
type SummaryRange = "month" | "24h" | "7d" | "30d" | "all";

function rangeLabel(range: SummaryRange): string {
  if (range === "24h") return "Last 24 hours";
  if (range === "7d") return "Last 7 days";
  if (range === "30d") return "Last 30 days";
  if (range === "all") return "All time";
  return "This month";
}

function rangeKWh(r: RoomSummary, range: SummaryRange): number {
  if (range === "24h") return r.dayKWh;
  if (range === "7d") return r.weekKWh;
  if (range === "30d") return r.thirtyDayKWh;
  if (range === "all") return r.allTimeKWh;
  return r.monthKWh;
}

function renderTotals(rooms: RoomSummary[], ratePerKWh: number, range: SummaryRange): void {
  const rangeTotal = rooms.reduce((s, r) => s + rangeKWh(r, range), 0);
  const leaseTotal = rooms.reduce((s, r) => s + r.leaseKWh, 0);
  const powerTotal = rooms.reduce((s, r) => s + (r.powerW ?? 0), 0);
  const live = rooms.filter((r) => freshnessClass(r.lastSeen) === "live").length;
  document.getElementById("summaryTitle")!.textContent = rangeLabel(range);

  const el = document.getElementById("totals")!;
  el.innerHTML = `
    <div class="card">
      <div class="label">${rangeLabel(range)}</div>
      <div class="value tabular">${fmtKWh(rangeTotal)}<span class="unit">kWh</span></div>
      <div class="cost tabular">${fmtMoney(rangeTotal * ratePerKWh)}</div>
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
      <div class="cost tabular">${fmtMoney(leaseTotal * ratePerKWh)}</div>
      <div class="sub">summed across active leases</div>
    </div>
  `;
  updateStatsCarousel();
}

function updateStatsCarousel(): void {
  const viewport = document.querySelector(".stats-viewport") as HTMLElement | null;
  const el = document.getElementById("totals");
  if (!viewport || !el) return;
  const maxScroll = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
  const left = viewport.scrollLeft;
  document.getElementById("statsPrev")?.toggleAttribute("disabled", left <= 1);
  document.getElementById("statsNext")?.toggleAttribute("disabled", left >= maxScroll - 1);
}

function scrollStats(direction: -1 | 1): void {
  const viewport = document.querySelector(".stats-viewport") as HTMLElement | null;
  const el = document.getElementById("totals");
  if (!el) return;
  if (!viewport) return;
  const firstCard = el.querySelector<HTMLElement>(".card");
  const step = firstCard ? firstCard.offsetWidth + 12 : viewport.clientWidth;
  viewport.scrollBy({
    left: direction * step,
    behavior: "smooth",
  });
}

function attachStatsCarousel(): void {
  const viewport = document.querySelector(".stats-viewport") as HTMLElement | null;
  document.getElementById("statsPrev")?.addEventListener("click", () => scrollStats(-1));
  document.getElementById("statsNext")?.addEventListener("click", () => scrollStats(1));
  viewport?.addEventListener("scroll", updateStatsCarousel, { passive: true });
  window.addEventListener("resize", updateStatsCarousel);
}

function renderRooms(rooms: RoomSummary[], ratePerKWh: number, range: SummaryRange): void {
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
      const idAttr = escapeHtml(r.id);
      const labelAttr = escapeHtml(r.label);
      const kwh = rangeKWh(r, range);
      return `
        <a href="/${encodeURIComponent(r.id)}" class="card room">
          <button class="card-delete" data-room-id="${idAttr}" data-room-label="${labelAttr}"
                  aria-label="Delete ${labelAttr}" title="Delete ${labelAttr}">×</button>
          <h3><span class="dot ${cls}"></span>${escapeHtml(r.label)}</h3>
          <div class="tenant">${
            r.currentTenant ? escapeHtml(r.currentTenant) : "<i>vacant</i>"
          } · ${fmtRelativeTime(r.lastSeen)}</div>
          <div class="row"><span class="k">${rangeLabel(range)}</span>
            <span class="v tabular">${fmtKWh(kwh)} kWh · ${fmtMoney(kwh * ratePerKWh)}</span></div>
          <div class="row"><span class="k">Since lease start</span>
            <span class="v tabular">${fmtKWh(r.leaseKWh)} kWh · ${fmtMoney(r.leaseKWh * ratePerKWh)}</span></div>
          <div class="row"><span class="k">Now</span>
            <span class="v tabular">${fmtW(r.powerW)}</span></div>
        </a>`;
    })
    .join("");

}

function attachRoomActions(): void {
  const el = document.getElementById("rooms")!;
  el.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement)?.closest(
      "button.card-delete",
    ) as HTMLButtonElement | null;
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();

    const roomId = btn.dataset.roomId!;
    const label = btn.dataset.roomLabel ?? roomId;
    const ok = window.confirm(
      `Delete ${label}?\n\n` +
        `Historical readings stay on disk and stop appearing in the dashboard. ` +
        `If the Shelly is still POSTing this room id, it'll auto-register again on its next POST.`,
    );
    if (!ok) return;

    btn.disabled = true;
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`${res.status}: ${text || res.statusText}`);
      }
      window.location.reload();
    } catch (err) {
      btn.disabled = false;
      alert(`Could not delete ${label}: ${String(err)}`);
    }
  });
}

function setupRateControl(rooms: RoomSummary[], getRange: () => SummaryRange): number {
  let rate = getElectricityRatePerKWh();
  const input = document.getElementById("electricityRate") as HTMLInputElement;
  const note = document.getElementById("rateNote")!;
  const dialog = document.getElementById("settingsDialog") as HTMLDialogElement;
  const toggle = document.getElementById("settingsToggle") as HTMLButtonElement;
  const close = document.getElementById("settingsClose") as HTMLButtonElement;
  input.value = rate.toFixed(4);
  note.textContent = `Saved in this browser. Default is ${fmtMoney(DEFAULT_ELECTRICITY_RATE_PER_KWH)}/kWh.`;

  toggle.addEventListener("click", () => {
    dialog.showModal();
    input.focus();
  });
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });

  input.addEventListener("input", () => {
    const next = Number(input.value);
    if (!Number.isFinite(next) || next <= 0) {
      note.textContent = "Enter a positive dollar-per-kWh rate.";
      return;
    }
    rate = next;
    saveElectricityRatePerKWh(rate);
    note.textContent = "Saved in this browser.";
    renderTotals(rooms, rate, getRange());
    renderRooms(rooms, rate, getRange());
  });

  return rate;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function chartRange(range: SummaryRange): {
  bucket: "hour" | "day" | "month";
  from: Date;
  title: string;
} {
  const to = new Date();
  if (range === "24h") {
    return {
      bucket: "hour",
      from: new Date(to.getTime() - 24 * 60 * 60 * 1000),
      title: "House total · last 24 hours",
    };
  }
  if (range === "7d") {
    return {
      bucket: "day",
      from: new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000),
      title: "House total · last 7 days",
    };
  }
  if (range === "30d") {
    return {
      bucket: "day",
      from: new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000),
      title: "House total · last 30 days",
    };
  }
  if (range === "all") {
    return {
      bucket: "month",
      from: new Date(0),
      title: "House total · all time",
    };
  }
  const from = new Date();
  from.setDate(1);
  from.setHours(0, 0, 0, 0);
  return {
    bucket: "day",
    from,
    title: "House total · this month",
  };
}

async function renderChart(range: SummaryRange): Promise<void> {
  const to = new Date();
  const { bucket, from, title } = chartRange(range);
  document.getElementById("chartTitle")!.textContent = title;
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
  void startOfMonthLocal;
  // Room cards first (one server-side pass), chart loads separately so the
  // page feels responsive even when readings.jsonl is large.
  const { rooms } = await jget<{ rooms: RoomSummary[] }>("/api/rooms");
  let summaryRange: SummaryRange = "7d";
  let rate = setupRateControl(rooms, () => summaryRange);
  renderTotals(rooms, rate, summaryRange);
  renderRooms(rooms, rate, summaryRange);
  attachRoomActions();
  attachStatsCarousel();

  void renderChart(summaryRange).catch((err) => {
    console.error("chart failed:", err);
    document.getElementById("totalChart")?.parentElement?.insertAdjacentHTML(
      "afterend",
      `<div class="error">Chart failed to load: ${escapeHtml(String(err))}</div>`,
    );
  });

  const toggle = document.getElementById("summaryRanges")!;
  toggle.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    if (t.tagName !== "BUTTON") return;
    toggle.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
    t.classList.add("active");
    summaryRange = t.dataset.summaryRange as SummaryRange;
    rate = getElectricityRatePerKWh();
    renderTotals(rooms, rate, summaryRange);
    renderRooms(rooms, rate, summaryRange);
    await renderChart(summaryRange);
  });
}

main().catch((err) => {
  console.error(err);
  document.querySelector(".container")!.insertAdjacentHTML(
    "afterbegin",
    `<div class="error">Failed to load: ${escapeHtml(String(err))}</div>`,
  );
});
