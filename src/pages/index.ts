import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  TimeScale,
  CategoryScale,
  Tooltip,
  Legend,
  Filler,
} from "chart.js";

import {
  DEFAULT_ELECTRICITY_RATE_PER_KWH,
  DEFAULT_WATER_RATE_PER_GAL,
  fmtAxisDollars,
  fmtGal,
  fmtGpm,
  fmtKWh,
  fmtMoney,
  fmtW,
  fmtRelativeTime,
  freshnessClass,
  getElectricityRatePerKWh,
  getWaterRatePerGal,
  jget,
  saveElectricityRatePerKWh,
  saveWaterRatePerGal,
  setupThemeToggle,
  startOfMonthLocal,
  startOfTodayLocal,
  chartAxisAndTooltipOptions,
  themeCssVar,
} from "./common.ts";
import { hydrateUtilityIcons, utilityIconHtml } from "./icons.ts";

Chart.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  TimeScale,
  CategoryScale,
  Tooltip,
  Legend,
  Filler,
);

type RoomSummary = {
  id: string;
  label: string;
  modalities?: { power: boolean; water: boolean };
  currentTenant: string | null;
  leaseStart: string | null;
  leaseKWh: number;
  monthKWh: number;
  todayKWh: number;
  dayKWh: number;
  weekKWh: number;
  thirtyDayKWh: number;
  allTimeKWh: number;
  powerW: number | null;
  lastSeen: string | null;
  leaseWaterGal?: number;
  monthWaterGal?: number;
  todayWaterGal?: number;
  dayWaterGal?: number;
  weekWaterGal?: number;
  thirtyDayWaterGal?: number;
  allTimeWaterGal?: number;
  flowGpm?: number | null;
  waterLastSeen?: string | null;
};

type SeriesPoint = {
  ts: string;
  energyKWh: number;
  waterGal?: number;
};

type SeriesResp = {
  from: string;
  to: string;
  bucket: "hour" | "day" | "month";
  series: SeriesPoint[];
};

type TenantConfig = {
  tenantId: string;
  label: string;
  modalities: { power: boolean; water: boolean };
};

type SummaryRange = "month" | "24h" | "7d" | "30d" | "all";
type ModalityView = "all" | "water" | "power";

type UtilityRates = {
  electricityRatePerKWh: number;
  waterRatePerGal: number;
};

function tenantIdFromPath(): string {
  const segment = window.location.pathname.split("/").filter(Boolean)[0];
  return segment ? decodeURIComponent(segment) : "";
}

const tenantId = tenantIdFromPath();
let chart: Chart | null = null;
let cachedSeries: { range: SummaryRange; data: SeriesResp } | null = null;

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

function rangeWaterGal(r: RoomSummary, range: SummaryRange): number {
  if (range === "24h") return r.dayWaterGal ?? 0;
  if (range === "7d") return r.weekWaterGal ?? 0;
  if (range === "30d") return r.thirtyDayWaterGal ?? 0;
  if (range === "all") return r.allTimeWaterGal ?? 0;
  return r.monthWaterGal ?? 0;
}

function roomModalities(r: RoomSummary): { power: boolean; water: boolean } {
  return {
    power: r.modalities?.power ?? true,
    water: r.modalities?.water ?? true,
  };
}

function latestRoomSeen(r: RoomSummary, view: ModalityView): string | null {
  const m = roomModalities(r);
  const powerSeen = m.power ? r.lastSeen : null;
  const waterSeen = m.water ? (r.waterLastSeen ?? null) : null;
  if (view === "power") return powerSeen;
  if (view === "water") return waterSeen;
  if (powerSeen && waterSeen) {
    return powerSeen >= waterSeen ? powerSeen : waterSeen;
  }
  return powerSeen ?? waterSeen ?? null;
}

function renderTotals(
  rooms: RoomSummary[],
  rates: UtilityRates,
  range: SummaryRange,
  view: ModalityView,
): void {
  const powerRooms = rooms.filter((r) => roomModalities(r).power);
  const waterRooms = rooms.filter((r) => roomModalities(r).water);
  const rangePowerKWh = powerRooms.reduce((s, r) => s + rangeKWh(r, range), 0);
  const todayPowerKWh = powerRooms.reduce((s, r) => s + (r.todayKWh ?? 0), 0);
  const powerTotal = powerRooms.reduce((s, r) => s + (r.powerW ?? 0), 0);
  const livePower = powerRooms.filter((r) => freshnessClass(r.lastSeen) === "live").length;

  const rangeWater = waterRooms.reduce((s, r) => s + rangeWaterGal(r, range), 0);
  const todayWater = waterRooms.reduce((s, r) => s + (r.todayWaterGal ?? 0), 0);
  const hasAnyFlow = waterRooms.some((r) => r.flowGpm != null);
  const flowTotal = hasAnyFlow
    ? waterRooms.reduce((s, r) => s + (r.flowGpm ?? 0), 0)
    : null;
  const liveWater = waterRooms.filter((r) => freshnessClass(r.waterLastSeen ?? null) === "live").length;

  const rangePowerCost = rangePowerKWh * rates.electricityRatePerKWh;
  const todayPowerCost = todayPowerKWh * rates.electricityRatePerKWh;
  const rangeWaterCost = rangeWater * rates.waterRatePerGal;
  const todayWaterCost = todayWater * rates.waterRatePerGal;

  const powerIcon = utilityIconHtml("power");
  const waterIcon = utilityIconHtml("water");

  document.getElementById("summaryTitle")!.textContent = rangeLabel(range);
  const el = document.getElementById("totals")!;

  if (view === "water") {
    el.innerHTML = `
      <div class="card">
        <div class="label">${rangeLabel(range)}</div>
        <div class="value tabular">${fmtGal(rangeWater)}<span class="unit">gal</span></div>
        <div class="cost tabular">${fmtMoney(rangeWaterCost)}</div>
        <div class="sub">across all rooms</div>
      </div>
      <div class="card">
        <div class="label">Right now</div>
        <div class="value tabular">${fmtGpm(flowTotal)}</div>
        <div class="sub">${liveWater}/${waterRooms.length} rooms reporting</div>
      </div>
      <div class="card">
        <div class="label">Used today</div>
        <div class="value tabular">${fmtGal(todayWater)}<span class="unit">gal</span></div>
        <div class="cost tabular">${fmtMoney(todayWaterCost)}</div>
        <div class="sub">across all rooms</div>
      </div>
    `;
  } else if (view === "all") {
    el.innerHTML = `
      <div class="card">
        <div class="label">${rangeLabel(range)}</div>
        <div class="value tabular">${fmtMoney(rangePowerCost + rangeWaterCost)}</div>
        <div class="sub">
          <span class="inline-utility">${powerIcon}${fmtKWh(rangePowerKWh)} kWh</span>
          ·
          <span class="inline-utility">${waterIcon}${fmtGal(rangeWater)} gal</span>
        </div>
      </div>
      <div class="card">
        <div class="label">Right now</div>
        <div class="value tabular dual-live-value">
          <span class="inline-utility">${powerIcon}${fmtW(powerTotal)}</span>
          <span class="muted">·</span>
          <span class="inline-utility">${waterIcon}${fmtGpm(flowTotal)}</span>
        </div>
        <div class="sub">${livePower}/${powerRooms.length} power · ${liveWater}/${waterRooms.length} water reporting</div>
      </div>
      <div class="card">
        <div class="label">Used today</div>
        <div class="value tabular">${fmtMoney(todayPowerCost + todayWaterCost)}</div>
        <div class="sub">
          <span class="inline-utility">${powerIcon}${fmtKWh(todayPowerKWh)} kWh</span>
          ·
          <span class="inline-utility">${waterIcon}${fmtGal(todayWater)} gal</span>
        </div>
      </div>
    `;
  } else {
    el.innerHTML = `
      <div class="card">
        <div class="label">${rangeLabel(range)}</div>
        <div class="value tabular">${fmtKWh(rangePowerKWh)}<span class="unit">kWh</span></div>
        <div class="cost tabular">${fmtMoney(rangePowerCost)}</div>
        <div class="sub">across all rooms</div>
      </div>
      <div class="card">
        <div class="label">Right now</div>
        <div class="value tabular">${fmtW(powerTotal)}</div>
        <div class="sub">${livePower}/${powerRooms.length} rooms reporting</div>
      </div>
      <div class="card">
        <div class="label">Used today</div>
        <div class="value tabular">${fmtKWh(todayPowerKWh)}<span class="unit">kWh</span></div>
        <div class="cost tabular">${fmtMoney(todayPowerCost)}</div>
        <div class="sub">across all rooms</div>
      </div>
    `;
  }
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

function attachChartLegend(): void {
  const legendEl = document.getElementById("chartLegend");
  legendEl?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement)?.closest(
      "button[data-dataset-index]",
    ) as HTMLButtonElement | null;
    if (!btn || !chart) return;
    const idx = Number(btn.dataset.datasetIndex);
    if (!Number.isInteger(idx) || !chart.data.datasets[idx]) return;
    const nextVisible = !chart.isDatasetVisible(idx);
    chart.setDatasetVisibility(idx, nextVisible);
    btn.classList.toggle("is-hidden", !nextVisible);
    chart.update();
  });
}

function renderRooms(
  rooms: RoomSummary[],
  rates: UtilityRates,
  range: SummaryRange,
  view: ModalityView,
): void {
  const el = document.getElementById("rooms")!;
  if (rooms.length === 0) {
    el.innerHTML = `
      <div class="empty" style="grid-column: 1 / -1;">
        No rooms configured. Edit <code>data/tenants/${escapeHtml(tenantId)}/rooms.json</code> to add rooms.
      </div>`;
    return;
  }
  const visibleRooms = rooms.filter((r) => {
    const m = roomModalities(r);
    if (view === "water") return m.water;
    if (view === "power") return m.power;
    return true;
  });
  if (visibleRooms.length === 0) {
    el.innerHTML = `
      <div class="empty" style="grid-column: 1 / -1;">
        No rooms have ${view === "water" ? "water" : "power"} monitoring enabled.
      </div>`;
    return;
  }
  el.innerHTML = visibleRooms
    .map((r) => {
      const m = roomModalities(r);
      const seen = latestRoomSeen(r, view);
      const cls = freshnessClass(seen);
      const idAttr = escapeHtml(r.id);
      const labelAttr = escapeHtml(r.label);
      const kwh = rangeKWh(r, range);
      const gal = rangeWaterGal(r, range);
      const powerCost = kwh * rates.electricityRatePerKWh;
      const waterCost = gal * rates.waterRatePerGal;

      const powerIcon = utilityIconHtml("power");
      const waterIcon = utilityIconHtml("water");

      const showPower = view === "power" || (view === "all" && m.power);
      const showWater = view === "water" || (view === "all" && m.water);

      let rowsHtml: string;
      if (showPower && showWater) {
        rowsHtml = `
          <div class="row"><span class="k"><span class="inline-utility">${powerIcon}${rangeLabel(range)}</span></span>
            <span class="v tabular">${fmtKWh(kwh)} kWh · ${fmtMoney(powerCost)}</span></div>
          <div class="row"><span class="k"><span class="inline-utility">${waterIcon}${rangeLabel(range)}</span></span>
            <span class="v tabular">${fmtGal(gal)} gal · ${fmtMoney(waterCost)}</span></div>
          <div class="row"><span class="k">Now</span>
            <span class="v tabular"><span class="inline-utility">${powerIcon}${fmtW(r.powerW)}</span> · <span class="inline-utility">${waterIcon}${fmtGpm(r.flowGpm)}</span></span></div>`;
      } else if (showWater) {
        rowsHtml = `
          <div class="row"><span class="k"><span class="inline-utility">${waterIcon}${rangeLabel(range)}</span></span>
            <span class="v tabular">${fmtGal(gal)} gal · ${fmtMoney(waterCost)}</span></div>
          <div class="row"><span class="k">Now</span>
            <span class="v tabular">${fmtGpm(r.flowGpm)}</span></div>`;
      } else if (showPower) {
        rowsHtml = `
          <div class="row"><span class="k"><span class="inline-utility">${powerIcon}${rangeLabel(range)}</span></span>
            <span class="v tabular">${fmtKWh(kwh)} kWh · ${fmtMoney(powerCost)}</span></div>
          <div class="row"><span class="k">Now</span>
            <span class="v tabular">${fmtW(r.powerW)}</span></div>`;
      } else {
        rowsHtml = `
          <div class="row"><span class="k">Monitoring</span>
            <span class="v">off</span></div>`;
      }

      const inner = `
          <button class="card-delete" data-room-id="${idAttr}" data-room-label="${labelAttr}"
                  aria-label="Delete ${labelAttr}" title="Delete ${labelAttr}">×</button>
          <h3><span class="dot ${cls}"></span>${escapeHtml(r.label)}</h3>
          <div class="tenant">${fmtRelativeTime(seen)}</div>
          ${rowsHtml}`;

      return `<a href="/${encodeURIComponent(tenantId)}/rooms/${encodeURIComponent(r.id)}" class="card room">${inner}</a>`;
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
      const res = await fetch(
        `/api/tenants/${encodeURIComponent(tenantId)}/rooms/${encodeURIComponent(roomId)}`,
        {
          method: "DELETE",
        },
      );
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

function setupRateControls(
  modalities: TenantConfig["modalities"],
  onChange: (rates: UtilityRates) => void,
): UtilityRates {
  const rates: UtilityRates = {
    electricityRatePerKWh: getElectricityRatePerKWh(tenantId),
    waterRatePerGal: getWaterRatePerGal(tenantId),
  };

  const powerBlock = document.getElementById("powerRateControl")!;
  const waterBlock = document.getElementById("waterRateControl")!;
  powerBlock.hidden = !modalities.power;
  waterBlock.hidden = !modalities.water;

  const powerInput = document.getElementById("electricityRate") as HTMLInputElement;
  const powerNote = document.getElementById("rateNote")!;
  const waterInput = document.getElementById("waterRate") as HTMLInputElement;
  const waterNote = document.getElementById("waterRateNote")!;
  const dialog = document.getElementById("settingsDialog") as HTMLDialogElement;
  const toggle = document.getElementById("settingsToggle") as HTMLButtonElement;
  const close = document.getElementById("settingsClose") as HTMLButtonElement;

  powerInput.value = rates.electricityRatePerKWh.toFixed(4);
  powerNote.textContent = `Saved in this browser. Default is ${fmtMoney(DEFAULT_ELECTRICITY_RATE_PER_KWH)}/kWh.`;
  waterInput.value = rates.waterRatePerGal.toFixed(4);
  waterNote.textContent = `Saved in this browser. Default is $${DEFAULT_WATER_RATE_PER_GAL.toFixed(4)}/gal.`;

  toggle.addEventListener("click", () => {
    dialog.showModal();
    if (modalities.power) powerInput.focus();
    else if (modalities.water) waterInput.focus();
  });
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });

  powerInput.addEventListener("input", () => {
    const next = Number(powerInput.value);
    if (!Number.isFinite(next) || next <= 0) {
      powerNote.textContent = "Enter a positive dollar-per-kWh rate.";
      return;
    }
    rates.electricityRatePerKWh = next;
    saveElectricityRatePerKWh(tenantId, next);
    powerNote.textContent = "Saved in this browser.";
    onChange({ ...rates });
  });

  waterInput.addEventListener("input", () => {
    const next = Number(waterInput.value);
    if (!Number.isFinite(next) || next <= 0) {
      waterNote.textContent = "Enter a positive dollar-per-gallon rate.";
      return;
    }
    rates.waterRatePerGal = next;
    saveWaterRatePerGal(tenantId, next);
    waterNote.textContent = "Saved in this browser.";
    onChange({ ...rates });
  });

  return rates;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function chartRange(
  range: SummaryRange,
  view: ModalityView,
  bothModalitiesEnabled: boolean,
): {
  bucket: "hour" | "day" | "month";
  from: Date;
  title: string;
} {
  const prefix =
    view === "all"
      ? "House total"
      : bothModalitiesEnabled
        ? view === "water"
          ? "House water"
          : "House power"
        : "House total";
  const to = new Date();
  if (range === "24h") {
    return {
      bucket: "hour",
      from: new Date(to.getTime() - 24 * 60 * 60 * 1000),
      title: `${prefix} · last 24 hours`,
    };
  }
  if (range === "7d") {
    return {
      bucket: "day",
      from: new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000),
      title: `${prefix} · last 7 days`,
    };
  }
  if (range === "30d") {
    return {
      bucket: "day",
      from: new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000),
      title: `${prefix} · last 30 days`,
    };
  }
  if (range === "all") {
    return {
      bucket: "month",
      from: new Date(0),
      title: `${prefix} · all time`,
    };
  }
  const from = new Date();
  from.setDate(1);
  from.setHours(0, 0, 0, 0);
  return {
    bucket: "day",
    from,
    title: `${prefix} · this month`,
  };
}

async function loadSeries(range: SummaryRange, forceFetch = false): Promise<SeriesResp> {
  if (!forceFetch && cachedSeries?.range === range) {
    return cachedSeries.data;
  }
  const to = new Date();
  const { bucket, from } = chartRange(range, "power", false);
  const url =
    `/api/tenants/${encodeURIComponent(tenantId)}/series` +
    `?from=${from.toISOString()}&to=${to.toISOString()}&bucket=${bucket}`;
  const data = await jget<SeriesResp>(url);
  cachedSeries = { range, data };
  return data;
}

async function renderChart(
  range: SummaryRange,
  view: ModalityView,
  rates: UtilityRates,
  bothModalitiesEnabled: boolean,
  forceFetch = false,
): Promise<void> {
  const { bucket, title } = chartRange(range, view, bothModalitiesEnabled);
  const titleIcons =
    view === "all"
      ? `${utilityIconHtml("power")}${utilityIconHtml("water")}`
      : view === "water"
        ? utilityIconHtml("water")
        : utilityIconHtml("power");
  document.getElementById("chartTitle")!.innerHTML = `${titleIcons}<span>${escapeHtml(title)}</span>`;
  const data = await loadSeries(range, forceFetch);

  const labels = data.series.map((p) => formatBucketLabel(p.ts, bucket));
  const canvas = document.getElementById("totalChart") as HTMLCanvasElement;

  const isDollarCombined = view === "all";
  const legendEl = document.getElementById("chartLegend")!;
  legendEl.hidden = !isDollarCombined;
  legendEl
    .querySelectorAll<HTMLButtonElement>(".chart-legend-item")
    .forEach((btn) => btn.classList.remove("is-hidden"));

  const chartTheme = chartAxisAndTooltipOptions(
    isDollarCombined
      ? {
          yAxisLabel: "USD ($)",
          showLegend: false,
          yTickCallback: (v) => fmtAxisDollars(Number(v)),
        }
      : {
          yAxisLabel: view === "water" ? "gal" : "kWh",
          showLegend: false,
        },
  );

  const datasets =
    view === "all"
      ? [
          {
            label: "Power",
            data: data.series.map((p) => p.energyKWh * rates.electricityRatePerKWh),
            borderColor: themeCssVar("--chart-power"),
            backgroundColor: themeCssVar("--chart-power-fill"),
            fill: true,
            tension: 0.25,
            pointRadius: 0,
            pointHoverRadius: 4,
            borderWidth: 2,
          },
          {
            label: "Water",
            data: data.series.map((p) => (p.waterGal ?? 0) * rates.waterRatePerGal),
            borderColor: themeCssVar("--chart-water"),
            backgroundColor: themeCssVar("--chart-water-fill"),
            fill: true,
            tension: 0.25,
            pointRadius: 0,
            pointHoverRadius: 4,
            borderWidth: 2,
          },
        ]
      : view === "water"
        ? [
            {
              label: "gal",
              data: data.series.map((p) => p.waterGal ?? 0),
              borderColor: themeCssVar("--chart-water"),
              backgroundColor: themeCssVar("--chart-water-fill"),
              fill: true,
              tension: 0.25,
              pointRadius: 0,
              pointHoverRadius: 4,
              borderWidth: 2,
            },
          ]
        : [
            {
              label: "kWh",
              data: data.series.map((p) => p.energyKWh),
              borderColor: themeCssVar("--chart-power"),
              backgroundColor: themeCssVar("--chart-power-fill"),
              fill: true,
              tension: 0.25,
              pointRadius: 0,
              pointHoverRadius: 4,
              borderWidth: 2,
            },
          ];

  if (chart) chart.destroy();
  chart = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets,
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        ...chartTheme.plugins,
        tooltip: {
          ...chartTheme.plugins.tooltip,
          callbacks: {
            label: (ctx) => {
              const y = ctx.parsed.y as number;
              const point = data.series[ctx.dataIndex];
              if (view === "all") {
                if (ctx.datasetIndex === 0) {
                  const kwh = point?.energyKWh ?? 0;
                  return `Power: ${fmtMoney(y)} (${fmtKWh(kwh)} kWh)`;
                }
                const gal = point?.waterGal ?? 0;
                return `Water: ${fmtMoney(y)} (${fmtGal(gal)} gal)`;
              }
              if (view === "water") {
                return `${y.toFixed(2)} gal (${fmtMoney(y * rates.waterRatePerGal)})`;
              }
              return `${y.toFixed(2)} kWh (${fmtMoney(y * rates.electricityRatePerKWh)})`;
            },
          },
        },
      },
      scales: chartTheme.scales,
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
  hydrateUtilityIcons();
  if (!tenantId) throw new Error("No tenant id in URL.");
  let summaryRange: SummaryRange = "7d";
  const tenant = await jget<TenantConfig>(
    `/api/tenants/${encodeURIComponent(tenantId)}/config`,
  );
  document.getElementById("tenantTitle")!.textContent = tenant.label;
  document.title = `${tenant.label} · Utility dashboard`;
  const configLink = document.getElementById("roomsConfigLink") as HTMLAnchorElement;
  configLink.href = `/api/tenants/${encodeURIComponent(tenantId)}/config/rooms`;

  const hasPower = tenant.modalities.power;
  const hasWater = tenant.modalities.water;
  const bothEnabled = hasPower && hasWater;

  if (!hasPower && !hasWater) {
    setupThemeToggle(tenantId);
    document.getElementById("settingsToggle")!.hidden = true;
    configLink.hidden = true;
    document.getElementById("powerDashboard")!.hidden = true;
    document.querySelector("header.top")!.insertAdjacentHTML(
      "afterend",
      `<div class="empty">No supported monitoring dashboard is enabled yet.</div>`,
    );
    return;
  }

  let modalityView: ModalityView = bothEnabled
    ? "all"
    : hasPower
      ? "power"
      : "water";

  let rates: UtilityRates = {
    electricityRatePerKWh: getElectricityRatePerKWh(tenantId),
    waterRatePerGal: getWaterRatePerGal(tenantId),
  };

  setupThemeToggle(tenantId, () => {
    void renderChart(summaryRange, modalityView, rates, bothEnabled);
  });

  if (bothEnabled) {
    const modalityBar = document.getElementById("modalityBar")!;
    const modalityToggle = document.getElementById("modalityToggle")!;
    modalityBar.hidden = false;
    modalityToggle.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement)?.closest(
        "button[data-modality]",
      ) as HTMLButtonElement | null;
      if (!btn) return;
      const next = btn.dataset.modality as ModalityView | undefined;
      if (!next || next === modalityView) return;
      modalityToggle
        .querySelectorAll("button")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      modalityView = next;
      renderTotals(rooms, rates, summaryRange, modalityView);
      renderRooms(rooms, rates, summaryRange, modalityView);
      void renderChart(summaryRange, modalityView, rates, bothEnabled);
    });
  }

  // Room cards first (one server-side pass), chart loads separately so the
  // page feels responsive even when readings.jsonl is large.
  const todayFrom = startOfTodayLocal().toISOString();
  const { rooms } = await jget<{ rooms: RoomSummary[] }>(
    `/api/tenants/${encodeURIComponent(tenantId)}/rooms?todayFrom=${encodeURIComponent(todayFrom)}`,
  );

  rates = setupRateControls(tenant.modalities, (nextRates) => {
    rates = nextRates;
    renderTotals(rooms, rates, summaryRange, modalityView);
    renderRooms(rooms, rates, summaryRange, modalityView);
    void renderChart(summaryRange, modalityView, rates, bothEnabled);
  });

  renderTotals(rooms, rates, summaryRange, modalityView);
  renderRooms(rooms, rates, summaryRange, modalityView);
  attachRoomActions();
  attachStatsCarousel();
  attachChartLegend();

  void renderChart(summaryRange, modalityView, rates, bothEnabled, true).catch((err) => {
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
    rates = {
      electricityRatePerKWh: getElectricityRatePerKWh(tenantId),
      waterRatePerGal: getWaterRatePerGal(tenantId),
    };
    renderTotals(rooms, rates, summaryRange, modalityView);
    renderRooms(rooms, rates, summaryRange, modalityView);
    await renderChart(summaryRange, modalityView, rates, bothEnabled, true);
  });
}

main().catch((err) => {
  console.error(err);
  document.querySelector(".container")!.insertAdjacentHTML(
    "afterbegin",
    `<div class="error">Failed to load: ${escapeHtml(String(err))}</div>`,
  );
});
