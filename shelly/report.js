// 5214 dashboard reporter — paste into Shelly's Scripts UI.
//
// Compatibility: Shelly Gen2 / Gen3 / Gen4. The scripting engine (Espruino)
// is shared across all three generations, and the calls used here
// (Shelly.GetStatus, HTTP.POST, Timer.set) are part of that shared API.
//
// Where to put it:
//   Device web UI -> Scripts -> Library/Create -> "+" -> paste -> Save -> Run
//   Then click "Start on boot" so it survives reboots.
//
// What to edit:
//   * CONFIG.ROOM_ID    — the room this device meters (must match data/rooms.json)
//   * CONFIG.BASE_URL   — your dashboard's public URL, no trailing slash
//   * CONFIG.INTERVAL_S — how often to POST (seconds)
//   * CONFIG.SSL_CA     — set to "*" only if your server uses a self-signed cert
//
// Output (`print(...)`) appears in the device's Script "Console" tab.

let CONFIG = {
  ROOM_ID: "301",
  BASE_URL: "https://5214.example.com",
  INTERVAL_S: 60,
  SSL_CA: null,
};

function isEmKey(k) {
  return (
    k.indexOf("em1:") === 0 ||
    k.indexOf("em1data:") === 0 ||
    k.indexOf("em:") === 0 ||
    k.indexOf("emdata:") === 0
  );
}

function pickEmFields(status) {
  let out = {};
  if (status && status.sys && typeof status.sys.unixtime === "number") {
    out.ts = status.sys.unixtime;
  }
  // Forward every channel-shaped key. Covers EM1 (single-phase, per-channel),
  // EM (3-phase aggregates), and their *data variants for cumulative energy.
  for (let k in status) {
    if (isEmKey(k)) out[k] = status[k];
  }
  return out;
}

// Run once at boot: enumerate em-shaped keys the device exposes, so it's
// easy to spot if a model uses an unexpected naming. Prints to the script
// Console only — does not POST.
function probeKeysOnce() {
  Shelly.call("Shelly.GetStatus", {}, function (status, ec, em) {
    if (ec !== 0) {
      print("probe: GetStatus failed:", em);
      return;
    }
    let found = [];
    for (let k in status) {
      if (isEmKey(k)) found.push(k);
    }
    if (found.length === 0) {
      print(
        "probe: no em*/em1* keys on this device. Forwarding will be empty.",
      );
    } else {
      print("probe: forwarding keys ->", found.join(", "));
    }
  });
}

function postReport() {
  Shelly.call("Shelly.GetStatus", {}, function (status, errCode, errMsg) {
    if (errCode !== 0) {
      print("GetStatus failed:", errMsg);
      return;
    }
    let body = JSON.stringify({
      method: "NotifyStatus",
      params: pickEmFields(status),
    });
    let req = {
      url: CONFIG.BASE_URL + "/api/ingest/" + CONFIG.ROOM_ID,
      body: body,
      content_type: "application/json",
      timeout: 10,
    };
    if (CONFIG.SSL_CA) req.ssl_ca = CONFIG.SSL_CA;

    Shelly.call("HTTP.POST", req, function (res, ec, em) {
      if (ec !== 0) {
        print("POST failed:", em);
        return;
      }
      // res.code is the HTTP status. Anything non-2xx is a server-side issue;
      // the cumulative-counter design means the next POST recovers the gap.
      if (res && res.code >= 200 && res.code < 300) {
        print("POST", res.code, "ok");
      } else {
        print("POST returned", res && res.code, res && res.body);
      }
    });
  });
}

Timer.set(CONFIG.INTERVAL_S * 1000, true, postReport);
print("5214 reporter running:", CONFIG.ROOM_ID, "->", CONFIG.BASE_URL);
probeKeysOnce();
postReport();
