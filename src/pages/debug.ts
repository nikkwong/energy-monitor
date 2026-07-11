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

let allEntries: TrafficEntry[] = [];
let selectedRoom = "";

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
  const stats = [
    {
      label: "Recent attempts",
      value: String(entries.length),
      sub: `last ${entries.length ? fmtTime(entries[0]!.at) : "n/a"}`,
    },
    { label: "Accepted", value: String(ok), sub: "HTTP 2xx" },
    { label: "Rejected", value: String(rejected), sub: "HTTP 4xx/5xx" },
    { label: "Rooms seen", value: String(rooms), sub: "in memory only" },
  ];

  if (el.children.length !== stats.length) {
    el.replaceChildren(
      ...stats.map(() => {
        const card = document.createElement("div");
        card.className = "card";
        card.innerHTML = `
          <div class="label"></div>
          <div class="value tabular"></div>
          <div class="sub"></div>
        `;
        return card;
      }),
    );
  }

  stats.forEach((s, i) => {
    const card = el.children[i] as HTMLElement;
    card.querySelector(".label")!.textContent = s.label;
    card.querySelector(".value")!.textContent = s.value;
    card.querySelector(".sub")!.textContent = s.sub;
  });
}

function roomKey(e: TrafficEntry): string {
  return e.roomId ?? "";
}

function filteredEntries(): TrafficEntry[] {
  if (!selectedRoom) return allEntries;
  return allEntries.filter((e) => roomKey(e) === selectedRoom);
}

function updateRoomFilter(entries: TrafficEntry[]): void {
  const select = document.getElementById("roomFilter") as HTMLSelectElement;
  const rooms = [...new Set(entries.map(roomKey).filter(Boolean))].sort();
  const currentOptions = [...select.options].slice(1).map((o) => o.value);
  if (rooms.join("\0") === currentOptions.join("\0")) return;

  select.replaceChildren(new Option("All rooms", ""));
  for (const room of rooms) {
    select.append(new Option(room, room));
  }
  if (selectedRoom && rooms.includes(selectedRoom)) {
    select.value = selectedRoom;
  } else {
    selectedRoom = "";
    select.value = "";
  }
}

function trafficRowHtml(e: TrafficEntry): string {
  const statusClass = e.ok ? "ok" : "bad";
  const norm = e.normalized;
  const auto = e.autoRegistered
    ? `auto: ${e.autoRegistered.newRoom ? "new room" : ""}${
        e.autoRegistered.newRoom && e.autoRegistered.newMonitor ? " + " : ""
      }${e.autoRegistered.newMonitor ? "new monitor" : "existing"}`
    : "";
  return `
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
      <div><span class="muted">power:</span> ${norm ? `${fmtNumber(norm.powerW)} W` : "n/a"}</div>
      <div><span class="muted">energy:</span> ${
        norm ? `${fmtNumber(norm.totalEnergyWh)} Wh` : "n/a"
      }</div>
      <div><span class="muted">device ts:</span> ${norm ? escapeHtml(norm.ts) : "n/a"}</div>
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
                ? `<span><span class="muted">query:</span> ${escapeHtml(JSON.stringify(e.query))}</span>`
                : ""
            }
          </div>`
        : ""
    }
  `;
}

function createTrafficRow(e: TrafficEntry): HTMLElement {
  const row = document.createElement("div");
  row.dataset.trafficId = String(e.id);
  updateTrafficRow(row, e);
  return row;
}

function updateTrafficRow(row: Element, e: TrafficEntry): void {
  const statusClass = e.ok ? "ok" : "bad";
  row.className = `debug-row ${statusClass}`;
  row.innerHTML = trafficRowHtml(e);
}

function renderTraffic(entries: TrafficEntry[]): void {
  const el = document.getElementById("traffic")!;
  if (entries.length === 0) {
    const emptyKey = selectedRoom || "__all__";
    if (
      el.firstElementChild?.classList.contains("empty") &&
      (el.firstElementChild as HTMLElement).dataset.emptyKey === emptyKey
    ) {
      return;
    }
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.dataset.emptyKey = emptyKey;
    empty.innerHTML = selectedRoom
      ? `No ingest traffic for room <code>${escapeHtml(selectedRoom)}</code>.`
      : `No ingest traffic seen since this server process started.
        <br />
        Try POSTing to <code>/api/ingest/&lt;roomId&gt;/&lt;monitorId&gt;</code>.`;
    el.replaceChildren(empty);
    return;
  }

  let list = el.querySelector<HTMLElement>(".debug-list");
  if (!list) {
    list = document.createElement("div");
    list.className = "debug-list";
    el.replaceChildren(list);
  }

  const existing = new Map<string, Element>();
  list.querySelectorAll("[data-traffic-id]").forEach((node) => {
    existing.set((node as HTMLElement).dataset.trafficId!, node);
  });

  const wanted = new Set(entries.map((e) => String(e.id)));
  for (const [id, node] of existing) {
    if (!wanted.has(id)) node.remove();
  }

  for (const entry of entries) {
    const id = String(entry.id);
    let row = existing.get(id);
    if (!row) {
      row = createTrafficRow(entry);
    }
    list.append(row);
  }
}

async function refresh(): Promise<void> {
  const data = await jget<DebugResp>("/api/debug/traffic");
  allEntries = data.traffic;
  updateRoomFilter(allEntries);
  const visible = filteredEntries();
  renderStats(visible);
  renderTraffic(visible);
}

document.getElementById("refreshBtn")!.addEventListener("click", () => {
  void refresh();
});
document.getElementById("roomFilter")!.addEventListener("change", (event) => {
  selectedRoom = (event.target as HTMLSelectElement).value;
  const visible = filteredEntries();
  renderStats(visible);
  renderTraffic(visible);
});

void refresh();
setInterval(() => {
  void refresh();
}, 2000);
