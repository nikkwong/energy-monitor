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
  fmtMoney,
  fmtW,
  fmtRelativeTime,
  freshnessClass,
  getElectricityRatePerKWh,
  jget,
  jpost,
  jput,
} from "./common.ts";
import {
  displayMonitorLabel,
  visibleMonitorIds,
} from "../lib/monitors.ts";

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
  switch?: {
    output?: boolean;
    desiredOutput?: boolean;
    updatedAt?: string;
  };
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
  todayUsage: Usage;
  leaseTotals?: Record<string, number>;
  bills?: Array<{
    month: string;
    tenant: string;
    leaseId: string;
    from: string;
    to: string;
    energyKWh: number;
    status: "final" | "in_progress";
  }>;
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
let editMode = false;
let roomData: UsageResp | null = null;
let chartRange: RangeKey = "month";
// Reporters post every 60 seconds. Allow several missed/jittered intervals
// before showing the unavailable warning.
const DEVICE_STALE_MS = 5 * 60 * 1000;
const ROOM_LIVE_REFRESH_MS = 5 * 1000;

function localToday(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfTodayLocal(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function fetchRoomUsage(roomId: string): Promise<UsageResp> {
  const todayFrom = startOfTodayLocal().toISOString();
  return jget<UsageResp>(
    `/api/rooms/${encodeURIComponent(roomId)}/usage?todayFrom=${encodeURIComponent(todayFrom)}`,
  );
}

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

function deviceStaleMarker(iso: string | null | undefined): string {
  if (!iso) {
    return `<span class="device-alert" title="No readings from this device yet" aria-label="No readings from this device yet">!</span>`;
  }
  const age = Date.now() - new Date(iso).getTime();
  if (age <= DEVICE_STALE_MS) return "";
  return `<span class="device-alert" title="No updates!" aria-label="No updates!">!</span>`;
}

function showError(msg: string): void {
  const el = document.getElementById("errorBox")!;
  el.innerHTML = `<div class="error">${escapeHtml(msg)}</div>`;
}

function renderHeader(data: UsageResp): void {
  document.getElementById("roomTitle")!.textContent = data.room.label;
  document.title = `5214 · ${data.room.label}`;
  const rawLink = document.getElementById("rawDataLink") as HTMLAnchorElement;
  rawLink.href = `/${encodeURIComponent(data.room.id)}/raw`;
  rawLink.hidden = false;

  const lease = data.currentLease;
  const leaseLine = lease
    ? `lease started ${escapeHtml(lease.startDate)}`
    : `<span class="muted">no active lease</span>`;

  // Each monitor with a known IP becomes a clickable link to its admin UI.
  const monitors = data.room.monitors ?? {};
  const devicePieces = visibleMonitorIds(monitors)
    .sort()
    .map((id) => {
      const m = monitors[id]!;
      const label = escapeHtml(displayMonitorLabel(m, id));
      const alert = deviceStaleMarker(data.latest?.monitors[id]?.ts);
      if (!m.ip) return `${label}${alert}`;
      const ip = escapeHtml(m.ip);
      return `<a href="http://${ip}" target="_blank" rel="noopener" title="Shelly admin · ${ip}">${label}</a>${alert}`;
    });
  const devicesLine = devicePieces.length
    ? `<span class="muted">devices:</span> ${devicePieces.join(" · ")}`
    : "";

  document.getElementById("roomSubtitle")!.innerHTML = devicesLine
    ? `${leaseLine}<br>${devicesLine}`
    : leaseLine;
}

function monitorLabel(room: Room, id: string): string {
  return displayMonitorLabel(room.monitors?.[id], id);
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

function leaseEnergyKWh(data: UsageResp, leaseId: string): number {
  if (data.leaseTotals && leaseId in data.leaseTotals) {
    return data.leaseTotals[leaseId] ?? 0;
  }
  return (data.bills ?? [])
    .filter((b) => b.leaseId === leaseId)
    .reduce((sum, b) => sum + b.energyKWh, 0);
}

function isPlausibleIsoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const year = Number(v.slice(0, 4));
  if (year < 2000 || year > 2100) return false;
  const d = new Date(v + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function monthBeforeIso(isoDate: string): string {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 10);
}

function renderEditPanel(data: UsageResp): void {
  const panel = document.getElementById("editPanel")!;
  const ratePerKWh = getElectricityRatePerKWh();
  const history = [...data.room.leases].reverse();

  const historyRows = history.length
    ? `<div class="lease-list">
        ${history
          .map((l) => {
            const kwh = leaseEnergyKWh(data, l.id);
            const idAttr = escapeHtml(l.id);
            return `
              <div class="lease-row" data-lease-row="${idAttr}">
                <div class="lease-dates">
                  <input
                    type="date"
                    class="lease-date-input tabular"
                    data-lease-id="${idAttr}"
                    data-field="startDate"
                    value="${escapeHtml(l.startDate)}"
                    aria-label="Lease start date"
                  />
                  <span class="lease-date-sep">–</span>
                  <input
                    type="date"
                    class="lease-date-input tabular"
                    data-lease-id="${idAttr}"
                    data-field="endDate"
                    value="${escapeHtml(l.endDate ?? "")}"
                    aria-label="Lease end date"
                  />
                  <span class="lease-current-tag" data-lease-current="${idAttr}">${
                    l.endDate === null ? "current" : ""
                  }</span>
                </div>
                <div class="lease-row-right">
                  <div class="lease-usage tabular" data-lease-usage="${idAttr}">
                    <div class="lease-kwh">${fmtKWh(kwh)} kWh</div>
                    <div class="lease-cost">${fmtMoney(kwh * ratePerKWh)}</div>
                  </div>
                  <button
                    type="button"
                    class="lease-delete"
                    data-delete-lease="${idAttr}"
                    title="Remove lease"
                    aria-label="Remove lease"
                  >×</button>
                </div>
              </div>
            `;
          })
          .join("")}
      </div>`
    : `<div class="lease-empty muted">No lease history yet. Click + to add a tenant.</div>`;

  panel.innerHTML = `
    <div class="edit-section">
      <div class="edit-head">
        <div>
          <h3>History</h3>
          <p class="edit-hint">Edit start – end dates to backdate or adjust leases. Leave end date blank for the current tenant.</p>
        </div>
        <button type="button" class="btn-add-lease" id="addLeaseBtn" title="Add tenant" aria-label="Add tenant">+</button>
      </div>
      ${historyRows}
      <div class="edit-msg" id="leaseEditMsg"></div>
    </div>

    <div class="edit-actions">
      <button type="button" class="btn-text active" id="editDoneBtn">Done</button>
    </div>
  `;

  document.getElementById("addLeaseBtn")?.addEventListener("click", () => {
    void handleAddLease(data.room.id);
  });

  panel.querySelectorAll<HTMLInputElement>("input.lease-date-input").forEach((input) => {
    input.addEventListener("change", () => {
      void handleLeaseDateChange(data.room.id, input);
    });
  });

  panel.querySelectorAll<HTMLButtonElement>("button[data-delete-lease]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const leaseId = btn.dataset.deleteLease;
      if (leaseId) void handleDeleteLease(data.room.id, leaseId);
    });
  });

  document.getElementById("editDoneBtn")?.addEventListener("click", () => {
    setEditMode(false);
  });
}

function updateEditPanelInPlace(data: UsageResp): void {
  const panel = document.getElementById("editPanel");
  if (!panel || panel.hidden) return;
  const ratePerKWh = getElectricityRatePerKWh();

  for (const l of data.room.leases) {
    const kwh = leaseEnergyKWh(data, l.id);
    const usageEl = panel.querySelector<HTMLElement>(
      `[data-lease-usage="${CSS.escape(l.id)}"]`,
    );
    if (usageEl) {
      usageEl.innerHTML = `
        <div class="lease-kwh">${fmtKWh(kwh)} kWh</div>
        <div class="lease-cost">${fmtMoney(kwh * ratePerKWh)}</div>
      `;
    }
    const curEl = panel.querySelector<HTMLElement>(
      `[data-lease-current="${CSS.escape(l.id)}"]`,
    );
    if (curEl) {
      curEl.textContent = l.endDate === null ? "current" : "";
    }
    const startInput = panel.querySelector<HTMLInputElement>(
      `input.lease-date-input[data-lease-id="${CSS.escape(l.id)}"][data-field="startDate"]`,
    );
    if (startInput && document.activeElement !== startInput && startInput.value !== l.startDate) {
      startInput.value = l.startDate;
    }
    const endInput = panel.querySelector<HTMLInputElement>(
      `input.lease-date-input[data-lease-id="${CSS.escape(l.id)}"][data-field="endDate"]`,
    );
    const wantedEnd = l.endDate ?? "";
    if (endInput && document.activeElement !== endInput && endInput.value !== wantedEnd) {
      endInput.value = wantedEnd;
    }
  }
}

function setEditMode(on: boolean): void {
  editMode = on;
  const panel = document.getElementById("editPanel")!;
  const btn = document.getElementById("editToggle")!;
  panel.hidden = !on;
  btn.textContent = on ? "Done" : "Edit";
  btn.classList.toggle("active", on);
  if (on && roomData) renderEditPanel(roomData);
}

function setEditMsg(id: string, text: string, ok: boolean): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = `edit-msg ${ok ? "ok" : "error"}`;
}

async function persistLeases(
  roomId: string,
  leases: Lease[],
  opts: { rebuildPanel: boolean },
): Promise<void> {
  setEditMsg("leaseEditMsg", "", true);
  try {
    await jput(`/api/rooms/${encodeURIComponent(roomId)}/leases`, { leases });
    await reloadRoom(roomId, {
      renderChart: true,
      renderEditPanel: opts.rebuildPanel,
    });
  } catch (err) {
    setEditMsg("leaseEditMsg", String(err), false);
  }
}

async function handleAddLease(roomId: string): Promise<void> {
  const btn = document.getElementById("addLeaseBtn") as HTMLButtonElement | null;
  const leases = (roomData?.room.leases ?? []).map((l) => ({ ...l }));
  const today = localToday();
  const newId = `lease-${roomId}-${Date.now()}`;

  if (leases.length === 0) {
    leases.push({
      id: newId,
      tenant: "",
      startDate: today,
      endDate: null,
    });
  } else {
    const sorted = [...leases].sort((a, b) => a.startDate.localeCompare(b.startDate));
    const latest = sorted[sorted.length - 1]!;
    const earliest = sorted[0]!;

    if (latest.endDate === null && latest.startDate < today) {
      latest.endDate = today;
      leases.push({
        id: newId,
        tenant: "",
        startDate: today,
        endDate: null,
      });
    } else if (latest.endDate !== null && latest.endDate <= today) {
      leases.push({
        id: newId,
        tenant: "",
        startDate: today,
        endDate: null,
      });
    } else {
      // Latest lease already starts on or after today; add a prior lease row
      // before the earliest lease so the user can edit/backdate it freely.
      const priorEnd = earliest.startDate;
      const priorStart = monthBeforeIso(priorEnd);
      leases.unshift({
        id: newId,
        tenant: "",
        startDate: priorStart,
        endDate: priorEnd,
      });
    }
  }

  if (btn) btn.disabled = true;
  try {
    await persistLeases(roomId, leases, { rebuildPanel: true });
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function handleDeleteLease(roomId: string, leaseId: string): Promise<void> {
  const leases = (roomData?.room.leases ?? []).filter((l) => l.id !== leaseId);
  await persistLeases(roomId, leases, { rebuildPanel: true });
}

async function handleLeaseDateChange(
  roomId: string,
  input: HTMLInputElement,
): Promise<void> {
  const leaseId = input.dataset.leaseId;
  const field = input.dataset.field as "startDate" | "endDate" | undefined;
  if (!leaseId || !field || !roomData) return;

  const raw = input.value.trim();
  const leases = roomData.room.leases.map((l) => ({ ...l }));
  const target = leases.find((l) => l.id === leaseId);
  if (!target) return;

  if (field === "startDate") {
    if (!isPlausibleIsoDate(raw)) return;
    const oldStart = target.startDate;
    if (raw === oldStart) return;
    if (target.endDate !== null && raw >= target.endDate) {
      setEditMsg("leaseEditMsg", "Start date must be before end date.", false);
      return;
    }
    for (const other of leases) {
      if (other.id === target.id) continue;
      if (other.endDate === oldStart && raw > other.startDate) {
        other.endDate = raw;
      } else if (
        other.startDate < raw &&
        other.endDate !== null &&
        other.endDate > raw
      ) {
        other.endDate = raw;
      }
    }
    target.startDate = raw;
  } else {
    const newEnd = raw === "" ? null : raw;
    if (newEnd !== null && !isPlausibleIsoDate(newEnd)) return;
    const oldEnd = target.endDate;
    if (newEnd === oldEnd) return;
    if (newEnd !== null && newEnd <= target.startDate) {
      setEditMsg("leaseEditMsg", "End date must be after start date.", false);
      return;
    }
    if (newEnd !== null) {
      for (const other of leases) {
        if (other.id === target.id) continue;
        if (
          other.startDate >= target.startDate &&
          other.startDate < newEnd &&
          (other.endDate === null || newEnd < other.endDate)
        ) {
          other.startDate = newEnd;
        }
      }
    }
    target.endDate = newEnd;
  }

  await persistLeases(roomId, leases, { rebuildPanel: false });
}

async function reloadRoom(
  roomId: string,
  opts: { renderChart?: boolean; renderEditPanel?: boolean } = {},
): Promise<void> {
  const renderChartAfterLoad = opts.renderChart ?? true;
  const renderEditPanelAfterLoad = opts.renderEditPanel ?? true;
  roomData = await fetchRoomUsage(roomId);
  renderHeader(roomData);
  renderStats(roomData);
  renderSwitchControls(roomData);
  renderBills(roomData);
  if (editMode) {
    if (renderEditPanelAfterLoad) renderEditPanel(roomData);
    else updateEditPanelInPlace(roomData);
  }
  const leaseStart = roomData.currentLease?.startDate ?? null;
  if (renderChartAfterLoad) {
    await renderChart(roomId, chartRange, leaseStart);
  }
}

function renderSwitchControls(data: UsageResp): void {
  const el = document.getElementById("switchControls")!;
  const monitors = data.room.monitors ?? {};
  const switchIds = visibleMonitorIds(monitors).filter((id) => Boolean(monitors[id]?.switch));
  if (switchIds.length === 0) {
    el.innerHTML = "";
    return;
  }

  el.innerHTML = `
    <div class="switch-control-list">
      ${switchIds
        .sort()
        .map((id) => {
          const monitor = monitors[id]!;
          const sw = monitor.switch!;
          const output = sw.output === true;
          const desired = sw.desiredOutput;
          const queued = typeof desired === "boolean" && desired !== sw.output;
          const stateText = output ? "on" : "off";
          const queuedText = queued ? ` · queued ${desired ? "on" : "off"}` : "";
          return `
            <div class="switch-control-row">
              <div>
                <div class="switch-control-name">${escapeHtml(displayMonitorLabel(monitor, id))}</div>
                <div class="switch-control-sub">currently ${stateText}${queuedText}</div>
              </div>
              <div class="switch-buttons">
                <button type="button" class="${output ? "active" : ""}" data-monitor="${escapeHtml(id)}" data-output="true">On</button>
                <button type="button" class="${!output ? "active" : ""}" data-monitor="${escapeHtml(id)}" data-output="false">Off</button>
              </div>
            </div>
          `;
        })
        .join("")}
    </div>
  `;

  el.querySelectorAll<HTMLButtonElement>("button[data-monitor]").forEach((button) => {
    button.addEventListener("click", () => {
      const monitorId = button.dataset.monitor;
      const output = button.dataset.output === "true";
      if (!monitorId) return;
      void handleSwitch(data.room.id, monitorId, output, button);
    });
  });
}

async function handleSwitch(
  roomId: string,
  monitorId: string,
  output: boolean,
  button: HTMLButtonElement,
): Promise<void> {
  button.disabled = true;
  try {
    await jpost(`/api/rooms/${encodeURIComponent(roomId)}/monitors/${encodeURIComponent(monitorId)}/switch`, {
      output,
    });
    await reloadRoom(roomId);
  } catch (err) {
    showError(String(err));
  } finally {
    button.disabled = false;
  }
}

function formatMonth(month: string): string {
  const d = new Date(month + "-01T00:00:00Z");
  return d.toLocaleDateString([], { month: "long", year: "numeric", timeZone: "UTC" });
}

function formatBillRange(from: string, to: string): string {
  const opts: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  };
  return `${new Date(from).toLocaleDateString([], opts)} – ${new Date(to).toLocaleDateString([], opts)}`;
}

function renderBills(data: UsageResp): void {
  const el = document.getElementById("bills")!;
  const bills = data.bills ?? [];
  const ratePerKWh = getElectricityRatePerKWh();
  if (bills.length === 0) {
    el.innerHTML = `<div class="empty">No lease history yet, so there are no monthly bills.</div>`;
    return;
  }

  el.innerHTML = `
    <div class="bill-list">
      ${bills
        .map(
          (b) => `
            <div class="bill-row">
              <div class="bill-main">
                <div class="bill-month">${escapeHtml(formatMonth(b.month))}</div>
                <div class="bill-sub">
                  ${escapeHtml(formatBillRange(b.from, b.to))}
                </div>
              </div>
              <div class="bill-usage tabular">
                <div class="bill-kwh">${fmtKWh(b.energyKWh)} kWh</div>
                <div class="bill-cost">${fmtMoney(b.energyKWh * ratePerKWh)}</div>
              </div>
              <span class="bill-status ${b.status === "in_progress" ? "progress" : "final"}">
                ${b.status === "in_progress" ? "in progress" : "final"}
              </span>
            </div>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderStats(data: UsageResp): void {
  const latest = data.latest;
  const cls = freshnessClass(latest?.ts ?? null);
  const ratePerKWh = getElectricityRatePerKWh();
  const rateText = `at ${fmtMoney(ratePerKWh)}/kWh`;

  // Per-monitor breakdowns only add value once a room has more than one feed.
  const monthIds = visibleMonitorIds(data.room.monitors);
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

  const todayBreakdown =
    monthIds.length > 1
      ? monthIds
          .sort()
          .map((id) => {
            const kwh = data.todayUsage.monitors[id] ?? 0;
            return `<span class="muted">${monitorLabelHtml(data.room, id)}:</span> ${fmtKWh(kwh)}`;
          })
          .join(" · ")
      : "";

  const liveIds = latest ? visibleMonitorIds(data.room.monitors) : [];
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
      <div class="cost tabular">${fmtMoney(data.monthUsage.energyKWh * ratePerKWh)}</div>
      <div class="sub">${[rateText, monthBreakdown].filter(Boolean).join(" · ") || "&nbsp;"}</div>
    </div>
    <div class="card">
      <div class="label">Right now</div>
      <div class="value tabular">${fmtW(latest?.powerW ?? null)}</div>
      <div class="sub">
        <span class="dot ${cls}"></span>${fmtRelativeTime(latest?.ts ?? null)}
        ${liveBreakdown ? `<div style="margin-top:4px;">${liveBreakdown}</div>` : ""}
      </div>
    </div>
    <div class="card">
      <div class="label">Used today</div>
      <div class="value tabular">${fmtKWh(data.todayUsage.energyKWh)}<span class="unit">kWh</span></div>
      <div class="cost tabular">${fmtMoney(data.todayUsage.energyKWh * ratePerKWh)}</div>
      <div class="sub">${[rateText, todayBreakdown].filter(Boolean).join(" · ") || "&nbsp;"}</div>
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
    data = await fetchRoomUsage(roomId);
  } catch (err) {
    document.getElementById("roomTitle")!.textContent = `Room ${roomId}`;
    showError(
      `Could not load room: ${String(err)}. ` +
        `Make sure "${roomId}" is in data/rooms.json.`,
    );
    return;
  }

  roomData = data;
  renderHeader(data);
  renderStats(data);
  renderSwitchControls(data);
  renderBills(data);

  const editBtn = document.getElementById("editToggle")!;
  editBtn.hidden = false;
  editBtn.addEventListener("click", () => setEditMode(!editMode));

  const leaseStart = data.currentLease?.startDate ?? null;
  chartRange = "month";
  await renderChart(roomId, chartRange, leaseStart);

  const toggle = document.getElementById("ranges")!;
  toggle.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    if (t.tagName !== "BUTTON") return;
    toggle.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
    t.classList.add("active");
    chartRange = t.dataset.range as RangeKey;
    const start = roomData?.currentLease?.startDate ?? null;
    await renderChart(roomId, chartRange, start);
  });

  let liveRefreshInFlight = false;
  window.setInterval(() => {
    if (document.hidden || liveRefreshInFlight) return;
    liveRefreshInFlight = true;
    void reloadRoom(roomId, { renderChart: false, renderEditPanel: false })
      .catch((err) => console.warn("room live refresh failed:", err))
      .finally(() => {
        liveRefreshInFlight = false;
      });
  }, ROOM_LIVE_REFRESH_MS);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden || liveRefreshInFlight) return;
    liveRefreshInFlight = true;
    void reloadRoom(roomId, { renderChart: false, renderEditPanel: false })
      .catch((err) => console.warn("room live refresh failed:", err))
      .finally(() => {
        liveRefreshInFlight = false;
      });
  });
}

main().catch((err) => {
  console.error(err);
  showError(String(err));
});
