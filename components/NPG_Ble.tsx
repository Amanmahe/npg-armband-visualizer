'use client';
import React, {
    useEffect,
    useRef,
    useState,
    useCallback,
} from "react";
import { saveAs } from "file-saver";
import { WebglPlot, ColorRGBA, WebglLine } from "webgl-plot";
import { Button } from "@/components/ui/button";
import { EXGFilter, Notch, HighPassFilter } from "@/components/filters";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { toast } from "sonner";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import {
    Circle,
    CircleStop,
    CircleX,
    Trash2,
    Download,
    FileArchive,
    Pause,
    Play,
    Plus,
    Bluetooth,
    Loader2,
    Battery,
    BatteryLow,
    BatteryMedium,
    BatteryFull,
    BatteryWarning,
    Waves,
    Moon,
    Sun,
    Activity,
    SlidersHorizontal,
    ListChecks,
} from "lucide-react";
import { lightThemeColors, darkThemeColors, accelColors } from "@/components/Colors";
import { useTheme } from "next-themes";

/* ------------------------------------------------------------------ *
 *  NPG-Lite Band — merged multi-device Web BLE viewer.
 *
 *  Connect several NPG-Lite bands at once. Every device's BioAmp channels
 *  are laid out in ONE plot with a single continuous channel numbering:
 *  device 1 -> 0,1,2 ; device 2 -> 3,4,5 ; device 3 -> 6,7,8 ; and so on.
 *  Device info (name + battery) lives in the top bar, and the accelerometer
 *  panel has a selector to choose which device's IMU to view.
 * ------------------------------------------------------------------ */

interface DeviceConfig {
    maxChannels: number;
    sampleLength: number; // bytes/sample: 1 counter + 2 bytes/channel
    hasBattery: boolean;
}

// BLE UUIDs — must match firmware exactly.
const SERVICE_UUID = "4fafc201-1fb5-459e-8fcc-c5c9c331914b";
const DATA_CHAR_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a8";
const CONTROL_CHAR_UUID = "0000ff01-0000-1000-8000-00805f9b34fb";
const BATTERY_CHAR_UUID = "f633d0ec-46b4-43c1-a39f-1ca06d0602e1";
const IMU_CHAR_UUID = "5a153fa9-7be0-400c-8ef8-d84502b31c4d";

const BLOCK_COUNT = 20;             // EMG samples per BLE notification
const IMU_SAMPLE_SIZE = 7;          // 1 counter + int16 X/Y/Z
const ACCEL_POINT_COUNT_PER_SEC = 100;
const ACCEL_SENSITIVITY = 16384;
const ACCEL_DISPLAY_RANGE_G = 2;
const SAMPLE_RATE = 500;

const configFromName = (name: string): DeviceConfig => {
    if (name.includes("6CH")) return { maxChannels: 6, sampleLength: 13, hasBattery: true };
    if (name.includes("3CH")) return { maxChannels: 3, sampleLength: 7, hasBattery: true };
    return { maxChannels: 3, sampleLength: 7, hasBattery: false };
};

// Per-device runtime state, kept in a ref (not React state) because sample
// notifications arrive ~500 Hz and must not trigger re-renders.
interface DeviceRuntime {
    id: string;
    device: any;
    name: string;
    index: number; // position in the device list (D1, D2, …)
    config: DeviceConfig;
    offset: number; // global index of this device's channel 0
    controlChar?: any;
    dataChar?: any;
    batteryChar?: any;
    imuChar?: any;
    notch: Notch[];
    exg: EXGFilter[];
    hp: HighPassFilter[];
    prevCounter: number | null;
    samplesReceived: number;
    dataHandler?: (e: Event) => void;
    imuHandler?: (e: Event) => void;
    batteryHandler?: (e: Event) => void;
    recBuffer: number[][];
    recFileName: string;
    watchdog?: ReturnType<typeof setInterval> | null;
}

// Lightweight React-state mirror used only for rendering the navbar chips /
// selectors — updated whenever the device set or a battery level changes.
interface DeviceMeta {
    id: string;
    name: string;
    index: number;
    offset: number;
    maxChannels: number;
    hasBattery: boolean;
    connected: boolean;
    battery: number | null;
}

const deviceChipColors = ["#38bdf8", "#a78bfa", "#fb7185", "#4ade80", "#facc15", "#f472b6"];

interface CharValue extends EventTarget { value?: DataView; }

const NPG_Ble = () => {
    const { theme, setTheme } = useTheme();
    const activeTheme: "light" | "dark" = theme === "dark" ? "dark" : "light";

    // ----- device registry -----
    const devicesRef = useRef<DeviceRuntime[]>([]);
    const [deviceList, setDeviceList] = useState<DeviceMeta[]>([]);
    const [isAdding, setIsAdding] = useState(false);
    const totalChannelsRef = useRef<number>(0);

    // ----- plotting -----
    const canvasContainerRef = useRef<HTMLDivElement>(null);
    const [wglPlots, setWglPlots] = useState<WebglPlot[]>([]);
    const wglPlotsRef = useRef<WebglPlot[]>([]);
    const linesRef = useRef<WebglLine[]>([]);
    const sweepPositions = useRef<number[]>([]);
    const dataPointCountRef = useRef<number>(SAMPLE_RATE * 4);
    // globalChannel -> line index for the currently rendered plot.
    const lineIndexRef = useRef<Record<number, number>>({});

    // ----- accelerometer (one shared panel, device-selectable) -----
    const accelCanvasContainerRef = useRef<HTMLDivElement>(null);
    const accelWglpRef = useRef<WebglPlot | null>(null);
    const accelLinesRef = useRef<WebglLine[]>([]);
    const accelSweepPos = useRef<number>(0);
    const accelPointCountRef = useRef<number>(ACCEL_POINT_COUNT_PER_SEC * 4);
    const [accelDeviceId, setAccelDeviceId] = useState<string>("");
    const accelDeviceIdRef = useRef<string>("");
    useEffect(() => { accelDeviceIdRef.current = accelDeviceId; }, [accelDeviceId]);

    // ----- channel selection (global 0-based indices) -----
    const [selectedChannels, setSelectedChannels] = useState<number[]>([]);
    const selectedChannelsRef = useRef<number[]>([]);
    const manuallySelectedRef = useRef<boolean>(false);
    useEffect(() => { selectedChannelsRef.current = selectedChannels; }, [selectedChannels]);

    // ----- display / recording controls -----
    const [Zoom, setZoom] = useState<number>(1);
    const zoomRef = useRef(Zoom);
    useEffect(() => { zoomRef.current = Zoom; }, [Zoom]);
    const [timeBase, setTimeBase] = useState<number>(4);
    const [isDisplay, setIsDisplay] = useState<boolean>(true);
    const pauseRef = useRef<boolean>(true);
    const [refreshKey, setRefreshKey] = useState(0);

    const isRecordingRef = useRef<boolean>(false);
    const [isRecord, setIsRecord] = useState<boolean>(true);
    const [recordingElapsedTime, setRecordingElapsedTime] = useState<number>(0);
    const recordingStartTimeRef = useRef<number>(0);
    const [isProcessingRecording, setIsProcessingRecording] = useState(false);
    const REC_FLUSH_SIZE = 500;

    // ----- filters (keyed by global channel) -----
    const appliedEXGFiltersRef = useRef<{ [g: number]: number }>({});
    const appliedNotchFiltersRef = useRef<{ [g: number]: number }>({});
    const [, forceUpdate] = React.useReducer((x) => x + 1, 0);

    // ----- recordings worker -----
    const workerRef = useRef<Worker | null>(null);
    const [datasets, setDatasets] = useState<string[]>([]);
    const [isDownloadingAll, setIsDownloadingAll] = useState(false);
    const [isDownloadingFile, setIsDownloadingFile] = useState<{ [k: string]: boolean }>({});
    const [isDeletingFile, setIsDeletingFile] = useState<{ [k: string]: boolean }>({});
    const [isDeletingAll, setIsDeletingAll] = useState(false);

    useEffect(() => { dataPointCountRef.current = SAMPLE_RATE * timeBase; }, [timeBase]);

    const isConnected = deviceList.length > 0;

    // ================= worker =================
    const initWorker = () => {
        if (!workerRef.current && typeof window !== "undefined") {
            workerRef.current = new Worker(new URL("../workers/indexedDBWorker.ts", import.meta.url), { type: "module" });
            workerRef.current.onmessage = (event) => {
                const { action, filename, success, blob, error, allData } = event.data;
                switch (action) {
                    case "getFileCountFromIndexedDB":
                        if (allData) setDatasets(allData);
                        break;
                    case "saveDataByFilename":
                        if (blob) { saveAs(blob, filename); toast.success(`File "${filename}" downloaded.`); }
                        else if (error) toast.error(`Error downloading: ${error}`);
                        setIsDownloadingFile((p) => ({ ...p, [filename]: false }));
                        break;
                    case "saveAsZip":
                        if (blob) { saveAs(blob, "NPG-Lite-Recordings.zip"); toast.success("Downloaded ZIP."); }
                        else if (error) toast.error(`Error creating ZIP: ${error}`);
                        setIsDownloadingAll(false);
                        break;
                    case "deleteFile":
                        if (success) { toast.success(`Deleted '${filename}'.`); getFileCount(); }
                        setIsDeletingFile((p) => ({ ...p, [filename]: false }));
                        break;
                    case "deleteAll":
                        if (success) { toast.success("All recordings deleted."); setDatasets([]); }
                        setIsDeletingAll(false);
                        break;
                }
            };
        }
    };
    const getFileCount = () => { if (!workerRef.current) initWorker(); workerRef.current?.postMessage({ action: "getFileCountFromIndexedDB" }); };
    useEffect(() => { getFileCount(); }, []);

    // ================= channel space =================
    const rebuildDeviceMeta = () => {
        let offset = 0;
        const metas: DeviceMeta[] = devicesRef.current.map((rt, i) => {
            rt.offset = offset;
            rt.index = i;
            const meta: DeviceMeta = {
                id: rt.id,
                name: rt.name,
                index: i,
                offset,
                maxChannels: rt.config.maxChannels,
                hasBattery: rt.config.hasBattery,
                connected: !!rt.device?.gatt?.connected,
                battery: null,
            };
            offset += rt.config.maxChannels;
            return meta;
        });
        totalChannelsRef.current = offset;

        // default: show every channel of every device unless the user picked.
        setSelectedChannels((prev) => {
            if (!manuallySelectedRef.current) {
                return Array.from({ length: offset }, (_, i) => i);
            }
            const clamped = prev.filter((c) => c < offset);
            return clamped.length ? clamped : Array.from({ length: offset }, (_, i) => i);
        });

        setDeviceList((prevMetas) => metas.map((m) => {
            const old = prevMetas.find((p) => p.id === m.id);
            return old ? { ...m, battery: old.battery } : m;
        }));
    };

    // ================= plotting =================
    const getLineColor = (globalChannel: number): ColorRGBA => {
        const colors = activeTheme === "dark" ? darkThemeColors : lightThemeColors;
        const hex = colors[globalChannel % colors.length];
        const r = parseInt(hex.slice(1, 3), 16) / 255;
        const g = parseInt(hex.slice(3, 5), 16) / 255;
        const b = parseInt(hex.slice(5, 7), 16) / 255;
        return new ColorRGBA(r, g, b, activeTheme === "dark" ? 1 : 0.85);
    };

    const deviceOfChannel = (g: number): DeviceRuntime | undefined =>
        devicesRef.current.find((rt) => g >= rt.offset && g < rt.offset + rt.config.maxChannels);

    const createCanvasElements = useCallback(() => {
        const container = canvasContainerRef.current;
        if (!container) return;

        while (container.firstChild) {
            const first = container.firstChild;
            if (first instanceof HTMLCanvasElement) {
                const gl = first.getContext("webgl");
                gl?.getExtension("WEBGL_lose_context")?.loseContext();
            }
            try { container.removeChild(first); } catch { break; }
        }

        const channels = selectedChannelsRef.current;
        sweepPositions.current = new Array(channels.length).fill(0);
        linesRef.current = [];
        lineIndexRef.current = {};
        const newPlots: WebglPlot[] = [];
        const newLines: WebglLine[] = [];

        if (channels.length === 0) { setWglPlots([]); wglPlotsRef.current = []; return; }

        channels.forEach((globalChannel, i) => {
            const rt = deviceOfChannel(globalChannel);
            const wrapper = document.createElement("div");
            wrapper.className = "canvas-container relative flex-[1_1_0%] min-h-0";

            const canvas = document.createElement("canvas");
            canvas.width = container.clientWidth;
            canvas.height = Math.max(1, Math.floor(container.clientHeight / channels.length));
            canvas.className = "w-full h-full block rounded-lg";

            const badge = document.createElement("div");
            badge.className = "absolute left-2 top-1 text-xs font-medium rounded px-1.5 py-0.5 z-10";
            const dot = rt ? deviceChipColors[rt.index % deviceChipColors.length] : "#888";
            badge.style.color = dot;
            badge.innerText = rt ? `D${rt.index + 1} · Ch${globalChannel}` : `Ch${globalChannel}`;

            wrapper.appendChild(badge);
            wrapper.appendChild(canvas);
            container.appendChild(wrapper);

            const wglp = new WebglPlot(canvas);
            wglp.gScaleY = zoomRef.current;
            const line = new WebglLine(getLineColor(globalChannel), dataPointCountRef.current);
            line.offsetY = 0;
            line.lineSpaceX(-1, 2 / dataPointCountRef.current);
            wglp.addLine(line);

            newPlots.push(wglp);
            newLines.push(line);
            lineIndexRef.current[globalChannel] = i;
        });

        linesRef.current = newLines;
        wglPlotsRef.current = newPlots;
        setWglPlots(newPlots);
    }, [activeTheme]);

    const createAccelCanvas = useCallback(() => {
        const container = accelCanvasContainerRef.current;
        if (!container) return;
        while (container.firstChild) {
            const first = container.firstChild;
            if (first instanceof HTMLCanvasElement) {
                const gl = first.getContext("webgl");
                gl?.getExtension("WEBGL_lose_context")?.loseContext();
            }
            try { container.removeChild(first); } catch { break; }
        }
        accelPointCountRef.current = ACCEL_POINT_COUNT_PER_SEC * timeBase;

        const canvas = document.createElement("canvas");
        canvas.width = container.clientWidth;
        canvas.height = container.clientHeight;
        canvas.className = "w-full h-full block rounded-lg";
        container.appendChild(canvas);

        const wglp = new WebglPlot(canvas);
        wglp.gScaleY = 1;
        accelWglpRef.current = wglp;

        const palette = accelColors[activeTheme];
        const newLines: WebglLine[] = [];
        (["X", "Y", "Z"] as const).forEach((_, i) => {
            const hex = palette[i];
            const r = parseInt(hex.slice(1, 3), 16) / 255;
            const g = parseInt(hex.slice(3, 5), 16) / 255;
            const b = parseInt(hex.slice(5, 7), 16) / 255;
            const line = new WebglLine(new ColorRGBA(r, g, b, 1), accelPointCountRef.current);
            line.lineSpaceX(-1, 2 / accelPointCountRef.current);
            wglp.addLine(line);
            newLines.push(line);
        });
        accelLinesRef.current = newLines;
        accelSweepPos.current = 0;
    }, [timeBase, activeTheme]);

    useEffect(() => { createCanvasElements(); }, [selectedChannels, timeBase, Zoom, activeTheme, refreshKey, createCanvasElements]);
    useEffect(() => { if (isConnected) createAccelCanvas(); }, [isConnected, timeBase, activeTheme, refreshKey, createAccelCanvas]);

    useEffect(() => {
        const onResize = () => { createCanvasElements(); createAccelCanvas(); };
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, [createCanvasElements, createAccelCanvas]);

    // Single persistent render loop. It reads wglPlotsRef every frame, so newly
    // added devices/plots are picked up without spawning extra loops.
    const rafRunningRef = useRef(false);
    const animate = useCallback(() => {
        wglPlotsRef.current.forEach((p) => p.update());
        accelWglpRef.current?.update();
        if (pauseRef.current) {
            requestAnimationFrame(animate);
        } else {
            rafRunningRef.current = false;
        }
    }, []);
    const startAnim = useCallback(() => {
        if (!rafRunningRef.current) { rafRunningRef.current = true; requestAnimationFrame(animate); }
    }, [animate]);
    useEffect(() => { startAnim(); }, [startAnim, wglPlots]);

    // plot one device's freshly filtered channel values into the merged view
    const plotDeviceSample = (rt: DeviceRuntime, values: number[]) => {
        const lineMap = lineIndexRef.current;
        const zoom = zoomRef.current;
        for (let c = 0; c < values.length; c++) {
            const globalChannel = rt.offset + c;
            const li = lineMap[globalChannel];
            if (li === undefined) continue;
            const line = linesRef.current[li];
            const plot = wglPlotsRef.current[li];
            if (!line) continue;
            if (plot) plot.gScaleY = zoom;
            if (sweepPositions.current[li] === undefined) sweepPositions.current[li] = 0;
            const pos = sweepPositions.current[li] % line.numPoints;
            if (Number.isNaN(pos)) continue;
            try { line.setY(pos, values[c]); } catch { }
            const clear = Math.ceil((pos + dataPointCountRef.current / 100) % line.numPoints);
            try { line.setY(clear, NaN); } catch { }
            sweepPositions.current[li] = (pos + 1) % line.numPoints;
        }
    };

    // ================= accelerometer =================
    const updateAccelPlot = (ax: number, ay: number, az: number) => {
        const lines = accelLinesRef.current;
        if (lines.length !== 3) return;
        const norm = (v: number) => Math.max(-1, Math.min(1, v / ACCEL_SENSITIVITY / ACCEL_DISPLAY_RANGE_G));
        const vals = [norm(ax), norm(ay), norm(az)];
        const pos = accelSweepPos.current % lines[0].numPoints;
        if (Number.isNaN(pos)) return;
        lines.forEach((line, i) => {
            try { line.setY(pos, vals[i]); } catch { }
            const clear = Math.ceil((pos + accelPointCountRef.current / 100) % line.numPoints);
            try { line.setY(clear, NaN); } catch { }
        });
        accelSweepPos.current = (pos + 1) % lines[0].numPoints;
    };

    const processIMUBatch = (dv: DataView) => {
        const count = Math.floor(dv.byteLength / IMU_SAMPLE_SIZE);
        for (let s = 0; s < count; s++) {
            const b = s * IMU_SAMPLE_SIZE;
            updateAccelPlot(dv.getInt16(b + 1, false), dv.getInt16(b + 3, false), dv.getInt16(b + 5, false));
        }
    };

    // ================= sample processing =================
    const processDeviceSample = (rt: DeviceRuntime, dv: DataView) => {
        const cfg = rt.config;
        if (dv.byteLength !== cfg.sampleLength) return;
        const counter = dv.getUint8(0);
        if (rt.prevCounter !== null) {
            const expected = (rt.prevCounter + 1) % 256;
            if (counter !== expected) console.log(`[${rt.name}] missing sample: expected ${expected}, got ${counter}`);
        }
        rt.prevCounter = counter;

        const values: number[] = [];
        for (let c = 0; c < cfg.maxChannels; c++) {
            const raw = dv.getInt16(1 + c * 2, false);
            const g = rt.offset + c;
            values.push(
                rt.notch[c].process(
                    rt.exg[c].process(rt.hp[c].process(raw), appliedEXGFiltersRef.current[g]),
                    appliedNotchFiltersRef.current[g]
                )
            );
        }

        plotDeviceSample(rt, values);

        if (isRecordingRef.current) {
            rt.recBuffer.push([counter, ...values]);
            if (rt.recBuffer.length >= REC_FLUSH_SIZE) flushDeviceBuffer(rt);
            const elapsed = Date.now() - recordingStartTimeRef.current;
            setRecordingElapsedTime(elapsed);
        }
        rt.samplesReceived++;
    };

    const handleDataFor = (rt: DeviceRuntime) => (event: Event) => {
        const t = event.target as CharValue;
        if (!t.value) return;
        const value = t.value;
        const packetLen = rt.config.sampleLength * BLOCK_COUNT;
        if (value.byteLength === packetLen || value.byteLength % rt.config.sampleLength === 0) {
            for (let i = 0; i < value.byteLength; i += rt.config.sampleLength) {
                processDeviceSample(rt, new DataView(value.buffer.slice(i, i + rt.config.sampleLength)));
            }
        } else if (value.byteLength === rt.config.sampleLength) {
            processDeviceSample(rt, new DataView(value.buffer));
        } else {
            console.log(`[${rt.name}] unexpected packet length: ${value.byteLength}`);
        }
    };

    const handleIMUFor = (rt: DeviceRuntime) => (event: Event) => {
        if (accelDeviceIdRef.current !== rt.id) return;
        const t = event.target as CharValue;
        if (!t.value) return;
        processIMUBatch(new DataView(t.value.buffer));
    };

    const handleBatteryFor = (rt: DeviceRuntime) => (event: Event) => {
        const t = event.target as CharValue;
        if (t.value && t.value.byteLength === 1) {
            const level = t.value.getUint8(0);
            setDeviceList((prev) => prev.map((m) => (m.id === rt.id ? { ...m, battery: level } : m)));
        }
    };

    // ================= connect / disconnect =================
    const addDevice = useCallback(async () => {
        const nav = navigator as any;
        if (!nav.bluetooth) { toast.error("Web Bluetooth is not available. Try Chrome or Edge."); return; }
        try {
            setIsAdding(true);
            const device = await nav.bluetooth.requestDevice({
                filters: [{ namePrefix: "NPG" }],
                optionalServices: [SERVICE_UUID],
            });
            const id: string = device.id || device.name || `dev-${Date.now()}`;
            if (devicesRef.current.some((d) => d.id === id)) {
                toast.info(`${device.name || "Device"} is already connected.`);
                setIsAdding(false);
                return;
            }
            await connectDevice(device, id);
        } catch (error) {
            console.log("Add device cancelled/failed:", error);
        } finally {
            setIsAdding(false);
        }
    }, []);

    const connectDevice = async (device: any, id: string) => {
        const name: string = device.name || "NPG-Lite";
        const config = configFromName(name);
        const server = await device.gatt?.connect();
        if (!server) throw new Error("GATT connect failed");

        const service = await server.getPrimaryService(SERVICE_UUID);
        const controlChar = await service.getCharacteristic(CONTROL_CHAR_UUID);
        const dataChar = await service.getCharacteristic(DATA_CHAR_UUID);

        const mk = <T,>(make: () => T, n: number) => Array.from({ length: n }, make);
        const rt: DeviceRuntime = {
            id, device, name, index: devicesRef.current.length, config, offset: 0,
            controlChar, dataChar,
            notch: mk(() => new Notch(), config.maxChannels),
            exg: mk(() => new EXGFilter(), config.maxChannels),
            hp: mk(() => new HighPassFilter(), config.maxChannels),
            prevCounter: null,
            samplesReceived: 0,
            recBuffer: [],
            recFileName: "",
            watchdog: null,
        };
        rt.notch.forEach((f) => f.setbits(SAMPLE_RATE));
        rt.exg.forEach((f) => f.setbits("12", SAMPLE_RATE));
        rt.hp.forEach((f) => f.setSamplingRate(SAMPLE_RATE));

        if (config.hasBattery) {
            try {
                const bch = await service.getCharacteristic(BATTERY_CHAR_UUID);
                rt.batteryChar = bch;
                rt.batteryHandler = handleBatteryFor(rt);
                await bch.startNotifications();
                bch.addEventListener("characteristicvaluechanged", rt.batteryHandler);
            } catch (e) { console.log(`[${name}] battery not available`); }
        }

        try {
            const imu = await service.getCharacteristic(IMU_CHAR_UUID);
            rt.imuChar = imu;
            rt.imuHandler = handleIMUFor(rt);
            await imu.startNotifications();
            imu.addEventListener("characteristicvaluechanged", rt.imuHandler);
        } catch (e) { console.log(`[${name}] IMU not available`); }

        const encoder = new TextEncoder();
        await controlChar.writeValue(encoder.encode("START"));
        rt.dataHandler = handleDataFor(rt);
        await dataChar.startNotifications();
        dataChar.addEventListener("characteristicvaluechanged", rt.dataHandler);

        const onGattDisconnect = () => removeDevice(id, true);
        device.addEventListener?.("gattserverdisconnected", onGattDisconnect);

        // per-device watchdog: drop if no samples arrive for 2s
        rt.watchdog = setInterval(() => {
            if (rt.samplesReceived === 0 && device?.gatt?.connected) {
                // still connected but silent — leave it; only log
                console.log(`[${name}] no samples in last window`);
            }
            rt.samplesReceived = 0;
        }, 2000);

        devicesRef.current = [...devicesRef.current, rt];
        rebuildDeviceMeta();
        if (!accelDeviceIdRef.current) setAccelDeviceId(id);
        setRefreshKey((k) => k + 1);
        setIsDisplay(true);
        pauseRef.current = true;
        toast.success(`${name} connected`);
    };

    const removeDevice = async (id: string, silent = false) => {
        const rt = devicesRef.current.find((d) => d.id === id);
        if (!rt) return;
        try {
            if (rt.watchdog) clearInterval(rt.watchdog);
            const server = rt.device?.gatt;
            if (server?.connected) {
                try { rt.dataChar && (await rt.dataChar.stopNotifications()); } catch { }
                rt.dataHandler && rt.dataChar?.removeEventListener("characteristicvaluechanged", rt.dataHandler);
                try { rt.imuChar && (await rt.imuChar.stopNotifications()); } catch { }
                rt.imuHandler && rt.imuChar?.removeEventListener("characteristicvaluechanged", rt.imuHandler);
                try {
                    const enc = new TextEncoder();
                    rt.controlChar && (await rt.controlChar.writeValue(enc.encode("STOP")));
                } catch { }
                try { server.disconnect(); } catch { }
            }
        } catch (e) {
            console.log("remove device error:", e);
        } finally {
            // flush any recording rows this device still holds
            if (isRecordingRef.current && rt.recBuffer.length) flushDeviceBuffer(rt, true);
            devicesRef.current = devicesRef.current.filter((d) => d.id !== id);
            rebuildDeviceMeta();
            if (accelDeviceIdRef.current === id) {
                const next = devicesRef.current[0]?.id || "";
                setAccelDeviceId(next);
            }
            setRefreshKey((k) => k + 1);
            if (!silent) toast.success(`${rt.name} removed`);
        }
    };

    // teardown everything on unmount
    useEffect(() => {
        return () => {
            devicesRef.current.forEach((rt) => {
                if (rt.watchdog) clearInterval(rt.watchdog);
                try { if (rt.device?.gatt?.connected) rt.device.gatt.disconnect(); } catch { }
            });
            workerRef.current?.terminate?.();
            workerRef.current = null;
        };
    }, []);

    // ================= recording =================
    const safePrefix = (name: string) => name.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");

    const flushDeviceBuffer = (rt: DeviceRuntime, final = false) => {
        if (!rt.recBuffer.length) return;
        if (!workerRef.current) initWorker();
        const data = rt.recBuffer;
        rt.recBuffer = [];
        if (rt.recFileName) {
            workerRef.current?.postMessage({ action: "write", data, filename: rt.recFileName });
        }
    };

    const handleRecord = async () => {
        if (isRecordingRef.current) { await stopRecording(); return; }
        if (devicesRef.current.length === 0) { toast.error("Connect a device first."); return; }
        const now = new Date();
        const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
        devicesRef.current.forEach((rt) => {
            rt.recBuffer = [];
            rt.recFileName = `${safePrefix(rt.name)}-D${rt.index + 1}-ChordsWeb-${stamp}.csv`;
        });
        recordingStartTimeRef.current = Date.now();
        setRecordingElapsedTime(0);
        isRecordingRef.current = true;
        setIsRecord(false);
    };

    const stopRecording = async () => {
        isRecordingRef.current = false;
        setIsRecord(true);
        setIsProcessingRecording(true);
        devicesRef.current.forEach((rt) => flushDeviceBuffer(rt, true));
        setRecordingElapsedTime(0);
        recordingStartTimeRef.current = 0;
        // give the worker a moment, then refresh list
        setTimeout(() => { getFileCount(); setIsProcessingRecording(false); toast.success("Recording saved."); }, 300);
    };

    const saveByFilename = (filename: string) => {
        if (!workerRef.current) initWorker();
        setIsDownloadingFile((p) => ({ ...p, [filename]: true }));
        workerRef.current?.postMessage({ action: "saveDataByFilename", filename });
    };
    const deleteByFilename = (filename: string) => {
        if (!workerRef.current) initWorker();
        setIsDeletingFile((p) => ({ ...p, [filename]: true }));
        workerRef.current?.postMessage({ action: "deleteFile", filename });
    };
    const saveAllZip = () => { setIsDownloadingAll(true); workerRef.current?.postMessage({ action: "saveAsZip" }); };
    const deleteAll = () => { setIsDeletingAll(true); workerRef.current?.postMessage({ action: "deleteAll" }); };

    // ================= filters UI =================
    const setEXG = (g: number, type: number) => { if (type === 0) delete appliedEXGFiltersRef.current[g]; else appliedEXGFiltersRef.current[g] = type; forceUpdate(); };
    const setNotch = (g: number, type: number) => { if (type === 0) delete appliedNotchFiltersRef.current[g]; else appliedNotchFiltersRef.current[g] = type; forceUpdate(); };
    const setEXGAll = (type: number) => { for (let g = 0; g < totalChannelsRef.current; g++) { if (type === 0) delete appliedEXGFiltersRef.current[g]; else appliedEXGFiltersRef.current[g] = type; } forceUpdate(); };
    const setNotchAll = (type: number) => { for (let g = 0; g < totalChannelsRef.current; g++) { if (type === 0) delete appliedNotchFiltersRef.current[g]; else appliedNotchFiltersRef.current[g] = type; } forceUpdate(); };

    // ================= channel selection UI =================
    const toggleChannel = (g: number) => {
        manuallySelectedRef.current = true;
        setSelectedChannels((prev) => {
            const next = prev.includes(g) ? prev.filter((c) => c !== g) : [...prev, g];
            next.sort((a, b) => a - b);
            return next.length ? next : [g];
        });
    };
    const selectAllChannels = () => {
        manuallySelectedRef.current = false;
        setSelectedChannels(Array.from({ length: totalChannelsRef.current }, (_, i) => i));
    };
    const selectDeviceChannels = (rt: DeviceMeta, on: boolean) => {
        manuallySelectedRef.current = true;
        const range = Array.from({ length: rt.maxChannels }, (_, i) => rt.offset + i);
        setSelectedChannels((prev) => {
            const set = new Set(prev);
            range.forEach((g) => (on ? set.add(g) : set.delete(g)));
            const next = Array.from(set).sort((a, b) => a - b);
            return next.length ? next : range;
        });
    };

    // ================= misc UI helpers =================
    const togglePause = () => { const v = !isDisplay; setIsDisplay(v); pauseRef.current = v; if (v) startAnim(); };
    const formatTime = (ms: number) => {
        const d = new Date(ms);
        return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}`;
    };
    const batteryIcon = (level: number | null) => {
        if (level === null) return <BatteryWarning size={18} />;
        if (level <= 10) return <Battery size={18} className="text-red-500" />;
        if (level <= 20) return <BatteryLow size={18} className="text-red-500" />;
        if (level <= 70) return <BatteryMedium size={18} className="text-orange-500" />;
        return <BatteryFull size={18} className="text-green-500" />;
    };

    const exgLabel: Record<number, string> = { 0: "Off", 4: "EMG", 1: "ECG", 2: "EOG", 3: "EEG" };
    const notchLabel: Record<number, string> = { 0: "Off", 1: "50Hz", 2: "60Hz" };
    const allChannels = Array.from({ length: totalChannelsRef.current }, (_, i) => i);

    return (
        <div className="flex flex-col h-[100dvh] overflow-hidden bg-g">
            {/* ---------------- top bar with device info ---------------- */}
            <header className="flex-none flex items-center gap-3 px-4 py-2 bg-highlight border-b border-border">
                <div className="flex items-center gap-2 shrink-0">
                    <Activity className="text-primary" size={20} />
                    <span className="font-semibold tracking-tight text-sm hidden sm:inline">NPG-Lite Band</span>
                </div>

                <div className="flex flex-wrap items-center gap-1.5 flex-1 min-w-0 py-0.5">
                    {deviceList.length === 0 ? (
                        <span className="text-xs text-gray-500">No devices connected</span>
                    ) : (
                        deviceList.map((m) => (
                            <div key={m.id} className="flex items-center gap-1.5 shrink-0 rounded-full border border-border pl-2 pr-1 py-0.5 bg-g">
                                <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: deviceChipColors[m.index % deviceChipColors.length] }} />
                                <span className="text-xs font-medium max-w-[9rem] truncate" title={m.name}>{m.name}</span>
                                <span className="text-[10px] text-gray-500">Ch{m.offset}-{m.offset + m.maxChannels - 1}</span>
                                {m.hasBattery && (
                                    <span className="flex items-center gap-0.5 text-[10px]">
                                        {batteryIcon(m.battery)}{m.battery !== null ? `${m.battery}%` : ""}
                                    </span>
                                )}
                                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => removeDevice(m.id)} aria-label="Remove">
                                    <CircleX size={14} />
                                </Button>
                            </div>
                        ))
                    )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                    <Button onClick={addDevice} disabled={isAdding} className="rounded-xl gap-1 h-8 px-3 text-sm font-semibold">
                        {isAdding ? "Pairing…" : (<><Plus size={15} /> Add device</>)}
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="Theme">
                        {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
                    </Button>
                </div>
            </header>

            {/* ---------------- merged EMG plot ---------------- */}
            {/* The plot container is managed imperatively by createCanvasElements,
                so it must contain NO React children — the empty-state overlay is a
                sibling layered on top, never a child of the ref'd node. */}
            <div className="flex-1 min-h-0 m-2 relative">
                <main ref={canvasContainerRef} className="flex flex-col h-full gap-1 bg-highlight rounded-xl overflow-hidden" />
                {!isConnected && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center px-6 pointer-events-none">
                        <Bluetooth size={36} className="text-primary" />
                        <div className="text-base font-semibold">No devices connected</div>
                        <p className="text-sm text-gray-500 max-w-md">
                            Click <span className="font-medium">Add device</span> and pick an NPG-Lite band.
                            Add 3, 4 or more — every device&apos;s channels appear in this one plot,
                            numbered continuously (device 1 → 0,1,2; device 2 → 3,4,5; …).
                        </p>
                    </div>
                )}
            </div>

            {/* ---------------- accelerometer with device selector ---------------- */}
            {isConnected && (
                <div className="flex-none mx-2 mb-1">
                    <div className="flex items-center gap-2 mb-0.5 px-1">
                        <Waves size={13} className="text-orange-500" />
                        <span className="text-xs font-semibold text-gray-500">Accelerometer (X / Y / Z)</span>
                        <select
                            className="ml-auto text-xs rounded-md border border-border bg-g px-2 py-0.5"
                            value={accelDeviceId}
                            onChange={(e) => { setAccelDeviceId(e.target.value); accelSweepPos.current = 0; }}
                        >
                            {deviceList.map((m) => (
                                <option key={m.id} value={m.id}>D{m.index + 1} · {m.name}</option>
                            ))}
                        </select>
                    </div>
                    <div ref={accelCanvasContainerRef} className="h-[12vh] min-h-[64px] bg-highlight rounded-xl relative" />
                </div>
            )}

            {/* ---------------- control bar ---------------- */}
            <div className="flex-none flex items-center justify-center gap-2 px-3 py-2 bg-g border-t border-border relative">
                {isRecordingRef.current && (
                    <div className="absolute left-3 flex items-center">
                        <span className="px-2 py-1 rounded-lg bg-primary text-destructive text-sm min-w-[84px] text-center">
                            {formatTime(recordingElapsedTime)}
                        </span>
                    </div>
                )}

                <TooltipProvider>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button className="rounded-xl" onClick={togglePause} disabled={!isConnected || !isRecord}>
                                {isDisplay ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent><p>{isDisplay ? "Pause display" : "Resume display"}</p></TooltipContent>
                    </Tooltip>
                </TooltipProvider>

                <TooltipProvider>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button className="rounded-xl" onClick={handleRecord} disabled={!isConnected || isProcessingRecording}>
                                {isProcessingRecording ? <Loader2 className="animate-spin" /> : isRecordingRef.current ? <CircleStop /> : <Circle fill="red" />}
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent><p>{isRecordingRef.current ? "Stop recording" : "Start recording"}</p></TooltipContent>
                    </Tooltip>
                </TooltipProvider>

                {/* recordings */}
                <Popover>
                    <PopoverTrigger asChild>
                        <Button className="rounded-xl"><FileArchive size={16} /></Button>
                    </PopoverTrigger>
                    <PopoverContent className="p-4 rounded-xl w-80 max-h-80 overflow-y-auto">
                        <div className="space-y-3">
                            {datasets.length > 0 ? datasets.map((d) => (
                                <div key={d} className="flex justify-between items-center gap-2">
                                    <span className="text-xs truncate" title={d}>{d}</span>
                                    <div className="flex gap-1 shrink-0">
                                        <Button size="sm" className="rounded-lg px-3" onClick={() => saveByFilename(d)} disabled={isDownloadingFile[d]}>
                                            {isDownloadingFile[d] ? <Loader2 className="animate-spin h-4 w-4" /> : <Download size={15} />}
                                        </Button>
                                        <Button size="sm" className="rounded-lg px-3" onClick={() => deleteByFilename(d)} disabled={isDeletingFile[d]}>
                                            {isDeletingFile[d] ? <Loader2 className="animate-spin h-4 w-4" /> : <Trash2 size={15} />}
                                        </Button>
                                    </div>
                                </div>
                            )) : <p className="text-sm">No recordings yet.</p>}
                            {datasets.length > 0 && (
                                <div className="flex gap-2 pt-2">
                                    <Button size="sm" className="rounded-lg flex-1" onClick={saveAllZip} disabled={isDownloadingAll}>
                                        {isDownloadingAll ? <Loader2 className="animate-spin h-4 w-4" /> : <><Download size={15} className="mr-1" />ZIP</>}
                                    </Button>
                                    <Button size="sm" className="rounded-lg flex-1" onClick={deleteAll} disabled={isDeletingAll}>
                                        {isDeletingAll ? <Loader2 className="animate-spin h-4 w-4" /> : <><Trash2 size={15} className="mr-1" />All</>}
                                    </Button>
                                </div>
                            )}
                        </div>
                    </PopoverContent>
                </Popover>

                {/* channels */}
                <Popover>
                    <PopoverTrigger asChild>
                        <Button className="rounded-xl gap-1" disabled={!isConnected}><ListChecks size={16} /><span className="hidden sm:inline text-sm">Channels</span></Button>
                    </PopoverTrigger>
                    <PopoverContent className="p-4 rounded-xl w-72 max-h-80 overflow-y-auto">
                        <div className="flex items-center justify-between mb-2">
                            <span className="text-sm font-semibold">Display channels</span>
                            <Button size="sm" variant="outline" className="rounded-lg" onClick={selectAllChannels}>All</Button>
                        </div>
                        <div className="space-y-3">
                            {deviceList.map((m) => (
                                <div key={m.id}>
                                    <div className="flex items-center gap-1.5 mb-1">
                                        <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: deviceChipColors[m.index % deviceChipColors.length] }} />
                                        <span className="text-xs font-medium truncate">{m.name}</span>
                                        <button className="ml-auto text-[11px] underline" onClick={() => selectDeviceChannels(m, true)}>on</button>
                                        <button className="text-[11px] underline" onClick={() => selectDeviceChannels(m, false)}>off</button>
                                    </div>
                                    <div className="flex flex-wrap gap-1">
                                        {Array.from({ length: m.maxChannels }, (_, i) => m.offset + i).map((g) => (
                                            <button
                                                key={g}
                                                onClick={() => toggleChannel(g)}
                                                className={`text-xs px-2 py-1 rounded-lg border ${selectedChannels.includes(g) ? "bg-primary text-destructive border-primary" : "border-border"}`}
                                            >
                                                {g}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </PopoverContent>
                </Popover>

                {/* filters */}
                <Popover>
                    <PopoverTrigger asChild>
                        <Button className="rounded-xl gap-1" disabled={!isConnected || !isDisplay}><SlidersHorizontal size={16} /><span className="hidden sm:inline text-sm">Filters</span></Button>
                    </PopoverTrigger>
                    <PopoverContent className="p-4 rounded-xl w-80 max-h-80 overflow-y-auto">
                        <div className="mb-3 pb-2 border-b border-border">
                            <div className="text-xs font-semibold mb-1">All channels</div>
                            <div className="flex items-center gap-1 mb-1">
                                <span className="text-[11px] w-12 text-gray-500">Type</span>
                                {[0, 4, 1, 2, 3].map((t) => (
                                    <button key={t} onClick={() => setEXGAll(t)} className="text-[11px] px-1.5 py-0.5 rounded border border-border">{exgLabel[t]}</button>
                                ))}
                            </div>
                            <div className="flex items-center gap-1">
                                <span className="text-[11px] w-12 text-gray-500">Notch</span>
                                {[0, 1, 2].map((t) => (
                                    <button key={t} onClick={() => setNotchAll(t)} className="text-[11px] px-1.5 py-0.5 rounded border border-border">{notchLabel[t]}</button>
                                ))}
                            </div>
                        </div>
                        <div className="space-y-2">
                            {allChannels.map((g) => {
                                const rt = deviceList.find((m) => g >= m.offset && g < m.offset + m.maxChannels);
                                return (
                                    <div key={g} className="flex items-center gap-1">
                                        <span className="text-xs w-10 font-medium" style={{ color: rt ? deviceChipColors[rt.index % deviceChipColors.length] : undefined }}>Ch{g}</span>
                                        <div className="flex gap-0.5">
                                            {[0, 4, 1, 2, 3].map((t) => (
                                                <button key={t} onClick={() => setEXG(g, t)} className={`text-[10px] px-1 py-0.5 rounded ${((appliedEXGFiltersRef.current[g] || 0) === t) ? "bg-primary text-destructive" : "border border-border"}`}>{exgLabel[t]}</button>
                                            ))}
                                        </div>
                                        <div className="flex gap-0.5 ml-auto">
                                            {[0, 1, 2].map((t) => (
                                                <button key={t} onClick={() => setNotch(g, t)} className={`text-[10px] px-1 py-0.5 rounded ${((appliedNotchFiltersRef.current[g] || 0) === t) ? "bg-primary text-destructive" : "border border-border"}`}>{notchLabel[t]}</button>
                                            ))}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </PopoverContent>
                </Popover>

                {/* zoom + timebase */}
                <Popover>
                    <PopoverTrigger asChild>
                        <Button className="rounded-xl text-sm" disabled={!isConnected}>View</Button>
                    </PopoverTrigger>
                    <PopoverContent className="p-4 rounded-xl w-64">
                        <div className="mb-3">
                            <div className="flex justify-between text-xs mb-1"><span>Zoom</span><span>{Zoom.toFixed(1)}x</span></div>
                            <input type="range" min={1} max={10} step={0.1} value={Zoom} onChange={(e) => setZoom(parseFloat(e.target.value))} className="w-full" />
                        </div>
                        <div>
                            <div className="flex justify-between text-xs mb-1"><span>Time base</span><span>{timeBase}s</span></div>
                            <input type="range" min={1} max={10} step={1} value={timeBase} onChange={(e) => setTimeBase(parseInt(e.target.value))} className="w-full" />
                        </div>
                    </PopoverContent>
                </Popover>
            </div>
        </div>
    );
};

export default NPG_Ble;
