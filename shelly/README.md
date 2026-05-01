# Shelly device setup

Two ways to get a Shelly EM into the dashboard. Use whichever your firmware
supports — the server accepts both.

## One device, one monitor

Each physical Shelly = one **monitor** in the dashboard. A room can have
many monitors (e.g. one CT clamp on the south sub-panel, another on the
in-bathroom feed). Each one's id is a path segment in the ingest URL, so
the server can keep their cumulative counters separate.

You don't need to declare anything up front. The server treats the Shelly
POSTs as the source of truth: the first POST from a new `(ROOM_ID,
MONITOR_ID)` pair auto-creates a stub entry in `data/rooms.json` with
sensible defaults (`label: "Room <id>"` for the room, `label: <id>` for
the monitor, empty lease history). The server logs the registration:

```
auto-registered room+monitor 301/south
```

After that, edit `data/rooms.json` to add a friendlier label or to start
tracking a tenant's lease — your edits stick because subsequent ingests
only fill in *missing* fields, never overwrite. Example after curation:

```json
"301": {
  "label": "Room 301",
  "monitors": {
    "south":    { "label": "South wall mains" },
    "bathroom": { "label": "In-bathroom feed" }
  },
  "leases": [
    { "id": "lease-301-1", "tenant": "Alice", "startDate": "2026-05-01", "endDate": null }
  ]
}
```

> ⚠ **Typo trade-off**: with auto-registration, `MONITOR_ID = "soutH"`
> won't 404 — it'll silently create a third monitor. Watch the server log
> for `auto-registered …` lines after deploying a new device, or `grep
> auto-registered` your logs occasionally. To remove a typo, delete the
> bogus entry from `rooms.json`; its historical (typo'd) readings stay in
> `readings.jsonl` but stop appearing in the UI.

## Provisioning (do this first, on every device)

1. Install one **Shelly EM Mini Gen4** per feed, with its CT clamp around
   the live conductor of the circuit it's metering.
2. Power up, join it to your Wi-Fi via the Shelly app or web UI.
3. **Set the CT type.** Open the device web UI → **Settings → Energy
   Metering → CT Type** (or run `EM1.SetConfig` with `ct_type` set). The EM
   Mini Gen4 ships uncalibrated and refuses to report until this is set; if
   you skip it, you'll see a `ct_type_not_set` error in `EM1.GetStatus` and
   the script's probe will print zero-valued readings.
4. Once the CT type is set, you should see live wattage on the device's
   front page.

## Recommended: Shelly Script (Gen2 / Gen3 / Gen4 firmware)

Works on every Shelly device with a **Scripts** tab — Plus, Pro, Mini Gen3,
and Gen4. The scripting engine (Espruino) and the relevant API surface
(`Shelly.GetStatus`, `HTTP.POST`, `Timer.set`) are shared across all three
generations, so the same `report.js` runs unmodified on a Gen4 unit.

After **Run**, the script's Console will print:

```
5214 reporter running: 301/south -> https://5214.example.com
probe: forwarding keys -> em1:0, em1data:0
POST 200 ok
```

That's the expected output for an **EM Mini Gen4** (single channel, indexed
0). Other Shelly EM-class devices show different keys — all already handled
by `pickEmFields`:

| Device                        | Probe output                                           |
|------------------------------ |--------------------------------------------------------|
| EM Mini Gen3/Gen4             | `em1:0, em1data:0`                                     |
| Pro EM (2 channel)            | `em1:0, em1data:0, em1:1, em1data:1`                   |
| Pro EM4 / 4-channel devices   | `em1:0..3, em1data:0..3`                               |
| Pro 3EM (3-phase aggregator)  | `em:0, emdata:0`                                       |

For multi-channel devices, the server **sums** all channels into a single
power/energy tuple per monitor. If you want per-channel attribution, run
the script multiple times with different `MONITOR_ID`s (one per channel)
— each instance will still forward all keys, so this currently isn't
quite seamless. Talk to me if you actually need this; for now we assume
one Shelly = one feed.

If you see `probe: no em*/em1* keys`, your device exposes its meter under a
different namespace (e.g. `pm1:N` on Plus 1PM) — let me know the model and
I'll extend the picker.

1. In the device web UI, open **Scripts**.
2. Click **+ Create script** (or **Library**), name it `5214-reporter`.
3. Paste the contents of [`report.js`](./report.js).
4. Edit the constants at the top:
   - `ROOM_ID` — pick a short id for the room. The server will auto-register it on the first POST. (e.g. `"301"`, `"b4"`.)
   - `MONITOR_ID` — pick a descriptive id for which feed within the room this device meters. (e.g. `"south"`, `"bathroom"`, or `"default"` if there's only one Shelly per room.) Also auto-registered on first POST.
   - `BASE_URL` — your dashboard's public URL, no trailing slash.
   - `INTERVAL_S` — how often to POST (60s is fine; faster gives smoother charts).
   - `SSL_CA` — leave `null` unless your server uses a self-signed TLS cert, then `"*"`.
5. **Save**, then **Run** (▶), then toggle **Start on boot** so it survives reboots.
6. Open the **Console** tab on the script — you should see lines like `POST 200 ok` every minute.
7. Refresh your dashboard at `/<ROOM_ID>` — the "Right now" card should turn green.

### Tips

- **Multiple devices, same room?** Run the script on each, with a distinct
  `MONITOR_ID` per device. The room dashboard shows a per-monitor breakdown
  automatically once more than one is reporting.
- **Same device moved to a different feed?** Don't reuse the old
  `MONITOR_ID` unless it's still on the same circuit — the cumulative
  counter delta would mis-attribute. Use a new `MONITOR_ID` and remove the
  old one from `data/rooms.json` (its historical data stays in
  `readings.jsonl` correctly attributed).
- **Network blip?** Lost POSTs are fine. The Shelly counter is cumulative, so
  the next successful POST captures the missed energy as a single delta. No
  data is lost.

## Fallback: Action URL (legacy firmware)

If your device only has **Settings → Actions** (no Scripts tab), use the
legacy GET-style endpoint. One action per channel:

- **Trigger**: `Active power changed` (or `Energy report`)
- **Method**: `GET`
- **URL**:
  ```
  https://5214.example.com/api/ingest/301/south?total_act_energy={total}&act_power={power}
  ```

The server falls back to parsing those querystring keys when no JSON body is
present.

## Troubleshooting

- **Script says `POST 400 "invalid roomId"` or `"invalid monitorId"`** —
  the id contains characters outside `[A-Za-z0-9_-]` or is longer than 16
  chars. Pick a shorter/simpler id.
- **Script says `POST failed: SSL ...`** — set `SSL_CA: "*"` to skip cert
  validation, or fix the cert.
- **Wrong room/monitor showing up in dashboard** — auto-registration
  doesn't validate against an allowlist, so a typo in `MONITOR_ID`
  silently creates a phantom feed. Check the server log for the
  `auto-registered` line, then delete the bogus entry from
  `data/rooms.json` to hide it. (Its typo'd readings stay in
  `readings.jsonl` correctly attributed.)
- **No data showing on dashboard** — check the device console for `POST 200`.
  Then `tail -n 1 data/readings.jsonl | jq` on the server to confirm the
  payload landed and was parsed (look for non-zero `totalEnergyWh` and the
  expected `monitor` field).
- **Aggregator shows 0 kWh** — the lease window is computed against the
  `startDate` in `data/rooms.json`. If the lease starts in the future, no
  readings count. Set it to a date on or before today.
