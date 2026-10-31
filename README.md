# NPG-Lite Band — Web BLE Viewer

A Next.js 14 (App Router) + TypeScript + Tailwind app that connects over Web
Bluetooth to the **NPG-Lite Band** ESP32-C3/C6 firmware, live-plots the
BioAmp channels, plots the onboard LIS3DH accelerometer, and records both to
CSV (via IndexedDB, exportable as a ZIP).

## Multi-device support (merged single view)

The app connects to **multiple NPG-Lite bands at once** (3, 4 or more) and
shows them in **one unified screen** — not one app/panel per device.

- **One `NPG_Ble` component** owns everything: the device registry, the merged
  plot, filters, recording and the accelerometer. Per-device runtime (its GATT
  characteristics, biquad filters, sample counter, recording buffer) lives in a
  `devicesRef` array so the ~500 Hz notifications never trigger React renders.
- **Add device** opens the browser pairing dialog. Web Bluetooth only lets you
  pick one device per `requestDevice()`, so click it once per band. Each picked
  device connects immediately and appears as a **chip in the top bar** (color
  dot, name, its channel range, live battery, and a ✕ to remove).

### Continuous channel numbering in one plot

All BioAmp channels share a single **global 0-based numbering** that runs across
devices:

```
device 1 (3CH) -> CH1, CH2, CH3
device 2 (3CH) -> CH4, CH5, CH6
device 3 (3CH) -> CH7, CH8, CH9
```

(6CH bands take six slots each.) Every selected global channel is one row in the
shared WebGL plot, labelled `D<n> · Ch<global>` and tinted by device. Each
device's samples are filtered with its own biquads and routed to its own
channels via a `globalChannel → line` map, so devices streaming at slightly
different phases don't interfere. The **Channel Settings** (gear) popover lets you toggle
individual channels or whole devices; by default every channel of every device
is shown.

### Accelerometer device selector

There is a single accelerometer panel with a **dropdown to choose which device's
IMU** to display. All connected devices still stream their IMU, but only the
selected one is plotted (switching resets the sweep).

### Layout / no scrollbar

The whole UI is a `100dvh`, `overflow-hidden` flex column: the top bar and
controls are fixed height, the EMG plot takes the remaining space
(`flex-1 min-h-0`) and its channels split that height evenly, and the accel
panel is a small `12vh` strip. Because heights are viewport-relative and flex,
the page reflows to fit at higher browser zoom (e.g. 175%) instead of showing a
scrollbar. Device chips wrap rather than scroll.

### Recording with several devices

Cross-device samples aren't row-aligned, so each device records to **its own
CSV**: `<device>-D<n>-ChordsWeb-<timestamp>.csv`, containing
`Counter, Channel1 … ChannelN` for that device's channels. All files share one
IndexedDB store; the recordings popover lists them with per-file download /
delete, plus **ZIP** / **delete all** for the whole store. (`convertToCSV` in
the worker now derives columns from each file's own rows, so mixed 3CH/6CH files
export correctly.)

### Things to verify on real hardware

Validated with `tsc --noEmit` and `next build`, but not against physical bands.
Worth checking live with 3–4 devices:

- Chrome allows several simultaneous GATT connections, but throughput/latency
  can degrade past ~4 links depending on the host adapter — watch the
  per-device "missing sample" console logs.
- Confirm no scrollbar at your target zoom on your actual screen size; if a very
  large number of devices makes the top bar tall, the plot area shrinks (no page
  scroll) as intended.
- Accelerometer recording is **display-only** here (the uploaded worker never
  had a `writeAccel` handler), so only EMG channels are written to CSV.

## What was adapted from the original UI

The original component was built for a slightly different firmware/packet
layout. To match *this* firmware exactly:

| Setting | Firmware | This app |
|---|---|---|
| `BLOCK_COUNT` (samples/notification) | `20` | `20` (was `10`) |
| EMG sample layout | `1 counter + 2 bytes × N channels`, big-endian | same, `DataView.getInt16(..., false)` |
| Device name → channel count | `NPG-Lite-Band-3CH:MAC` / `-6CH-` | matched via `.includes("3CH")` / `.includes("6CH")` |
| BLE UUIDs | Service `4fafc201-…`, Data `beb5483e-…`, Control `0000ff01-…`, Battery `f633d0ec-…`, **IMU `5a153fa9-…`** | identical |
| Accelerometer | New `IMU_CHAR_UUID` characteristic, variable-length notifications of 7‑byte records (`1 counter + int16 X + int16 Y + int16 Z`, big-endian) | new `handleIMUNotification` → `processIMUBatch`, plotted in a dedicated panel and recorded to `<name>-accel.csv` |
| Control commands | `START` / `STOP` / `WHORU` / `STATUS` | unchanged |
| Battery | single byte, 0–100% | unchanged |

Because the EMG stream (500 Hz) and the IMU FIFO bursts (~100 Hz, arriving in
bursts of up to 32 samples) are not sample-aligned, they're recorded as two
separate CSV files per session (`<name>.csv` and `<name>-accel.csv`) rather
than forced into one row-synchronized table.

## Requirements

- Node.js 18+
- A Chromium-based browser with Web Bluetooth support (Chrome, Edge) — Web
  Bluetooth is not available in Safari or Firefox.
- The NPG-Lite Band powered on and advertising (name prefix `NPG`).

## Setup

```bash
npm install
npm run dev
```

Then open `http://localhost:3000` in Chrome/Edge, click **Connect**, and
choose your `NPG-Lite-Band-3CH:XX:XX` (or `-6CH-`) device from the browser's
pairing dialog.

## Project layout

```
app/                  Next.js App Router entry (layout, page, globals.css)
components/
  NPG_Ble.tsx          Main BLE + plotting + recording component
  Navbar.tsx           Top bar with theme toggle
  Colors.ts            Per-channel + accelerometer color palettes
  filters.ts           Notch / high-pass / EXG bandpass biquad filters
  ThemeProvider.tsx     next-themes wrapper
  ui/                  Minimal button/input/popover/tooltip/separator primitives
workers/
  indexedDBWorker.ts    Buffers recorded samples in IndexedDB, exports CSV/ZIP
```

## Notes

- Filter coefficients in `filters.ts` are computed at runtime from the
  device's sampling rate (RBJ cookbook biquads) rather than hardcoded lookup
  tables, so they stay correct if `SAMP_RATE` changes in firmware.
- If a connected device doesn't expose the IMU characteristic (e.g. older
  firmware), the app simply skips the accelerometer panel and logs a message
  to the console — everything else keeps working.
