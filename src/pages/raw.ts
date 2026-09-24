import { jget } from "./common.ts";

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

function roomIdFromPath(): string {
  const parts = window.location.pathname.split("/").filter(Boolean);
  return parts.length >= 2 ? decodeURIComponent(parts[0]!) : "";
}

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

function render(data: RawResponse): void {
  document.getElementById("rawTitle")!.textContent = `${data.roomLabel} · raw data`;
  document.title = `5214 · ${data.roomLabel} raw data`;
  const roomLink = document.getElementById("roomLink") as HTMLAnchorElement;
  roomLink.href = `/${encodeURIComponent(data.roomId)}`;

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
  const roomId = roomIdFromPath();
  if (!roomId) throw new Error("No room id in URL.");
  const limit = (document.getElementById("readingLimit") as HTMLSelectElement).value;
  const data = await jget<RawResponse>(
    `/api/rooms/${encodeURIComponent(roomId)}/raw?limit=${encodeURIComponent(limit)}`,
  );
  render(data);
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
