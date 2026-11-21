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
  chartAxisAndTooltipOptions,
  fmtKWh,
  fmtMoney,
  fmtW,
  fmtRelativeTime,
  freshnessClass,
  getElectricityRatePerKWh,
  jget,
  jpost,
  jput,
  setupThemeToggle,
  startOfTodayLocal,
  themeCssVar,
} from "./common.ts";
import { isValidEmail, normalizeEmail } from "../lib/email.ts";
import {
  displayMonitorLabel,
  normalizeRoomModalities,
  visibleMonitorIds,
} from "../lib/monitors.ts";
import type { UtilityModalities } from "../lib/types.ts";
import { hydrateUtilityIcons, utilityIconHtml } from "./icons.ts";

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
  email?: string;
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
  modalities?: UtilityModalities;
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
  hasReadings?: UtilityModalities;
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
let tenantLabel = "Dashboard";
let tenantModalities: UtilityModalities = { power: true, water: false };
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

function routeIds(): { tenantId: string; roomId: string; edit: boolean } | null {
  const parts = window.location.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if ((parts.length !== 3 && parts.length !== 4) || parts[1] !== "rooms") return null;
  if (parts.length === 4 && parts[3] !== "edit") return null;
  const tenantId = parts[0];
  const roomId = parts[2];
  return tenantId && roomId ? { tenantId, roomId, edit: parts.length === 4 } : null;
}

const route = routeIds();
const tenantId = route?.tenantId ?? "";

function fetchRoomUsage(roomId: string): Promise<UsageResp> {
  const todayFrom = startOfTodayLocal().toISOString();
  return jget<UsageResp>(
    `/api/tenants/${encodeURIComponent(tenantId)}/rooms/${encodeURIComponent(roomId)}/usage?todayFrom=${encodeURIComponent(todayFrom)}`,
  );
}

function roomPowerActive(data: UsageResp): boolean {
  return tenantModalities.power && normalizeRoomModalities(data.room.modalities).power;
}

function roomWaterActive(data: UsageResp): boolean {
  return tenantModalities.water && normalizeRoomModalities(data.room.modalities).water;
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
  document.title = `${tenantLabel} · ${data.room.label}`;
  const rawLink = document.getElementById("rawDataLink") as HTMLAnchorElement | null;
  if (rawLink) {
    rawLink.href = `/${encodeURIComponent(tenantId)}/rooms/${encodeURIComponent(data.room.id)}/raw`;
    rawLink.hidden = !roomPowerActive(data);
  }

  const lease = data.currentLease;
  const leaseLine = lease
    ? `lease started ${escapeHtml(lease.startDate)}`
    : `<span class="muted">no active lease</span>`;

  // Each monitor with a known IP becomes a clickable link to its admin UI.
  const monitors = data.room.monitors ?? {};
  const devicePieces = roomPowerActive(data)
    ? visibleMonitorIds(monitors)
        .sort()
        .map((id) => {
          const m = monitors[id]!;
          const label = escapeHtml(displayMonitorLabel(m, id));
          const alert = deviceStaleMarker(data.latest?.monitors[id]?.ts);
          if (!m.ip) return `${label}${alert}`;
          const ip = escapeHtml(m.ip);
          return `<a href="http://${ip}" target="_blank" rel="noopener" title="Shelly admin · ${ip}">${label}</a>${alert}`;
        })
    : [];
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
  const ratePerKWh = getElectricityRatePerKWh(tenantId);
  const history = [...data.room.leases].reverse();
  const roomMod = normalizeRoomModalities(data.room.modalities);
  const hasPowerData = Boolean(data.hasReadings?.power);
  const hasWaterData = Boolean(data.hasReadings?.water);
  const powerOffLocked = roomMod.power && hasPowerData;
  const waterOffLocked = roomMod.water && hasWaterData;

  const historyRows = history.length
    ? `<div class="lease-list">
        ${history
          .map((l) => {
            const kwh = leaseEnergyKWh(data, l.id);
            const idAttr = escapeHtml(l.id);
            const periodDesc = `${l.startDate} to ${l.endDate ?? "present"}`;
            return `
              <div class="lease-row" data-lease-row="${idAttr}">
                <div class="lease-main">
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
                  <div class="lease-email-row">
                    <input
                      type="email"
                      class="lease-email-input"
                      data-lease-email="${idAttr}"
                      value="${escapeHtml(l.email ?? "")}"
                      placeholder="Email address"
                      aria-label="Email address for ${escapeHtml(periodDesc)}"
                      autocomplete="email"
                    />
                    <button
                      type="button"
                      class="btn-text lease-email-save"
                      data-save-lease-email="${idAttr}"
                    >Save</button>
                    <span class="lease-email-status" data-lease-email-msg="${idAttr}" aria-live="polite"></span>
                  </div>
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
      <div class="edit-head edit-utilities-head">
        <div>
          <h3>Utilities</h3>
          ${
            powerOffLocked || waterOffLocked
              ? `<p class="edit-hint">Utilities with recorded readings cannot be turned off.</p>`
              : ""
          }
        </div>
        <div class="utility-toggles" role="group" aria-label="Room utilities">
          <div class="utility-toggle-item">
            <span class="utility-toggle-label"><span class="inline-utility">${utilityIconHtml("power")}Power</span></span>
            <div class="range-toggle utility-seg">
              <button type="button" class="${roomMod.power ? "active" : ""}" data-room-modality="power" data-enabled="true">On</button>
              <button
                type="button"
                class="${!roomMod.power ? "active" : ""}"
                data-room-modality="power"
                data-enabled="false"
                ${powerOffLocked ? 'disabled title="Cannot turn off — room has power reading data"' : ""}
              >Off</button>
            </div>
          </div>
          <div class="utility-toggle-item">
            <span class="utility-toggle-label"><span class="inline-utility">${utilityIconHtml("water")}Water</span></span>
            <div class="range-toggle utility-seg">
              <button type="button" class="${roomMod.water ? "active" : ""}" data-room-modality="water" data-enabled="true">On</button>
              <button
                type="button"
                class="${!roomMod.water ? "active" : ""}"
                data-room-modality="water"
                data-enabled="false"
                ${waterOffLocked ? 'disabled title="Cannot turn off — room has water reading data"' : ""}
              >Off</button>
            </div>
          </div>
        </div>
      </div>
      <div class="edit-msg" id="modalitiesMsg"></div>
    </div>

    <div class="edit-section">
      <div class="edit-head">
        <div>
          <h3>History</h3>
          <p class="edit-hint">Edit start – end dates to backdate or adjust leases, or attach a contact email to a period. Leave end date blank for the current tenant.</p>
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

  panel.querySelectorAll<HTMLButtonElement>("button[data-room-modality]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const kind = btn.dataset.roomModality as "power" | "water" | undefined;
      const enabled = btn.dataset.enabled === "true";
      if (!kind || roomMod[kind] === enabled) return;
      void handleRoomModality(data.room.id, kind, enabled, btn);
    });
  });

  document.getElementById("addLeaseBtn")?.addEventListener("click", () => {
    void handleAddLease(data.room.id);
  });

  panel.querySelectorAll<HTMLInputElement>("input.lease-date-input").forEach((input) => {
    input.addEventListener("change", () => {
      void handleLeaseDateChange(data.room.id, input);
    });
  });

  panel.querySelectorAll<HTMLInputElement>("input.lease-email-input").forEach((input) => {
    input.addEventListener("input", () => {
      input.classList.remove("invalid");
      const leaseId = input.dataset.leaseEmail;
      if (leaseId) setLeaseEmailStatus(leaseId, "", true);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const leaseId = input.dataset.leaseEmail;
      if (leaseId) void handleSaveLeaseEmail(data.room.id, leaseId);
    });
  });

  panel.querySelectorAll<HTMLButtonElement>("button[data-save-lease-email]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const leaseId = btn.dataset.saveLeaseEmail;
      if (leaseId) void handleSaveLeaseEmail(data.room.id, leaseId);
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
  const ratePerKWh = getElectricityRatePerKWh(tenantId);
  const roomMod = normalizeRoomModalities(data.room.modalities);
  const powerOffBtn = panel.querySelector<HTMLButtonElement>(
    'button[data-room-modality="power"][data-enabled="false"]',
  );
  if (powerOffBtn && roomMod.power && data.hasReadings?.power) {
    powerOffBtn.disabled = true;
    powerOffBtn.title = "Cannot turn off — room has power reading data";
  }
  const waterOffBtn = panel.querySelector<HTMLButtonElement>(
    'button[data-room-modality="water"][data-enabled="false"]',
  );
  if (waterOffBtn && roomMod.water && data.hasReadings?.water) {
    waterOffBtn.disabled = true;
    waterOffBtn.title = "Cannot turn off — room has water reading data";
  }

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
    const emailInput = panel.querySelector<HTMLInputElement>(
      `input.lease-email-input[data-lease-email="${CSS.escape(l.id)}"]`,
    );
    const wantedEmail = l.email ?? "";
    if (
      emailInput &&
      document.activeElement !== emailInput &&
      !emailInput.classList.contains("invalid") &&
      emailInput.value === wantedEmail
    ) {
      emailInput.value = wantedEmail;
    }
  }
}

function setEditMode(on: boolean, syncUrl = true): void {
  editMode = on;
  const panel = document.getElementById("editPanel")!;
  const btn = document.getElementById("editToggle")!;
  panel.hidden = !on;
  btn.textContent = on ? "Done" : "Edit";
  btn.classList.toggle("active", on);
  if (on && roomData) renderEditPanel(roomData);
  if (syncUrl && route) {
    const base = `/${encodeURIComponent(route.tenantId)}/rooms/${encodeURIComponent(route.roomId)}`;
    const nextPath = on ? `${base}/edit` : base;
    if (window.location.pathname !== nextPath) {
      window.history.pushState(null, "", `${nextPath}${window.location.search}`);
    }
  }
}

async function handleRoomModality(
  roomId: string,
  kind: "power" | "water",
  enabled: boolean,
  button: HTMLButtonElement,
): Promise<void> {
  button.disabled = true;
  setEditMsg("modalitiesMsg", "", true);
  try {
    await jpost(
      `/api/tenants/${encodeURIComponent(tenantId)}/rooms/${encodeURIComponent(roomId)}/modalities`,
      { [kind]: enabled },
    );
    await reloadRoom(roomId);
  } catch (err) {
    setEditMsg("modalitiesMsg", String(err), false);
    button.disabled = false;
  }
}

function setEditMsg(id: string, text: string, ok: boolean): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = `edit-msg ${ok ? "ok" : "error"}`;
}

function setLeaseEmailStatus(leaseId: string, text: string, ok: boolean): void {
  const el = document.querySelector<HTMLElement>(
    `[data-lease-email-msg="${CSS.escape(leaseId)}"]`,
  );
  if (!el) return;
  el.textContent = text;
  el.className = text ? `lease-email-status ${ok ? "ok" : "error"}` : "lease-email-status";
}

async function handleSaveLeaseEmail(roomId: string, leaseId: string): Promise<void> {
  const panel = document.getElementById("editPanel");
  const input = panel?.querySelector<HTMLInputElement>(
    `input.lease-email-input[data-lease-email="${CSS.escape(leaseId)}"]`,
  );
  const btn = panel?.querySelector<HTMLButtonElement>(
    `button[data-save-lease-email="${CSS.escape(leaseId)}"]`,
  );
  if (!input) return;

  const existingEmail = roomData?.room.leases.find((l) => l.id === leaseId)?.email ?? "";
  const cleaned = normalizeEmail(input.value);

  if (!cleaned && !existingEmail) {
    input.classList.add("invalid");
    setLeaseEmailStatus(leaseId, "Enter an email address.", false);
    input.focus();
    return;
  }
  if (cleaned && !isValidEmail(cleaned)) {
    input.classList.add("invalid");
    setLeaseEmailStatus(leaseId, "Enter a valid email address.", false);
    input.focus();
    return;
  }

  input.classList.remove("invalid");
  if (btn) btn.disabled = true;
  setLeaseEmailStatus(leaseId, "", true);

  try {
    await jpost(
      `/api/tenants/${encodeURIComponent(tenantId)}/rooms/${encodeURIComponent(roomId)}/leases/${encodeURIComponent(leaseId)}/email`,
      { email: cleaned || null },
    );
    input.value = cleaned;
    await reloadRoom(roomId, { renderChart: false, renderEditPanel: false });
    setLeaseEmailStatus(leaseId, cleaned ? "Saved" : "Cleared", true);
  } catch (err) {
    setLeaseEmailStatus(leaseId, String(err), false);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function persistLeases(
  roomId: string,
  leases: Lease[],
  opts: { rebuildPanel: boolean },
): Promise<void> {
  setEditMsg("leaseEditMsg", "", true);
  try {
    await jput(
      `/api/tenants/${encodeURIComponent(tenantId)}/rooms/${encodeURIComponent(roomId)}/leases`,
      { leases },
    );
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

async function renderRoomBody(
  data: UsageResp,
  opts: { renderChart?: boolean } = {},
): Promise<void> {
  const shouldRenderChart = opts.renderChart ?? true;
  const powerOn = roomPowerActive(data);
  const waterOn = roomWaterActive(data);

  document.getElementById("stats")!.hidden = !powerOn;
  document.getElementById("switchControls")!.hidden = !powerOn;
  document.getElementById("powerChartCard")!.hidden = !powerOn;
  document.getElementById("billsSection")!.hidden = !powerOn;

  const notice = document.getElementById("roomUtilityNotice")!;
  if (!powerOn) {
    if (chart) {
      chart.destroy();
      chart = null;
    }
    notice.hidden = false;
    const msg = waterOn
      ? "Power monitoring is turned off for this room. Water telemetry UI is not rendered yet."
      : "Power and water monitoring are turned off for this room.";
    notice.innerHTML = `<div class="empty">${escapeHtml(msg)}</div>`;
    return;
  }

  notice.hidden = true;
  notice.innerHTML = "";
  renderStats(data);
  renderSwitchControls(data);
  renderBills(data);
  if (shouldRenderChart) {
    const leaseStart = data.currentLease?.startDate ?? null;
    await renderChart(data.room.id, chartRange, leaseStart);
  }
}

async function reloadRoom(
  roomId: string,
  opts: { renderChart?: boolean; renderEditPanel?: boolean } = {},
): Promise<void> {
  const renderChartAfterLoad = opts.renderChart ?? true;
  const renderEditPanelAfterLoad = opts.renderEditPanel ?? true;
  roomData = await fetchRoomUsage(roomId);
  renderHeader(roomData);
  if (editMode) {
    if (renderEditPanelAfterLoad) renderEditPanel(roomData);
    else updateEditPanelInPlace(roomData);
  }
  await renderRoomBody(roomData, { renderChart: renderChartAfterLoad });
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
                <div class="switch-control-name"><span class="inline-utility">${utilityIconHtml("power")}${escapeHtml(displayMonitorLabel(monitor, id))}</span></div>
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
    await jpost(
      `/api/tenants/${encodeURIComponent(tenantId)}/rooms/${encodeURIComponent(roomId)}/monitors/${encodeURIComponent(monitorId)}/switch`,
      { output },
    );
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
  const ratePerKWh = getElectricityRatePerKWh(tenantId);
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
                <div class="bill-kwh"><span class="inline-utility">${utilityIconHtml("power")}${fmtKWh(b.energyKWh)} kWh</span></div>
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
  const ratePerKWh = getElectricityRatePerKWh(tenantId);
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
  document.getElementById("chartTitle")!.innerHTML = `${utilityIconHtml("power")}<span>${escapeHtml(r.title)}</span>`;
  const url =
    `/api/tenants/${encodeURIComponent(tenantId)}/rooms/${encodeURIComponent(roomId)}/series` +
    `?from=${r.from.toISOString()}&to=${r.to.toISOString()}&bucket=${r.bucket}`;
  const data = await jget<SeriesResp>(url);

  const labels = data.series.map((p) => formatLabel(p.ts, r.bucket));
  const values = data.series.map((p) => p.energyKWh);

  const canvas = document.getElementById("chart") as HTMLCanvasElement;
  const chartTheme = chartAxisAndTooltipOptions();
  if (chart) chart.destroy();
  chart = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "kWh",
          data: values,
          borderColor: themeCssVar("--chart-power"),
          backgroundColor: themeCssVar("--chart-power-fill"),
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
        ...chartTheme.plugins,
        tooltip: {
          ...chartTheme.plugins.tooltip,
          callbacks: {
            label: (ctx) => `${(ctx.parsed.y as number).toFixed(2)} kWh`,
          },
        },
      },
      scales: chartTheme.scales,
    },
  });
}

async function main(): Promise<void> {
  hydrateUtilityIcons();
  if (!route) {
    showError("Invalid tenant room URL.");
    return;
  }
  const { roomId } = route;
  const tenant = await jget<{
    tenantId: string;
    label: string;
    modalities: { power: boolean; water: boolean };
  }>(`/api/tenants/${encodeURIComponent(tenantId)}/config`);
  tenantLabel = tenant.label;
  tenantModalities = tenant.modalities;
  (document.getElementById("allRoomsLink") as HTMLAnchorElement).href =
    `/${encodeURIComponent(tenantId)}`;

  let data: UsageResp;
  try {
    data = await fetchRoomUsage(roomId);
  } catch (err) {
    document.getElementById("roomTitle")!.textContent = `Room ${roomId}`;
    showError(
      `Could not load room: ${String(err)}. ` +
        `Make sure "${roomId}" is in data/tenants/${tenantId}/rooms.json.`,
    );
    return;
  }

  roomData = data;
  renderHeader(data);

  const editBtn = document.getElementById("editToggle")!;
  editBtn.hidden = false;
  editBtn.addEventListener("click", () => setEditMode(!editMode));
  window.addEventListener("popstate", () => {
    const cur = routeIds();
    if (cur) setEditMode(cur.edit, false);
  });

  if (route.edit) {
    setEditMode(true, false);
  }

  chartRange = "month";
  await renderRoomBody(data);

  setupThemeToggle(tenantId, () => {
    if (!roomData || !roomPowerActive(roomData)) return;
    const start = roomData.currentLease?.startDate ?? null;
    void renderChart(roomId, chartRange, start);
  });

  const toggle = document.getElementById("ranges")!;
  toggle.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    if (t.tagName !== "BUTTON") return;
    toggle.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
    t.classList.add("active");
    chartRange = t.dataset.range as RangeKey;
    if (!roomData || !roomPowerActive(roomData)) return;
    const start = roomData.currentLease?.startDate ?? null;
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
