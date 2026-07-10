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
//   * CONFIG.MONITOR_ID — which feed within the room this device is on, e.g.
//                         "south", "north", "in-bathroom". Must match a key
//                         under the room's `monitors` in data/rooms.json.
//                         Use "default" for single-monitor rooms.
//   * CONFIG.BASE_URL   — your dashboard's public URL, no trailing slash
//   * CONFIG.INTERVAL_S — how often to POST (seconds)
//   * CONFIG.SSL_CA     — set to "*" only if your server uses a self-signed cert
//
// Output (`print(...)`) appears in the device's Script "Console" tab.

let CONFIG = {
  ROOM_ID: "301",
  MONITOR_ID: "default",
  BASE_URL: "http://34.69.79.104:3000",
  INTERVAL_S: 60,
  SSL_CA: null,
};

function pathSegment(s) {
  return encodeURIComponent(String(s));
}

function isEmKey(k) {
  return (
    k.indexOf("em1:") === 0 ||
    k.indexOf("em1data:") === 0 ||
    k.indexOf("em:") === 0 ||
    k.indexOf("emdata:") === 0
  );
}

function hasEmKeys(obj) {
  for (let k in obj) {
    if (isEmKey(k)) return true;
  }
  return false;
}

function pickEmFields(status) {
  let out = {};
  if (status && status.sys && typeof status.sys.unixtime === "number") {
    out.ts = status.sys.unixtime;
  }
  // Forward the wifi block too — the server pulls `wifi.sta_ip` out of it
  // and stores it on the monitor entry in rooms.json so the dashboard can
  // render a click-through link to this device's admin UI.
  if (status && status.wifi && typeof status.wifi.sta_ip === "string") {
    out.wifi = { sta_ip: status.wifi.sta_ip };
  }
  // Forward every channel-shaped key. Server collapses them into a single
  // (power, energy) tuple per monitor, so multi-channel devices end up
  // summed; for an EM Mini Gen4 this is just em1:0 + em1data:0.
  for (let k in status) {
    if (isEmKey(k)) out[k] = status[k];
  }
  return out;
}

function postPayload(params) {
  let body = JSON.stringify({
    method: "NotifyStatus",
    params: params,
  });
  let req = {
    url:
      CONFIG.BASE_URL +
      "/api/ingest/" +
      pathSegment(CONFIG.ROOM_ID) +
      "/" +
      pathSegment(CONFIG.MONITOR_ID),
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
}

function postFallbackEmStatus(baseParams) {
  // Some Gen4 firmwares don't include component entries in Shelly.GetStatus
  // from scripts, even though the component RPCs work. Query those directly.
  Shelly.call("EM1.GetStatus", { id: 0 }, function (em1, em1Code, em1Msg) {
    if (em1Code === 0 && em1) {
      baseParams["em1:0"] = em1;
    } else {
      print("fallback EM1.GetStatus failed:", em1Msg);
    }

    Shelly.call("EMData.GetStatus", { id: 0 }, function (emd, emdCode, emdMsg) {
      if (emdCode === 0 && emd) {
        baseParams["emdata:0"] = emd;
      } else {
        print("fallback EMData.GetStatus failed:", emdMsg);
      }

      if (!hasEmKeys(baseParams)) {
        print("no EM fields found after fallback; posting diagnostic payload");
      }
      postPayload(baseParams);
    });
  });
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
    let params = pickEmFields(status);
    if (hasEmKeys(params)) {
      postPayload(params);
    } else {
      print("Shelly.GetStatus had no EM keys; trying component RPC fallback");
      postFallbackEmStatus(params);
    }
  });
}

Timer.set(CONFIG.INTERVAL_S * 1000, true, postReport);
print(
  "5214 reporter running:",
  CONFIG.ROOM_ID + "/" + CONFIG.MONITOR_ID,
  "->",
  CONFIG.BASE_URL,
);
probeKeysOnce();
postReport();
