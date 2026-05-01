# Shelly device setup

Two ways to get a Shelly EM into the dashboard. Use whichever your firmware
supports — the server accepts both.

## Provisioning (do this first, on every device)

1. Install one **Shelly EM Mini Gen4** per room, with its CT clamp around the
   live conductor feeding that room's circuit. (One device = one channel =
   one room — the EM Mini is single-phase / single-channel by design.)
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
5214 reporter running: 301 -> https://5214.example.com
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

If you see `probe: no em*/em1* keys`, your device exposes its meter under a
different namespace (e.g. `pm1:N` on Plus 1PM) — let me know the model and
I'll extend the picker.

1. In the device web UI, open **Scripts**.
2. Click **+ Create script** (or **Library**), name it `5214-reporter`.
3. Paste the contents of [`report.js`](./report.js).
4. Edit the four constants at the top:
   - `ROOM_ID` — must match a key in `data/rooms.json` on the server (e.g. `"301"`, `"b4"`).
   - `BASE_URL` — your dashboard's public URL, no trailing slash.
   - `INTERVAL_S` — how often to POST (60s is fine; faster gives smoother charts).
   - `SSL_CA` — leave `null` unless your server uses a self-signed TLS cert, then `"*"`.
5. **Save**, then **Run** (▶), then toggle **Start on boot** so it survives reboots.
6. Open the **Console** tab on the script — you should see lines like `POST 200 ok` every minute.
7. Refresh your dashboard at `/<ROOM_ID>` — the "Right now" card should turn green.

### Tips

- **Multiple devices, same room?** Run the script on each, all targeting the
  same `ROOM_ID`. Their channel indices will collide, so use different rooms
  per device or remap `em1:N` keys before posting.
- **Multiple rooms, one device?** A 4-channel EM4 metering 4 rooms needs
  per-channel routing, which the server doesn't currently do — ask first.
- **Network blip?** Lost POSTs are fine. The Shelly counter is cumulative, so
  the next successful POST captures the missed energy as a single delta. No
  data is lost.

## Fallback: Action URL (legacy firmware)

If your device only has **Settings → Actions** (no Scripts tab), use the
legacy GET-style endpoint. One action per channel:

- **Trigger**: `Active power changed` (or `Energy report`)
- **Method**: `GET`
- **URL** (per channel `N`):
  ```
  https://5214.example.com/api/ingest/301?channel=N&total_act_energy={total}&act_power={power}
  ```

The server falls back to parsing those querystring keys when no JSON body is
present.

## Troubleshooting

- **Script says `POST 404`** — `ROOM_ID` isn't in `data/rooms.json`. Add it
  and reload (no server restart needed).
- **Script says `POST failed: SSL ...`** — set `SSL_CA: "*"` to skip cert
  validation, or fix the cert.
- **No data showing on dashboard** — check the device console for `POST 200`.
  Then `tail -n 1 data/readings.jsonl | jq` on the server to confirm the
  payload landed and was parsed (look for `channels` array with non-zero
  `totalEnergyWh`).
- **Aggregator shows 0 kWh** — the lease window is computed against the
  `startDate` in `data/rooms.json`. If the lease starts in the future, no
  readings count. Set it to a date on or before today.
