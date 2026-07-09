import { jget } from "./common.ts";

type TrafficEntry = {
  id: number;
  at: string;
  method: string;
  path: string;
  roomId?: string;
  monitorId?: string;
  status: number;
  ok: boolean;
  message: string;
  remoteIp?: string;
  userAgent?: string;
  contentType?: string;
  query?: Record<string, string>;
  bodyParseOk?: boolean;
  normalized?: {
    hasReading: boolean;
    powerW: number;
    totalEnergyWh: number;
    ts: string;
    ip?: string;
  };
  autoRegistered?: {
    newRoom: boolean;
    newMonitor: boolean;
  };
};

type DebugResp = {
  now: string;
  traffic: TrafficEntry[];
};

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtNumber(n: number): string {
  if (!Number.isFinite(n)) return "n/a";
  return Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(2);
}

function renderStats(entries: TrafficEntry[]): void {
  const ok = entries.filter((e) => e.ok).length;
  const rejected = entries.length - ok;
  const rooms = new Set(entries.map((e) => e.roomId).filter(Boolean)).size;
  const el = document.getElementById("debugStats")!;
  el.innerHTML = `
    <div class="card">
      <div class="label">Recent attempts</div>
      <div class="value tabular">${entries.length}</div>
      <div class="sub">last ${entries.length ? fmtTime(entries[0]!.at) : "n/a"}</div>
    </div>
    <div class="card">
      <div class="label">Accepted</div>
      <div class="value tabular">${ok}</div>
      <div class="sub">HTTP 2xx</div>
    </div>
    <div class="card">
      <div class="label">Rejected</div>
      <div class="value tabular">${rejected}</div>
      <div class="sub">HTTP 4xx/5xx</div>
    </div>
    <div class="card">
      <div class="label">Rooms seen</div>
      <div class="value tabular">${rooms}</div>
      <div class="sub">in memory only</div>
    </div>
  `;
}

function renderTraffic(entries: TrafficEntry[]): void {
  const el = document.getElementById("traffic")!;
  if (entries.length === 0) {
    el.innerHTML = `
      <div class="empty">
        No ingest traffic seen since this server process started.
        <br />
        Try POSTing to <code>/api/ingest/&lt;roomId&gt;/&lt;monitorId&gt;</code>.
      </div>`;
    return;
  }

  el.innerHTML = `
    <div class="debug-list">
      ${entries
        .map((e) => {
          const statusClass = e.ok ? "ok" : "bad";
          const norm = e.normalized;
          const auto = e.autoRegistered
            ? `auto: ${e.autoRegistered.newRoom ? "new room" : ""}${
                e.autoRegistered.newRoom && e.autoRegistered.newMonitor ? " + " : ""
              }${e.autoRegistered.newMonitor ? "new monitor" : "existing"}`
            : "";
          return `
            <div class="debug-row ${statusClass}">
              <div class="debug-row-head">
                <span class="badge ${statusClass}">${e.status}</span>
                <span class="tabular">${escapeHtml(fmtTime(e.at))}</span>
                <strong>${escapeHtml(e.method)} ${escapeHtml(e.path)}</strong>
                <span class="muted">${escapeHtml(e.message)}</span>
              </div>
              <div class="debug-row-grid">
                <div><span class="muted">room:</span> ${escapeHtml(e.roomId ?? "n/a")}</div>
                <div><span class="muted">monitor:</span> ${escapeHtml(e.monitorId ?? "n/a")}</div>
                <div><span class="muted">ip:</span> ${escapeHtml(e.remoteIp ?? norm?.ip ?? "n/a")}</div>
                <div><span class="muted">body:</span> ${
                  e.bodyParseOk == null ? "n/a" : e.bodyParseOk ? "json ok" : "not json"
                }</div>
                <div><span class="muted">power:</span> ${
                  norm ? `${fmtNumber(norm.powerW)} W` : "n/a"
                }</div>
                <div><span class="muted">energy:</span> ${
                  norm ? `${fmtNumber(norm.totalEnergyWh)} Wh` : "n/a"
                }</div>
                <div><span class="muted">device ts:</span> ${
                  norm ? escapeHtml(norm.ts) : "n/a"
                }</div>
                <div><span class="muted">content:</span> ${escapeHtml(e.contentType ?? "n/a")}</div>
              </div>
              ${
                auto || e.userAgent || (e.query && Object.keys(e.query).length)
                  ? `<div class="debug-meta">
                      ${auto ? `<span>${escapeHtml(auto)}</span>` : ""}
                      ${
                        e.userAgent
                          ? `<span><span class="muted">ua:</span> ${escapeHtml(e.userAgent)}</span>`
                          : ""
                      }
                      ${
                        e.query && Object.keys(e.query).length
                          ? `<span><span class="muted">query:</span> ${escapeHtml(
                              JSON.stringify(e.query),
                            )}</span>`
                          : ""
                      }
                    </div>`
                  : ""
              }
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

async function refresh(): Promise<void> {
  const data = await jget<DebugResp>("/api/debug/traffic");
  renderStats(data.traffic);
  renderTraffic(data.traffic);
}

document.getElementById("refreshBtn")!.addEventListener("click", () => {
  void refresh();
});

void refresh();
setInterval(() => {
  void refresh();
}, 2000);
