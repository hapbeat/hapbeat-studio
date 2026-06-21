# Hapbeat Studio — context for AI coding agents

Single self-contained reference for **operating** Hapbeat Studio, the web-based
GUI design tool for Hapbeat haptic devices. This is a browser app, **not** a
library — there is no importable API. This file documents how to drive the tool.

- last-verified-against: 0.2.1 (`package.json`)
- Source of truth is the code: tabs in `src/App.tsx`, the Helper WebSocket
  bridge in `src/hooks/useHelperConnection.tsx`, the WS message surface in
  `src/types/manager.ts`, version compat in `src/config/helperCompat.ts`. If
  this file disagrees with the code, the code wins.
- Canonical docs: https://devtools.hapbeat.com/docs/tools/studio/

## What it is

A browser-based all-in-one tool to author haptic **Kits**, edit device **UI**
(OLED layout / LED / button / volume), and **Manage** devices (Wi-Fi, firmware
OTA, initial setup). Everything runs in the browser; there is no backend. It
does **not** play haptics from your application — that is the SDKs' job. Studio
authors content and configures hardware; the event id + wire format are defined
by **hapbeat-contracts** (do not redefine them here).

## How to start / connect

- **Use it:** open https://devtools.hapbeat.com (production). No install.
- **Run locally (dev):** `npm install` then `npm run dev` → http://localhost:5173
  (build: `npm run build` → `dist/`; lint: `npm run lint`; test: `npm test`).
- **Editing / exporting works with no device.** Talking to a device (deploy
  Kit, write UI, OTA, live preview) needs the **hapbeat-helper** daemon — a
  local CLI that bridges what the browser cannot do (mDNS / UDP broadcast / TCP
  raw socket).
- USB-serial firmware flashing is done **directly** from Studio via the Web
  Serial API (Manage → Firmware), without Helper.

### hapbeat-helper (prerequisite for device ops)

```bash
pipx install hapbeat-helper        # once
hapbeat-helper install-service     # auto-start (recommended)
hapbeat-helper start               # or start manually
hapbeat-helper stop
hapbeat-helper uninstall-service
pipx upgrade hapbeat-helper
```

Studio connects to it at `ws://localhost:7703`. The header pill shows
`Helper 接続中` (connected) / `Helper 未接続` (disconnected) / `Helper 要更新`
(outdated — below `MIN_HELPER_VERSION` = `0.1.3`, see `helperCompat.ts`).
Helper itself reaches the device over **UDP 7700** (commands) and **TCP 7701**
(config) — those belong to contracts / helper, not Studio.

### Browser notes

- Chrome / Edge: allow the HTTPS Studio page to connect to `ws://localhost:7703`.
- Firefox: set `network.websocket.allowInsecureFromHTTPS = true` in `about:config`.
- Web Serial flashing requires a Chromium-based browser (Web Serial API).

## The three tabs (`src/App.tsx`)

| Tab (label) | Purpose |
|---|---|
| **Kit** / Vibration Clips | Load WAVs, define Events, build a Kit, save to a folder, deploy to devices |
| **UI** / Display etc. | OLED (128×64 px, default 16 cols × 2 rows grid) block layout, pages, button actions, LED colours, brightness, Hold timing |
| **Manage** / Config | Device discovery, Wi-Fi, firmware OTA, initial-setup wizard, streaming/event test |

## Key operational flows

- **First-time device bring-up:** Manage → Onboarding wizard = USB Serial
  connect → flash firmware → set Wi-Fi.
- **Author + ship a Kit:** Kit tab → import WAVs → set Event id + mode
  (FIRE = command / CLIP = stream / BOTH) + intensity → **Save Folder** (writes
  the Kit folder to disk with `install-clips/` + `stream-clips/`) →
  **Deploy** (flashes command clips to selected devices via Helper).
- **Edit device UI:** UI tab → arrange OLED elements / LED / buttons → write to
  device (Helper).
- **Test:** Manage → preview an Event (PLAY / STOP) on a connected device.

## WebSocket command surface (Studio → Helper)

Studio sends `{ type, payload }` JSON over `ws://localhost:7703`. The protocol
is **owned by hapbeat-helper**; Studio is a client. Verbatim `type` values
(`src/types/manager.ts` `StudioToManagerMessage`):

```
list_devices, write_ui_config, deploy_kit, deploy_kit_data, preview_event,
stop_event, stream_begin, stream_data, stream_end, query_space, query_volume,
set_name, set_address, set_wifi, clear_wifi, reboot, get_info, get_wifi_status,
list_wifi_profiles, connect_wifi_profile, remove_wifi_profile, get_debug_dump,
kit_list, kit_delete, play_event, ping_device, subscribe_logs, unsubscribe_logs,
ota_data, scan_wifi, enter_ap_mode, enter_sta_mode, set_ap_pass, clear_ap_pass,
get_ap_status, set_oled_brightness, get_oled_brightness, ping, rescan,
set_broker_host, set_espnow_channel, set_gain, set_input_level, set_broker_config,
set_sensor_mapping, get_sensor_mapping, get_sensor_reading, set_alert_mode,
set_recv_topics
```

Helper → Studio reply `type` values (`ManagerToStudioMessage`):

```
helper_hello, device_list, write_result, write_progress, deploy_result,
stream_ack, space_result, volume_result, volume_changed, get_info_result,
wifi_status_result, wifi_profiles_result, debug_dump_result, kit_list_result,
ping_result, log_subscription, device_log, ota_progress, ota_result,
scan_wifi_result, ap_status_result, oled_brightness_result, sensor_mapping_result,
sensor_reading_result, error, pong
```

For the full payload shapes of a node, see `get_info_result` (`GetInfoResult` in
`src/types/manager.ts`) and the contracts spec. Do not invent payload fields.

## Where config / data lives

- **UI state:** `localStorage` (e.g. active tab key `hapbeat-studio-tab`).
- **Kit folders / WAVs:** written to a user-picked directory via the File System
  Access API (`<kit>/install-clips/`, `<kit>/stream-clips/`, `<kit>-manifest.json`).
  Disk is the source of truth → recovered by re-picking the folder after a host move.
- **MQTT topic registry:** `localStorage` (`hapbeat-studio-mqtt-topics`,
  `src/stores/mqttTopicsStore.ts`). Per-origin, so the sensor-config UI offers
  JSON export/import to carry the list across an origin change.
- The running Studio version comes from `VITE_APP_VERSION`; the header dropdown
  switches to frozen `<deploy-root>vX.Y/` builds listed in `<deploy-root>versions.json`
  (`src/components/common/VersionSwitcher.tsx`). Deploy root = `/` on
  studio.hapbeat.com (Cloudflare) and `/studio/` on the legacy devtools host;
  it is derived from `import.meta.env.BASE_URL` at runtime.

## Common errors and fixes

- **`Helper 未接続`** — Helper not running / not reachable. Run
  `hapbeat-helper start`; in Firefox enable the `about:config` flag above.
- **`Helper 要更新`** — connected Helper < `0.1.3`. Some Kit deploy / device
  ops may fail. Run `pipx upgrade hapbeat-helper` (Manage modal has copy-paste
  commands).
- **No devices listed** — Helper can't see them: check the device is on the same
  LAN, then use Manage → refresh / `rescan`. Multi-homed PCs may broadcast out
  the wrong NIC.
- **Board mismatch on deploy/OTA** — the firmware variant must match the
  device `board` (reported in `get_info_result`); Studio warns on mismatch.
- **USB flash fails** — use a Chromium browser; install the USB-serial driver
  (Manage → Firmware shows driver help links).

## More detail

When this single file is not enough, an agent can fetch:

- **Complete reference in one text file (recommended next step):** https://devtools.hapbeat.com/_llms-txt/studio.txt
- **Concepts** (shared by every SDK): event id <-> kit https://devtools.hapbeat.com/docs/concepts/event-id-and-kit/ - command vs clip https://devtools.hapbeat.com/docs/concepts/fire-vs-clip/ - targeting https://devtools.hapbeat.com/docs/concepts/group-player-addressing/
- Human docs: https://devtools.hapbeat.com/docs/tools/studio/ - Portal: https://devtools.hapbeat.com/
