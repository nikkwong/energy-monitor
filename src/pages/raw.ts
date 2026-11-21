import { jget, setupThemeToggle } from "./common.ts";

type RawReading = {
  ts: string;
  room: string;
  monitor: string;
  powerW: number;
  totalEnergyWh: number;
  raw?: unknown;
};

type RawResponse = {
  roomId: string;
  roomLabel: string;
  limit: number;
  readings: RawReading[];
};

function routeFromPath(): { tenantId: string; roomId: string } | null {
  const parts = window.location.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length !== 4 || parts[1] !== "rooms" || parts[3] !== "raw") return null;
  const tenantId = parts[0];
  const roomId = parts[2];
  return tenantId && roomId ? { tenantId, roomId } : null;
}

const route = routeFromPath();
setupThemeToggle(route?.tenantId ?? "global");

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 3 }) : "n/a";
}

function render(tenantId: string, tenantLabel: string, data: RawResponse): void {
  document.getElementById("rawTitle")!.textContent = `${data.roomLabel} · raw data`;
  document.title = `${tenantLabel} · ${data.roomLabel} raw data`;
  const roomLink = document.getElementById("roomLink") as HTMLAnchorElement;
  roomLink.href = `/${encodeURIComponent(tenantId)}/rooms/${encodeURIComponent(data.roomId)}`;

  const el = document.getElementById("rawReadings")!;
  if (data.readings.length === 0) {
    el.innerHTML = `<div class="empty">No stored readings for this room.</div>`;
    return;
  }

  el.innerHTML = `
    <div class="debug-list">
      ${data.readings
        .map(
          (reading) => `
            <article class="debug-row">
              <div class="debug-row-head">
                <strong>${escapeHtml(new Date(reading.ts).toLocaleString())}</strong>
                <span class="muted">${escapeHtml(reading.monitor)}</span>
              </div>
              <div class="debug-row-grid">
                <div><span class="muted">timestamp:</span> ${escapeHtml(reading.ts)}</div>
                <div><span class="muted">power:</span> ${formatNumber(reading.powerW)} W</div>
                <div><span class="muted">energy counter:</span> ${formatNumber(reading.totalEnergyWh)} Wh</div>
              </div>
              <details class="raw-payload">
                <summary>Raw payload</summary>
                <pre>${escapeHtml(JSON.stringify(reading.raw ?? null, null, 2))}</pre>
              </details>
            </article>
          `,
        )
        .join("")}
    </div>
  `;
}

async function load(): Promise<void> {
  if (!route) throw new Error("Invalid tenant raw data URL.");
  const { tenantId, roomId } = route;
  const limit = (document.getElementById("readingLimit") as HTMLSelectElement).value;
  const [tenant, data] = await Promise.all([
    jget<{ tenantId: string; label: string }>(`/api/tenants/${encodeURIComponent(tenantId)}/config`),
    jget<RawResponse>(
      `/api/tenants/${encodeURIComponent(tenantId)}/rooms/${encodeURIComponent(roomId)}/raw?limit=${encodeURIComponent(limit)}`,
    ),
  ]);
  render(tenantId, tenant.label, data);
}

document.getElementById("refreshBtn")!.addEventListener("click", () => {
  void load().catch(showError);
});
document.getElementById("readingLimit")!.addEventListener("change", () => {
  void load().catch(showError);
});

function showError(err: unknown): void {
  document.getElementById("errorBox")!.innerHTML =
    `<div class="error">${escapeHtml(String(err))}</div>`;
}

void load().catch(showError);
