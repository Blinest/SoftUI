import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { ChartLayout } from "./layouts/ChartLayout";
import { ChannelSidebar } from "./components/layout/ResponsiveRail";
import { ChartToolbar } from "./components/ChartToolbar";
import { curvatureDistributionFromSnapshot, summarizeBackbone, buildBackboneFromCurvatureDistribution } from "./dynamics/svcModel";
import type { ChartSection, DeviceSnapshot, RuntimeSnapshot, SessionInfo } from "./softuiTypes";
import "./styles/charts.css";

type ChartKind = "position" | "velocity" | "acceleration" | "curvature" | "sensorX" | "sensorY" | "sensorZ";

interface ChartPanelConfig {
  key: ChartKind;
  title: string;
  unit: string;
  match: (name: string, channelType: string) => boolean;
}

interface CursorReadout {
  time: number;
  values: Array<{ name: string; color: string; value: number | null; unit: string }>;
}

const CHARTS: ChartPanelConfig[] = [
  { key: "position", title: "电机位移曲线", unit: "mm", match: (name, type) => type === "motor" && name.endsWith(" pos") },
  { key: "velocity", title: "电机速度曲线", unit: "mm/s", match: (name, type) => type === "motor" && name.endsWith(" vel") },
  { key: "acceleration", title: "电机加速度曲线", unit: "mm/s²", match: (name, type) => type === "motor" && name.endsWith(" acc") },
  { key: "curvature", title: "曲率分布时间曲线", unit: "1/m", match: (_name, type) => type === "curvature" },
  { key: "sensorX", title: "传感器 X 轴曲线", unit: "N", match: (name, type) => type === "sensor" && name.endsWith(" X") },
  { key: "sensorY", title: "传感器 Y 轴曲线", unit: "N", match: (name, type) => type === "sensor" && name.endsWith(" Y") },
  { key: "sensorZ", title: "传感器 Z 轴曲线", unit: "N", match: (name, type) => type === "sensor" && name.endsWith(" Z") },
];

const COLORS = ["#4fc3f7", "#81c784", "#ffb74d", "#f06292", "#ba68c8", "#4dd0e1", "#aed581", "#ff8a65", "#9575cd", "#4db6ac", "#dce775", "#e57373", "#90a4ae", "#7986cb", "#64b5f6", "#a1887f", "#ffcc80", "#b39ddb"];
const MAX_RENDER_POINTS = 240;

function downsampleFrames(frames: DeviceSnapshot[], maxPoints: number) {
  if (frames.length <= maxPoints) return frames;
  const step = Math.max(1, Math.ceil(frames.length / maxPoints));
  return frames.filter((_, index) => index % step === 0);
}

function chartsFromFrames(frames: DeviceSnapshot[]): ChartSection | null {
  const ordered = downsampleFrames(frames, MAX_RENDER_POINTS);
  const first = ordered[0];
  if (!first) return null;
  const timestamps = ordered.map((frame) => frame.receivedAtMs / 1000);
  const channels: ChartSection["channels"] = [];

  for (const motor of first.motors) {
    channels.push({ name: `Motor ${motor.id} pos`, unit: "mm", channelType: "motor", channelIndex: motor.id, points: ordered.map((frame) => frame.motors.find((item) => item.id === motor.id)?.positionMm ?? 0) });
    channels.push({ name: `Motor ${motor.id} vel`, unit: "mm/s", channelType: "motor", channelIndex: motor.id, points: ordered.map((frame) => frame.motors.find((item) => item.id === motor.id)?.velocityMmPerSec ?? 0) });
    channels.push({ name: `Motor ${motor.id} acc`, unit: "mm/s²", channelType: "motor", channelIndex: motor.id, points: ordered.map((frame) => frame.motors.find((item) => item.id === motor.id)?.accelerationMmPerSec2 ?? 0) });
  }

  const distributions = ordered.map((frame) => curvatureDistributionFromSnapshot(frame, { basisSegmentCount: 12 }));
  const summaries = distributions.map((distribution) => summarizeBackbone(buildBackboneFromCurvatureDistribution(distribution)));
  const basisCount = distributions[0]?.basisSegmentCount ?? 0;
  for (let index = 0; index < basisCount; index += 1) {
    channels.push({
      name: `κ ${String(index + 1).padStart(2, "0")}`,
      unit: "1/m",
      channelType: "curvature",
      channelIndex: index + 1,
      points: distributions.map((distribution) => distribution.segments[index]?.kappaAbsPerM ?? 0),
    });
  }
  channels.push({ name: "κ max", unit: "1/m", channelType: "curvature", channelIndex: basisCount + 1, points: summaries.map((summary) => summary.maxKappaPerM) });
  channels.push({ name: "κ mean", unit: "1/m", channelType: "curvature", channelIndex: basisCount + 2, points: summaries.map((summary) => summary.meanKappaPerM) });

  for (const sensor of first.sensors) {
    sensor.alias.forEach((axis, axisIndex) => {
      channels.push({ name: `Sensor ${sensor.id} ${axis}`, unit: sensor.unit, channelType: "sensor", channelIndex: sensor.id, points: ordered.map((frame) => frame.sensors.find((item) => item.id === sensor.id)?.filtered[axisIndex] ?? 0) });
    });
  }

  return { windowSize: ordered.length, timestamps, channels };
}

function fallbackTimestamps(charts: ChartSection) {
  if (charts.timestamps?.length) return charts.timestamps;
  const len = charts.channels[0]?.points.length ?? 0;
  return Array.from({ length: len }, (_, index) => Number(((index - Math.max(len - 1, 0)) * 0.05).toFixed(2)));
}

function emptyCharts(): ChartSection {
  return { windowSize: 0, timestamps: [], channels: [] };
}

function formatValue(value: number | null, unit: string) {
  if (value == null || !Number.isFinite(value)) return "--";
  const abs = Math.abs(value);
  const precision = abs >= 100 ? 1 : abs >= 10 ? 2 : 3;
  return `${value.toFixed(precision)} ${unit}`;
}

function formatRelativeSeconds(seconds: number) {
  return Number.isFinite(seconds) ? `${seconds.toFixed(1)}s` : "--";
}

function formatStatus(error: string, exportPath: string, playbackMode: boolean, historyCount: number) {
  if (error) return error;
  if (exportPath) return exportPath;
  if (playbackMode) return `历史会话：已加载 ${historyCount} 帧`;
  return "实时刷新中";
}

function channelSignature(channels: ChartSection["channels"]) {
  return channels.map((channel) => channel.name).join("|");
}

function latestDataKey(timestamps: number[], channels: ChartSection["channels"]) {
  const lastTime = timestamps[timestamps.length - 1] ?? 0;
  return `${timestamps.length}:${lastTime}:${channels.map((channel) => `${channel.points.length}:${channel.points[channel.points.length - 1] ?? 0}`).join("|")}`;
}

function axisRanges(timestamps: number[], channels: ChartSection["channels"]) {
  const xMin = timestamps[0] ?? 0;
  const xMax = timestamps[timestamps.length - 1] ?? 1;
  const values = channels.flatMap((channel) => channel.points).filter(Number.isFinite);
  let yMin = values.length ? Math.min(...values) : 0;
  let yMax = values.length ? Math.max(...values) : 1;
  if (Math.abs(yMax - yMin) < 1e-6) {
    yMin -= 1;
    yMax += 1;
  } else {
    const pad = (yMax - yMin) * 0.12;
    yMin -= pad;
    yMax += pad;
  }
  return { x: { min: xMin, max: xMax > xMin ? xMax : xMin + 1 }, y: { min: yMin, max: yMax } };
}

function ChartPanel({ config, charts, paused, timeOrigin, hidden, onToggleChannel }: {
  config: ChartPanelConfig;
  charts: ChartSection;
  paused: boolean;
  timeOrigin: number;
  hidden: Record<string, boolean>;
  onToggleChannel: (name: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const lastKeyRef = useRef("");
  const [readout, setReadout] = useState<CursorReadout | null>(null);

  const panelChannels = useMemo(() => charts.channels.filter((channel) => config.match(channel.name, channel.channelType)), [charts.channels, config]);
  const visibleChannels = useMemo(() => panelChannels.filter((channel) => !hidden[channel.name]), [hidden, panelChannels]);
  const timestamps = useMemo(() => fallbackTimestamps(charts), [charts]);
  const alignedData = useMemo<uPlot.AlignedData>(() => [timestamps, ...visibleChannels.map((channel) => channel.points)], [timestamps, visibleChannels]);
  const visibleKey = useMemo(() => channelSignature(visibleChannels), [visibleChannels]);
  const dataKey = useMemo(() => `${config.key}:${latestDataKey(timestamps, visibleChannels)}`, [config.key, timestamps, visibleChannels]);
  const timestampsRef = useRef(timestamps);
  const visibleChannelsRef = useRef(visibleChannels);

  useEffect(() => {
    timestampsRef.current = timestamps;
    visibleChannelsRef.current = visibleChannels;
  }, [timestamps, visibleChannels]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const updateReadout = (plot: uPlot) => {
      const idx = typeof plot.cursor.idx === "number" ? plot.cursor.idx : null;
      const currentTimestamps = timestampsRef.current;
      const currentChannels = visibleChannelsRef.current;
      if (idx == null || idx < 0 || idx >= currentTimestamps.length) {
        setReadout(null);
        return;
      }
      setReadout({
        time: currentTimestamps[idx],
        values: currentChannels.map((channel, index) => ({
          name: channel.name,
          color: COLORS[index % COLORS.length],
          value: channel.points[idx] ?? null,
          unit: channel.unit || config.unit,
        })),
      });
    };

    const opts: uPlot.Options = {
      width: Math.max(320, host.clientWidth),
      height: Math.max(180, host.clientHeight || 220),
      cursor: { show: true, x: true, y: false, drag: { x: false, y: false }, points: { show: false } },
      legend: { show: false },
      scales: { x: { time: false }, y: {} },
      series: [
        {},
        ...visibleChannels.map((channel, index): uPlot.Series => ({
          label: channel.name,
          stroke: COLORS[index % COLORS.length],
          width: 1.4,
          points: { show: false },
        })),
      ],
      axes: [
        { label: "时间 s", stroke: "#8a95a3", grid: { stroke: "rgba(255,255,255,0.06)" }, values: (_plot, vals) => vals.map((value) => (value - timeOrigin).toFixed(1)) },
        { label: config.unit, stroke: "#8a95a3", grid: { stroke: "rgba(255,255,255,0.06)" } },
      ],
      hooks: { setCursor: [updateReadout] },
    };

    plotRef.current?.destroy();
    plotRef.current = new uPlot(opts, alignedData, host);
    const ranges = axisRanges(timestampsRef.current, visibleChannelsRef.current);
    plotRef.current.setScale("x", ranges.x);
    plotRef.current.setScale("y", ranges.y);
    lastKeyRef.current = dataKey;
    setReadout(null);

    const resize = () => plotRef.current?.setSize({ width: Math.max(320, host.clientWidth), height: Math.max(180, host.clientHeight || 220) });
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    return () => {
      observer.disconnect();
      plotRef.current?.destroy();
      plotRef.current = null;
    };
  }, [config.unit, timeOrigin, visibleKey]);

  useEffect(() => {
    const plot = plotRef.current;
    if (!plot || paused || lastKeyRef.current === dataKey) return;
    plot.setData(alignedData, false);
    const ranges = axisRanges(timestamps, visibleChannels);
    plot.setScale("x", ranges.x);
    plot.setScale("y", ranges.y);
    lastKeyRef.current = dataKey;
  }, [alignedData, dataKey, paused, timestamps, visibleChannels]);

  return (
    <section className="chart-split-card">
      <div className="chart-split-head">
        <div className="chart-split-title-row">
          <strong>{config.title}</strong>
          <span>{readout ? `t=${formatRelativeSeconds(readout.time - timeOrigin)}` : "移动鼠标查看当前时间"}</span>
        </div>
        <div className="chart-split-legend">
          {panelChannels.map((channel, index) => (
            <label className={hidden[channel.name] ? "muted" : ""} key={channel.name}>
              <input type="checkbox" checked={!hidden[channel.name]} onChange={() => onToggleChannel(channel.name)} />
              <i style={{ background: COLORS[index % COLORS.length] }} />
              {channel.name}
            </label>
          ))}
        </div>
        <div className="chart-readout-values">
          {(readout?.values ?? visibleChannels.map((channel, index) => ({ name: channel.name, color: COLORS[index % COLORS.length], value: null, unit: channel.unit || config.unit }))).map((item) => (
            <span key={item.name}><i style={{ background: item.color }} />{item.name}: <strong>{formatValue(item.value, item.unit)}</strong></span>
          ))}
        </div>
      </div>
      <div className="chart-split-plot" ref={hostRef} />
    </section>
  );
}

export default function ChartsPage({ snapshot: _snapshot }: { snapshot: RuntimeSnapshot }) {
  const [paused, setPaused] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState("live");
  const [historyFrames, setHistoryFrames] = useState<DeviceSnapshot[]>([]);
  const [liveFrames, setLiveFrames] = useState<DeviceSnapshot[]>([]);
  const [exportPath, setExportPath] = useState("");
  const [chartError, setChartError] = useState("");
  const [timeOrigin, setTimeOrigin] = useState<number | null>(null);
  const [hidden, setHidden] = useState<Record<string, boolean>>({});

  const toggleChannel = useCallback((name: string) => {
    setHidden((prev) => ({ ...prev, [name]: !prev[name] }));
  }, []);
  const liveCharts = useMemo(() => chartsFromFrames(liveFrames), [liveFrames]);
  const historyCharts = useMemo(() => chartsFromFrames(historyFrames), [historyFrames]);
  const activeCharts: ChartSection = selectedSessionId === "live" ? liveCharts ?? emptyCharts() : historyCharts ?? emptyCharts();
  const playbackMode = selectedSessionId !== "live";

  // 实时模式：独立高频拉取曲线窗口（100ms），不再依赖整份快照的 charts 字段。
  useEffect(() => {
    if (selectedSessionId !== "live" || paused) return;
    let cancelled = false;
    let pending = false;
    const fetchWindow = async () => {
      if (pending) return;
      pending = true;
      try {
        const frames = await invoke<DeviceSnapshot[]>("fetch_live_window", { count: 240 });
        if (!cancelled) setLiveFrames(frames);
      } catch (error) {
        if (!cancelled) setChartError(error instanceof Error ? error.message : String(error));
      } finally {
        pending = false;
      }
    };
    void fetchWindow();
    const timer = window.setInterval(fetchWindow, 100);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [paused, selectedSessionId]);

  useEffect(() => {
    void invoke<SessionInfo[]>("list_sessions").then(setSessions).catch(() => setSessions([]));
  }, []);

  useEffect(() => {
    setExportPath("");
    setChartError("");
    setTimeOrigin(null);
    if (selectedSessionId === "live") {
      setHistoryFrames([]);
      return;
    }
    void invoke<DeviceSnapshot[]>("read_session_frames", { id: selectedSessionId, maxCount: 1200 })
      .then(setHistoryFrames)
      .catch((error) => {
        setHistoryFrames([]);
        setChartError(error instanceof Error ? error.message : String(error));
      });
  }, [selectedSessionId]);

  useEffect(() => {
    if (timeOrigin != null) return;
    const first = activeCharts.timestamps?.[0];
    if (Number.isFinite(first)) setTimeOrigin(first);
  }, [activeCharts.timestamps, timeOrigin]);

  const exportAllChannels = async () => {
    try {
      const path = await invoke<string>("export_chart_csv", {
        sessionId: selectedSessionId === "live" ? null : selectedSessionId,
        channelNames: activeCharts.channels.map((channel) => channel.name),
        maxCount: 1200,
      });
      setExportPath(path);
      setChartError("");
    } catch (error) {
      setChartError(error instanceof Error ? error.message : String(error));
    }
  };

  const chartKeyFor = useCallback(
    (channel: ChartSection["channels"][number]) =>
      CHARTS.find((config) => config.match(channel.name, channel.channelType))?.key ?? null,
    [],
  );
  const chartTitles = useMemo(
    () => Object.fromEntries(CHARTS.map((config) => [config.key as string, config.title])),
    [],
  );
  const visibleNames = useMemo(() => (
    new Set(
      activeCharts.channels
        .filter((channel) => !hidden[channel.name])
        .map((channel) => channel.name),
    )
  ), [activeCharts.channels, hidden]);

  return (
    <ChartLayout
      channelsLabel="曲线通道"
      channels={
        <ChannelSidebar
          channels={activeCharts.channels}
          visibleNames={visibleNames}
          chartKeyFor={chartKeyFor}
          chartTitles={chartTitles}
          onToggleChannel={toggleChannel}
        />
      }
      toolbar={
        <ChartToolbar
          sessions={sessions}
          selectedSessionId={selectedSessionId}
          paused={paused}
          playbackMode={playbackMode}
          status={formatStatus(chartError, exportPath, playbackMode, historyFrames.length)}
          onSessionChange={setSelectedSessionId}
          onPauseChange={setPaused}
          onRefresh={() => setPaused(false)}
          onExportCsv={() => void exportAllChannels()}
        />
      }
    >
      <div className="charts-split-grid">
        {CHARTS.map((config) => (
          <ChartPanel
            key={config.key}
            config={config}
            charts={activeCharts}
            paused={paused}
            timeOrigin={timeOrigin ?? activeCharts.timestamps?.[0] ?? 0}
            hidden={hidden}
            onToggleChannel={toggleChannel}
          />
        ))}
      </div>
    </ChartLayout>
  );
}
