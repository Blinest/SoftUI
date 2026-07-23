import { useState, useEffect, useCallback } from "react";
import type { SerialPortDescriptor, ConnectionProfile, ConnectDeviceRequest } from "../softuiTypes";
import { Wifi, X, RefreshCw, Trash2, CheckCircle2 } from "lucide-react";

interface ConnectDialogProps {
  open: boolean;
  ports: SerialPortDescriptor[];
  profiles: ConnectionProfile[];
  onConnect: (request: ConnectDeviceRequest) => Promise<void>;
  onSaveProfile: (profile: ConnectionProfile) => Promise<void>;
  onDeleteProfile: (id: string) => Promise<void>;
  onRefreshPorts: () => void;
  onClose: () => void;
}

const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
const DATA_BITS_OPTIONS = [8, 7] as const;
const PARITY_OPTIONS = ["none", "even", "odd"] as const;
const STOP_BITS_OPTIONS = [1, 2] as const;
const FLOW_CONTROL_OPTIONS = ["none", "software", "hardware"] as const;

type PortMode = "scan" | "manual";

export default function ConnectDialog({
  open,
  ports,
  profiles,
  onConnect,
  onSaveProfile,
  onDeleteProfile,
  onRefreshPorts,
  onClose,
}: ConnectDialogProps) {
  const [portMode, setPortMode] = useState<PortMode>("scan");
  const [selectedPort, setSelectedPort] = useState("");
  const [manualPort, setManualPort] = useState("");
  const [baudRate, setBaudRate] = useState(115200);
  const [dataBits, setDataBits] = useState<8 | 7>(8);
  const [parity, setParity] = useState<"none" | "even" | "odd">("none");
  const [stopBits, setStopBits] = useState<1 | 2>(1);
  const [flowControl, setFlowControl] = useState<"none" | "software" | "hardware">("none");
  const [saveAsProfile, setSaveAsProfile] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setError(null);
      setConnecting(false);
      setSelectedPort("");
      setManualPort("");
      setSaveAsProfile(false);
      setProfileName("");
    }
  }, [open]);

  const getResolvedPort = useCallback(() => {
    return portMode === "scan" ? selectedPort : manualPort.trim();
  }, [portMode, selectedPort, manualPort]);

  const canConnect = getResolvedPort().length > 0 && !connecting;

  const handleConnect = async () => {
    const port = getResolvedPort();
    if (!port) return;

    setConnecting(true);
    setError(null);

    const request: ConnectDeviceRequest = {
      portName: port,
      baudRate,
      dataBits,
      parity,
      stopBits,
      flowControl,
    };

    try {
      await onConnect(request);

      // Save as profile if requested
      if (saveAsProfile && profileName.trim()) {
        const profile: ConnectionProfile = {
          id: `custom-${Date.now()}`,
          name: profileName.trim(),
          port,
          baudRate,
          dataBits,
          parity,
          stopBits,
          flowControl,
          autoReconnect: false,
        };
        await onSaveProfile(profile);
      }

      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  };

  const handleLoadProfile = (profile: ConnectionProfile) => {
    setSelectedPort(profile.port);
    setBaudRate(profile.baudRate);
    setDataBits(profile.dataBits);
    setParity(profile.parity);
    setStopBits(profile.stopBits);
    setFlowControl(profile.flowControl);
    setError(null);
  };

  const availablePorts = ports.filter((p) => p.likelyAvailable);

  if (!open) return null;

  return (
    <div className="connect-overlay" onClick={onClose}>
      <div className="connect-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="connect-dialog-head">
          <h2>
            <Wifi size={16} />
            <span>串口连接</span>
          </h2>
          <button type="button" className="ghost-btn-sm" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        {/* Port selection */}
        <div className="connect-section">
          <label className="connect-label">端口选择</label>
          <div className="port-mode-toggle">
            <button
              type="button"
              className={`ghost-btn-sm ${portMode === "scan" ? "active" : ""}`}
              onClick={() => setPortMode("scan")}
            >
              扫描列表
            </button>
            <button
              type="button"
              className={`ghost-btn-sm ${portMode === "manual" ? "active" : ""}`}
              onClick={() => setPortMode("manual")}
            >
              手动输入
            </button>
          </div>

          {portMode === "scan" ? (
            <div className="connect-port-scan">
              <select
                value={selectedPort}
                onChange={(e) => setSelectedPort(e.target.value)}
                className="connect-select"
              >
                <option value="">-- 选择端口 --</option>
                {availablePorts.map((p) => (
                  <option key={p.portName} value={p.portName}>
                    {p.portName}
                    {p.description ? ` (${p.description})` : ""}
                    {p.manufacturer ? ` - ${p.manufacturer}` : ""}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="ghost-btn-sm"
                onClick={onRefreshPorts}
                title="刷新串口"
              >
                <RefreshCw size={14} />
              </button>
            </div>
          ) : (
            <input
              type="text"
              className="connect-input"
              placeholder="例如 COM3 或 /dev/ttyUSB0"
              value={manualPort}
              onChange={(e) => setManualPort(e.target.value)}
            />
          )}
        </div>

        {/* Configuration fields */}
        <div className="connect-section">
          <label className="connect-label">串口参数</label>
          <div className="connect-grid">
            <div className="connect-field">
              <label>波特率</label>
              <select value={baudRate} onChange={(e) => setBaudRate(Number(e.target.value))}>
                {BAUD_RATES.map((r) => (
                  <option key={r} value={r}>
                    {r.toLocaleString()}
                  </option>
                ))}
              </select>
            </div>
            <div className="connect-field">
              <label>数据位</label>
              <select value={dataBits} onChange={(e) => setDataBits(Number(e.target.value) as 8 | 7)}>
                {DATA_BITS_OPTIONS.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            <div className="connect-field">
              <label>校验位</label>
              <select value={parity} onChange={(e) => setParity(e.target.value as "none" | "even" | "odd")}>
                {PARITY_OPTIONS.map((v) => (
                  <option key={v} value={v}>
                    {v === "none" ? "无" : v === "even" ? "偶校验" : "奇校验"}
                  </option>
                ))}
              </select>
            </div>
            <div className="connect-field">
              <label>停止位</label>
              <select value={stopBits} onChange={(e) => setStopBits(Number(e.target.value) as 1 | 2)}>
                {STOP_BITS_OPTIONS.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            <div className="connect-field">
              <label>流控</label>
              <select value={flowControl} onChange={(e) => setFlowControl(e.target.value as "none" | "software" | "hardware")}>
                {FLOW_CONTROL_OPTIONS.map((v) => (
                  <option key={v} value={v}>
                    {v === "none" ? "无" : v === "software" ? "软件" : "硬件"}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Save as profile */}
        <div className="connect-section">
          <div className="connect-save-profile">
            <label className="connect-checkbox">
              <input
                type="checkbox"
                checked={saveAsProfile}
                onChange={(e) => setSaveAsProfile(e.target.checked)}
              />
              <span>保存为配置</span>
            </label>
            {saveAsProfile ? (
              <input
                type="text"
                className="connect-input"
                placeholder="配置名称"
                value={profileName}
                onChange={(e) => setProfileName(e.target.value)}
              />
            ) : null}
          </div>
        </div>

        {/* Saved profiles list */}
        {profiles.length > 0 ? (
          <div className="connect-section">
            <label className="connect-label">已保存配置</label>
            <div className="profile-list">
              {profiles.map((p) => (
                <div className="profile-item" key={p.id}>
                  <div className="profile-item-info">
                    <strong>{p.name}</strong>
                    <span>
                      {p.port} · {p.baudRate.toLocaleString()} baud · {p.dataBits}
                      {p.parity === "none" ? "N" : p.parity === "even" ? "E" : "O"}
                      {p.stopBits}
                    </span>
                  </div>
                  <div className="profile-item-actions">
                    <button
                      type="button"
                      className="ghost-btn-sm"
                      onClick={() => handleLoadProfile(p)}
                      title="加载配置"
                    >
                      <CheckCircle2 size={12} />
                    </button>
                    <button
                      type="button"
                      className="ghost-btn-sm danger"
                      onClick={() => onDeleteProfile(p.id)}
                      title="删除配置"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* Error */}
        {error ? <div className="connect-error">{error}</div> : null}

        {/* Actions */}
        <div className="connect-actions">
          <button type="button" className="ghost-btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className={`primary-btn ${connecting ? "disabled" : ""}`}
            disabled={!canConnect}
            onClick={handleConnect}
          >
            {connecting ? "连接中..." : "连接"}
          </button>
        </div>
      </div>
    </div>
  );
}
