import {Head, router, useHttp, usePoll} from '@inertiajs/react';
import {Check, ChevronDown, ChevronRight, CloudDownload, Download, Film, Folder, HardDrive, Menu, Pause, Play, PlugZap, Plus, RefreshCw, Search, Server, Settings2, SlidersHorizontal, Terminal, Trash2, Unplug, X,} from 'lucide-react';
import type {ButtonHTMLAttributes, ReactNode, Ref} from 'react';
import {useEffect, useRef, useState} from 'react';
import {addDevice, discover, download, file as downloadFile, operate, removeDevice, settings as saveSettings, testDevice, transfer, updateDevice,} from '@/actions/App/Http/Controllers/UsbCloudController';
import {store as createInstallation} from '@/actions/App/Http/Controllers/ClientInstallationController';
import {Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger,} from '@/components/ui/dialog';
import {MultiSelect, MultiSelectTheme} from '@/components/multi-select';
import type {DeviceMetrics} from '@/lib/device-health';
import {deviceHealth} from '@/lib/device-health';
import type {TransferDismissals} from '@/lib/transfer-dismissals';
import {dismissTransferRuns, parseTransferDismissals, transferDismissalsKey, visibleTransferDevices,} from '@/lib/transfer-dismissals';
import '../../css/usbcloud.css';

type Theme = 'phosphor' | 'paper';
type DeviceAction = 'refresh' | 'scan' | 'pull' | 'mount' | 'unmount';
type LogPaneState = { id: string; source: string };
type LogRowState = { id: string; panes: LogPaneState[] };
type Screen = 'devices' | 'device' | 'files' | 'gallery' | 'log' | 'settings';
type Status = 'online' | 'syncing' | 'offline' | 'fault';
type Volume = {
    id: string;
    generation: string;
    type: string | null;
    uuid?: string | null;
    label?: string | null;
    mounted: boolean;
    error?: string;
    total_bytes?: number;
    free_bytes?: number;
};
type VolumeChange = {
    volume_id: string;
    kind: 'added' | 'removed' | 'reformatted';
};
type Device = {
    id: string;
    name: string;
    address: string;
    status: Status;
    operation: string | null;
    error: string | null;
    gadget_loaded: boolean | null;
    usb_state: string;
    firmware: string | null;
    uptime_seconds: number | null;
    volumes?: Volume[];
    volume_changes?: VolumeChange[];
    filesystem: {
        type: string | null;
        mount: string;
        used_bytes: number;
        total_bytes: number;
        free_bytes: number;
    } | null;
    pending: number | null;
    last_sync: string | null;
    next_sync: string | null;
    scanned_at: string | null;
    checked_at: string | null;
    status_source: 'ssh' | 'heartbeat';
    metrics: DeviceMetrics | null;
    health_warnings: string[];
    last_file: string | null;
    hostname: string | null;
    model: string | null;
    snapshot: { expires_at: number } | null;
    config: DeviceConfig;
    transfer: Transfer | null;
};
type StoredFile = {
    source_path?: string;
    volume_id?: string;
    volume_generation?: string;
    export_path?: string | null;
    id: string;
    device: string;
    name: string;
    bytes: number;
    sha256: string;
    modified_at: string | null;
    saved_at: string | null;
    state: 'pending' | 'pulled' | 'queued' | 'pulling' | 'paused' | 'failed';
    progress?: number;
    error?: string;
    media?: {
        duration: number | null;
        width: number | null;
        height: number | null;
    } | null;
    on_device: boolean;
};
type LogEntry = {
    at: string;
    source: string;
    device?: string | null;
    level: string;
    message: string;
    origin: string;
};
type CloudSettings = {
    server_name: string;
    pull_interval: number;
    auto_pull: boolean;
    theme: Theme;
};
type Cloud = {
    devices: Device[];
    files: StoredFile[];
    logs: {
        server: LogEntry[];
        devices: Record<string, LogEntry[]>;
        errors: Record<string, string>;
    };
    settings: CloudSettings;
    server: {
        ssh_public_key: string | null;
        worker_last_seen: string | null;
        client_version: string;
        url: string;
        storage_root: string;
        scheduler_last_seen: string | null;
        installer_profiles: {
            id: string;
            name: string;
            description: string;
        }[];
    };
};

const bytes = (value: number | undefined | null) => {
    if (value == null) return '—';
    if (value < 1000) return `${value} B`;
    const unit = Math.min(4, Math.floor(Math.log10(value) / 3));
    return `${(value / 1000 ** unit).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`;
};
const date = (at: string | null) => (at ? new Date(at).toLocaleString() : '—');
const ago = (at: string | null) => {
    if (!at) return 'Never';
    const seconds = Math.max(
        0,
        Math.floor((Date.now() - new Date(at).getTime()) / 1000),
    );
    if (seconds < 10) return 'just now';
    if (seconds < 60) return `${seconds} s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
    return `${Math.floor(seconds / 86400)} d ago`;
};
const uptime = (seconds: number | null) =>
    seconds == null
        ? '—'
        : `${Math.floor(seconds / 86400)} d ${String(Math.floor((seconds % 86400) / 3600)).padStart(2, '0')}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}`;

function Button({
    children,
    variant = '',
    small = false,
    className = '',
    buttonRef,
    ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: string;
    small?: boolean;
    buttonRef?: Ref<HTMLButtonElement>;
}) {
    return (
        <button
            ref={buttonRef}
            type="button"
            className={`uc-btn ${variant ? `uc-btn-${variant}` : ''} ${small ? 'uc-btn-sm' : ''} ${className}`}
            {...props}
        >
            {children}
        </button>
    );
}
function Badge({ status }: { status: Status }) {
    return (
        <span className={`uc-badge uc-badge-${status} uc-label`}>
            <span className="uc-badge-dot" />
            {status === 'fault' ? 'Fault' : status}
        </span>
    );
}
function ErrorSummary({ message, theme }: { message: string; theme: Theme }) {
    return (
        <div className="uc-error">
            <p className="uc-error-summary">{message}</p>
            <Dialog>
                <DialogTrigger asChild>
                    <Button small variant="ghost">
                        View error details
                    </Button>
                </DialogTrigger>
                <DialogContent
                    className="usbcloud uc-error-dialog"
                    data-theme={theme}
                >
                    <DialogTitle className="uc-heading">
                        Error details
                    </DialogTitle>
                    <DialogDescription className="uc-data uc-muted">
                        Full error message from the latest failed operation.
                    </DialogDescription>
                    <pre
                        className="uc-data uc-error-details"
                        tabIndex={0}
                        aria-label="Full error message"
                    >
                        {message}
                    </pre>
                </DialogContent>
            </Dialog>
        </div>
    );
}
function Tabs({
    items,
    value,
    onChange,
    label,
}: {
    items: { id: string; label: string; count?: number | null }[];
    value: string;
    onChange: (id: string) => void;
    label: string;
}) {
    return (
        <div className="uc-tabs" role="tablist" aria-label={label}>
            {items.map((item, index) => (
                <button
                    type="button"
                    role="tab"
                    aria-selected={value === item.id}
                    tabIndex={value === item.id ? 0 : -1}
                    key={item.id}
                    className={`uc-tab uc-label ${value === item.id ? 'uc-tab-active' : ''}`}
                    onClick={() => onChange(item.id)}
                    onKeyDown={(event) => {
                        if (
                            ![
                                'ArrowLeft',
                                'ArrowRight',
                                'Home',
                                'End',
                            ].includes(event.key)
                        )
                            return;
                        event.preventDefault();
                        const next =
                            event.key === 'Home'
                                ? 0
                                : event.key === 'End'
                                  ? items.length - 1
                                  : (index +
                                        (event.key === 'ArrowRight' ? 1 : -1) +
                                        items.length) %
                                    items.length;
                        onChange(items[next].id);
                        (
                            event.currentTarget.parentElement?.children[
                                next
                            ] as HTMLElement
                        )?.focus();
                    }}
                >
                    {item.label}
                    {item.count != null && (
                        <span className="uc-tab-count">{item.count}</span>
                    )}
                </button>
            ))}
        </div>
    );
}
function Field({
    label,
    hint,
    children,
    error,
}: {
    label: string;
    hint?: string;
    children: ReactNode;
    error?: string;
}) {
    return (
        <label className={`uc-input ${error ? 'uc-input-error' : ''}`}>
            <span className="uc-label uc-input-label">{label}</span>
            {children}
            {hint && <span className="uc-input-hint">{hint}</span>}
            {error && (
                <span className="uc-input-message" role="alert">
                    {error}
                </span>
            )}
        </label>
    );
}
function Meter({
    device,
    label = 'Storage',
}: {
    device: Device;
    label?: string;
}) {
    const fs = device.filesystem;
    const used = fs ? Math.ceil((fs.used_bytes / fs.total_bytes) * 24) : 0;
    return (
        <div className="uc-meter">
            <div className="uc-meter-head">
                <span className="uc-label uc-muted">{label}</span>
                <span className="uc-data">
                    <strong>{bytes(fs?.used_bytes)}</strong> /{' '}
                    <span className="uc-muted">{bytes(fs?.total_bytes)}</span>
                </span>
            </div>
            <div
                className="uc-meter-track"
                role="meter"
                aria-label="Storage used"
                aria-valuemin={0}
                aria-valuemax={fs?.total_bytes ?? 100}
                aria-valuenow={fs?.used_bytes ?? 0}
                aria-valuetext={
                    fs
                        ? `${bytes(fs.used_bytes)} of ${bytes(fs.total_bytes)} used`
                        : 'Pull from this device to measure storage'
                }
            >
                {Array.from({ length: 24 }, (_, i) => (
                    <span
                        key={i}
                        className={`uc-meter-seg ${i < used ? (i === used - 1 ? 'uc-meter-seg-live' : 'uc-meter-seg-on') : ''}`}
                    />
                ))}
            </div>
        </div>
    );
}
function HealthTiles({ device }: { device: Device }) {
    const metrics = device.metrics;
    const health = deviceHealth(
        metrics,
        device.status === 'offline',
        device.health_warnings,
    );
    const tiles = [
        {
            label: 'CPU temp',
            value:
                metrics?.cpu_temperature_c != null
                    ? `${metrics.cpu_temperature_c.toFixed(1)} °C`
                    : '—',
            percent:
                metrics?.cpu_temperature_c != null
                    ? (metrics.cpu_temperature_c / 85) * 100
                    : null,
            high: health.temperatureHigh,
            flag: 'Hot',
            note: 'throttles at 85 °C',
        },
        {
            label: 'CPU load',
            value: metrics?.load_1m != null ? metrics.load_1m.toFixed(2) : '—',
            percent: health.loadPercent,
            high: health.loadHigh,
            flag: 'High',
            note: `1 min average${metrics?.cpu_count ? ` · ${metrics.cpu_count} cores` : ''}`,
        },
        {
            label: 'Memory',
            value:
                metrics?.memory_used_percent != null
                    ? `${metrics.memory_used_percent.toFixed(1)}%`
                    : '—',
            percent: metrics?.memory_used_percent ?? null,
            high: health.memoryHigh,
            flag: 'High',
            note: 'of system memory used',
        },
        {
            label: 'System disk',
            value:
                metrics?.root_used_percent != null
                    ? `${metrics.root_used_percent}%`
                    : '—',
            percent: metrics?.root_used_percent ?? null,
            high: health.diskHigh,
            flag: 'Full',
            note:
                metrics?.root_free_bytes != null
                    ? `${bytes(metrics.root_free_bytes)} free`
                    : 'Free space unavailable',
        },
        {
            label: 'Throttling',
            value:
                metrics?.throttled_flags == null
                    ? '—'
                    : health.currentFlags.length
                      ? `${health.currentFlags.length} ${health.currentFlags.length === 1 ? 'flag' : 'flags'}`
                      : 'Clear',
            percent: null,
            high: health.currentFlags.length > 0,
            flag: 'Active',
            note:
                metrics?.throttled_flags == null
                    ? 'Flags unavailable'
                    : health.currentFlags.length
                      ? health.currentFlags.join(' · ')
                      : health.pastFlags.length
                        ? `OK · earlier ${health.pastFlags.join(', ')}`
                        : 'No flags raised',
        },
    ];

    return (
        <section className="uc-health-tiles" aria-label="Device health">
            {tiles.map((tile) => {
                const high = tile.high && !health.stale;
                const percent = Math.max(0, Math.min(100, tile.percent ?? 0));

                return (
                    <div
                        key={tile.label}
                        className={`uc-health-tile ${high ? 'uc-health-high' : ''} ${health.stale ? 'uc-health-stale' : ''}`}
                    >
                        <div className="uc-panel-heading">
                            <h2 className="uc-label uc-muted">{tile.label}</h2>
                            <span
                                className={`uc-label uc-health-flag ${high ? 'uc-inverse' : 'uc-muted'}`}
                            >
                                {tile.value === '—'
                                    ? 'No data'
                                    : health.stale
                                      ? 'Stale'
                                      : high
                                        ? tile.flag
                                        : 'OK'}
                            </span>
                        </div>
                        <div className="uc-health-value">{tile.value}</div>
                        {tile.label !== 'Throttling' && (
                            <div
                                className="uc-meter-track"
                                role="meter"
                                aria-label={tile.label}
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-valuenow={percent}
                                aria-valuetext={
                                    tile.value === '—'
                                        ? 'Not reported'
                                        : `${tile.value}${health.stale ? ' · stale' : ''}`
                                }
                            >
                                {Array.from({ length: 16 }, (_, index) => (
                                    <span
                                        key={index}
                                        className={`uc-meter-seg ${index < Math.ceil((percent / 100) * 16) ? 'uc-meter-seg-on' : ''}`}
                                    />
                                ))}
                            </div>
                        )}
                        <div
                            className="uc-data uc-muted uc-ellipsis"
                            title={tile.note}
                        >
                            {tile.note}
                        </div>
                    </div>
                );
            })}
        </section>
    );
}
function DeviceSummary({
    device,
    defaults,
}: {
    device: Device;
    defaults: CloudSettings;
}) {
    const health = deviceHealth(
        device.metrics,
        device.status === 'offline',
        device.health_warnings,
    );
    const autoSync = device.config.auto_sync ?? defaults.auto_pull;
    const interval =
        device.config.auto_sync == null
            ? defaults.pull_interval
            : device.config.interval;
    const connection = `${device.config.user}@${device.config.host}:${device.config.port}`;
    const items = [
        {
            label: 'Health',
            value: health.label,
            title: health.summary,
            accent: !health.stale && !health.attention && health.hasMetrics,
        },
        {
            label: 'Snapshot',
            value: device.snapshot ? 'Open' : 'Closed',
            title: device.snapshot
                ? `Open · lease expires ${new Date(device.snapshot.expires_at * 1000).toLocaleTimeString()}`
                : `Closed · ${device.config.snapshot_timeout} s idle limit`,
        },
        {
            label: 'Auto sync',
            value: autoSync
                ? interval === 60
                    ? 'Every minute'
                    : `Every ${interval % 60 === 0 ? `${interval / 60} min` : `${interval} s`}`
                : 'Paused',
            title: nextSync(device, defaults),
        },
        {
            label: 'Last sync',
            value: ago(device.last_sync),
            title: date(device.last_sync),
        },
        { label: 'Connection', value: connection, title: connection },
    ];

    return (
        <section className="uc-device-status" aria-label="Device status">
            <div className="uc-device-identity">
                <span className="uc-data uc-accent">{device.id}</span>
                <Badge status={device.status} />
            </div>
            <dl>
                {items.map((item) => (
                    <div key={item.label}>
                        <dt className="uc-label uc-muted">{item.label}</dt>
                        <dd
                            className={`uc-data uc-ellipsis ${item.accent ? 'uc-accent' : item.label === 'Health' && health.stale ? 'uc-muted' : ''}`}
                            title={item.title}
                        >
                            {item.value}
                        </dd>
                    </div>
                ))}
            </dl>
        </section>
    );
}
function LogPane({
    entries,
    title,
    overview = false,
    actions,
}: {
    entries: LogEntry[];
    title: string;
    overview?: boolean;
    actions?: ReactNode;
}) {
    const [follow, setFollow] = useState(true);
    const [wrap, setWrap] = useState(true);
    const body = useRef<HTMLDivElement>(null);
    const last = entries.at(-1);
    useEffect(() => {
        const pane = body.current;
        if (!follow || !pane) return;
        const scrollToLatest = () => {
            pane.scrollTop = pane.scrollHeight;
        };
        scrollToLatest();
        const observer = new ResizeObserver(scrollToLatest);
        observer.observe(pane);
        return () => observer.disconnect();
    }, [follow, wrap, last?.at, last?.message, entries.length]);
    return (
        <section
            className={`uc-log ${wrap ? '' : 'uc-log-no-wrap'} ${overview ? 'uc-log-overview' : ''}`}
        >
            <header className="uc-log-head">
                <div className="uc-inline">
                    <span className="uc-label">{title}</span>
                    {overview && (
                        <span className="uc-label uc-log-count">
                            {entries.length} entries
                        </span>
                    )}
                </div>
                <div className="uc-inline uc-log-controls">
                    {!overview && (
                        <span className="uc-label uc-log-count">
                            {entries.length} entries
                        </span>
                    )}
                    <label className="uc-label uc-inline">
                        <input
                            type="checkbox"
                            checked={wrap}
                            onChange={(event) => setWrap(event.target.checked)}
                        />
                        Wrap
                    </label>
                    <label className="uc-label uc-inline">
                        <input
                            type="checkbox"
                            checked={follow}
                            onChange={(event) =>
                                setFollow(event.target.checked)
                            }
                        />
                        Follow
                    </label>
                    {actions}
                </div>
            </header>
            <div
                ref={body}
                tabIndex={0}
                aria-label={`${title} entries`}
                className="uc-log-body uc-data"
                onWheel={(event) => {
                    if (event.deltaY < 0) setFollow(false);
                }}
                onKeyDown={(event) => {
                    if (['ArrowUp', 'PageUp', 'Home'].includes(event.key))
                        setFollow(false);
                }}
                onPointerDown={(event) => {
                    if (event.target === event.currentTarget) setFollow(false);
                }}
            >
                {!entries.length && (
                    <p className="uc-log-empty">
                        0 entries. Scan or pull a device to collect logs.
                    </p>
                )}
                {entries.map((entry, i) => (
                    <div
                        key={`${entry.at}-${i}`}
                        className={`uc-log-line uc-log-${entry.level}`}
                    >
                        <time className="uc-log-time" title={date(entry.at)}>
                            {new Date(entry.at).toLocaleTimeString([], {
                                hour12: false,
                            })}
                        </time>
                        <span className="uc-log-level">
                            {entry.level.toUpperCase()}
                        </span>
                        <span
                            className="uc-log-source"
                            title={`${entry.source} · ${entry.origin}`}
                        >
                            {entry.source}
                        </span>
                        <span className="uc-log-msg">
                            {entry.origin === 'server' && entry.device
                                ? `[${entry.device}] `
                                : ''}
                            {entry.origin === 'client' ? '[client] ' : ''}
                            {entry.message}
                        </span>
                    </div>
                ))}
                <div className="uc-log-prompt" aria-hidden="true">
                    &gt; <span className="uc-log-cursor" />
                </div>
            </div>
        </section>
    );
}

type DeviceConfig = {
    name: string;
    host: string;
    port: number;
    user: string;
    site: string;
    auto_sync: boolean | null;
    interval: number;
    bandwidth: number;
    snapshot_timeout: number;
    retry_count: number;
    retry_delay: number;
};
type Transfer = {
    token?: string;
    started_at?: string;
    state: string;
    stage: string;
    current_file: string | null;
    current_bytes: number;
    current_total: number;
    done_bytes: number;
    total_bytes: number;
    done_files: number;
    total_files: number;
    skipped: number;
    rate: number;
    eta: number | null;
    error: string | null;
};
type TransferAction = 'start' | 'pause' | 'resume' | 'cancel';
const isActive = (t: Transfer | null) =>
    !!t && ['queued', 'running', 'pausing', 'cancelling'].includes(t.state);
const nextSync = (device: Device, defaults: CloudSettings) =>
    device.transfer?.state === 'paused'
        ? 'Paused · resume manually'
        : isActive(device.transfer)
          ? 'Running now'
          : !(device.config.auto_sync ?? defaults.auto_pull)
            ? 'Manual only'
            : device.next_sync
              ? `in ${Math.max(0, Math.ceil((Date.parse(device.next_sync) - Date.now()) / 1000))} s`
              : 'Waiting for scheduler';
const isVideo = (file: StoredFile) => /\.(mp4|webm|mov|m4v)$/i.test(file.name);
const kind = (file: StoredFile) =>
    isVideo(file)
        ? 'video'
        : /\.(mp3|wav|ogg|m4a)$/i.test(file.name)
          ? 'audio'
          : /\.(png|jpe?g|gif|webp)$/i.test(file.name)
            ? 'image'
            : /\.(pdf|txt|docx?)$/i.test(file.name)
              ? 'doc'
              : 'data';
const duration = (value: number | null | undefined) =>
    value == null
        ? '—'
        : `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
function ProgressMeter({
    label,
    value,
    max,
    caption,
}: {
    label: string;
    value: number;
    max: number;
    caption?: string;
}) {
    const pct = Math.min(100, max > 0 ? (value / max) * 100 : 0);
    return (
        <div className="uc-meter">
            <div className="uc-meter-head">
                <span className="uc-label uc-muted">{label}</span>
                <span className="uc-data">
                    {caption ?? `${Math.round(pct)}%`}
                </span>
            </div>
            <div
                className="uc-meter-track"
                role="progressbar"
                aria-label={label}
                aria-valuemin={0}
                aria-valuemax={Math.max(1, max)}
                aria-valuenow={Math.max(0, Math.min(value, max))}
            >
                {Array.from({ length: 32 }, (_, i) => (
                    <span
                        key={i}
                        className={`uc-meter-seg ${i < Math.ceil((pct / 100) * 32) ? 'uc-meter-seg-on' : ''}`}
                    />
                ))}
            </div>
        </div>
    );
}
function Select({
    label,
    value,
    onChange,
    options,
    disabled,
}: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    options: [string, string][];
    disabled?: boolean;
}) {
    return (
        <MultiSelect
            label={label}
            values={[value]}
            options={options}
            multiple={false}
            disabled={disabled}
            onChange={(values) => onChange(values[0])}
        />
    );
}

function Details({ items }: { items: [string, ReactNode][] }) {
    return (
        <dl className="uc-detail-list uc-data">
            {items.map(([label, value]) => (
                <div key={label}>
                    <dt className="uc-label uc-muted">{label}</dt>
                    <dd>{value ?? '—'}</dd>
                </div>
            ))}
        </dl>
    );
}
function TransferPanel({
    device,
    onControl,
    disabled,
    theme,
}: {
    device: Device;
    onControl: (action: TransferAction, id?: string) => void;
    disabled: boolean;
    theme: Theme;
}) {
    const t = device.transfer;
    if (!t || ['completed', 'cancelled'].includes(t.state)) return null;
    return (
        <section
            className="uc-detail-card uc-transfer"
            aria-label={`${device.id} transfer`}
        >
            <div className="uc-between">
                <h2 className="uc-label uc-accent">{t.stage}</h2>
                <span className="uc-data uc-muted">{bytes(t.rate)}/s</span>
            </div>
            <p className="uc-data uc-break">
                {t.current_file ??
                    (t.state === 'queued'
                        ? 'Waiting for the background worker…'
                        : 'Checking for new files')}
            </p>
            <ProgressMeter
                label="This file"
                value={t.current_bytes}
                max={t.current_total}
                caption={`${bytes(t.current_bytes)} of ${bytes(t.current_total)}`}
            />
            <ProgressMeter
                label="Files"
                value={t.done_bytes}
                max={t.total_bytes}
                caption={`${t.done_files} / ${t.total_files} · ${bytes(t.done_bytes)} / ${bytes(t.total_bytes)}`}
            />
            <Details
                items={[
                    [
                        'Remaining',
                        `${Math.max(0, t.total_files - t.done_files)} files · ${bytes(Math.max(0, t.total_bytes - t.done_bytes - t.current_bytes))}`,
                    ],
                    [
                        'ETA',
                        t.eta == null ? '—' : `${Math.ceil(t.eta / 60)} min`,
                    ],
                    ['Skipped', `${t.skipped} already saved`],
                ]}
            />
            {t.error && !['paused', 'cancelled'].includes(t.state) && (
                <div className="uc-data" role="alert">
                    <ErrorSummary message={t.error} theme={theme} />
                </div>
            )}
            <div className="uc-card-actions">
                {['running', 'queued'].includes(t.state) && (
                    <Button
                        small
                        variant="ghost"
                        disabled={disabled}
                        onClick={() => onControl('pause', device.id)}
                    >
                        <Pause size={14} />
                        Pause
                    </Button>
                )}
                {['paused', 'failed', 'cancelled'].includes(t.state) && (
                    <Button
                        small
                        variant="primary"
                        disabled={disabled}
                        onClick={() => onControl('resume', device.id)}
                    >
                        <Play size={14} />
                        Resume
                    </Button>
                )}
                {(isActive(t) || t.state === 'paused') && (
                    <Button
                        small
                        disabled={
                            disabled ||
                            ['pausing', 'cancelling'].includes(t.state)
                        }
                        onClick={() => onControl('cancel', device.id)}
                    >
                        <X size={14} />
                        Stop
                    </Button>
                )}
            </div>
            {t.state === 'paused' && (
                <p className="uc-input-hint">
                    Snapshot closed. Resume skips verified files and restarts
                    the unfinished file.
                </p>
            )}
        </section>
    );
}
function MediaPlayer({ file }: { file: StoredFile }) {
    const video = useRef<HTMLVideoElement>(null);
    const [failed, setFailed] = useState(false);
    const src = downloadFile.url(file.id, { query: { preview: true } });
    if (file.state !== 'pulled')
        return (
            <div className="uc-media-empty uc-data">
                {file.state === 'failed'
                    ? (file.error ?? 'Transfer failed. Retry the pull.')
                    : 'Pull this file to play it from the server.'}
                {file.progress != null && (
                    <ProgressMeter
                        label="File transfer"
                        value={file.progress}
                        max={file.bytes}
                    />
                )}
            </div>
        );
    return (
        <div className="uc-player">
            {kind(file) === 'video' ? (
                <>
                    <video
                        ref={video}
                        key={file.id}
                        controls
                        playsInline
                        preload="metadata"
                        src={src}
                        onError={() => setFailed(true)}
                        onLoadedMetadata={() => setFailed(false)}
                    >
                        <track kind="captions" />
                    </video>
                    <div className="uc-player-extra">
                        <Button
                            small
                            variant="ghost"
                            onClick={() => {
                                if (video.current)
                                    video.current.currentTime = Math.max(
                                        0,
                                        video.current.currentTime - 10,
                                    );
                            }}
                        >
                            −10 s
                        </Button>
                        <Button
                            small
                            variant="ghost"
                            onClick={() => {
                                if (video.current)
                                    video.current.currentTime = Math.min(
                                        video.current.duration || Infinity,
                                        video.current.currentTime + 10,
                                    );
                            }}
                        >
                            +10 s
                        </Button>
                    </div>
                </>
            ) : kind(file) === 'image' ? (
                <img src={src} alt={file.name} />
            ) : kind(file) === 'audio' ? (
                <audio controls src={src}>
                    <track kind="captions" />
                </audio>
            ) : (
                <div className="uc-media-empty uc-data">
                    Preview unavailable for this file type. Download to open.
                </div>
            )}
            {failed && (
                <p className="uc-data" role="alert">
                    This browser could not play the clip.{' '}
                    <a href={downloadFile.url(file.id)}>
                        Download the original
                    </a>
                    .
                </p>
            )}
        </div>
    );
}
const dateOptions: [string, string][] = [
    ['any', 'Any time'],
    ['today', 'Today'],
    ['yesterday', 'Yesterday'],
    ['week', 'Last 7 days'],
];
function dateMatches(value: string, at: string | null) {
    if (value === 'any') return true;
    if (!at) return false;
    const current = new Date();
    const stamp = new Date(at);
    if (value === 'week')
        return stamp.getTime() >= current.getTime() - 7 * 86400000;
    if (value === 'yesterday') current.setDate(current.getDate() - 1);
    return current.toDateString() === stamp.toDateString();
}

async function json<T>(
    url: string,
    method = 'GET',
    data?: unknown,
): Promise<T> {
    const csrf = document.cookie
        .split('; ')
        .find((cookie) => cookie.startsWith('XSRF-TOKEN='))
        ?.slice(11);
    const response = await fetch(url, {
        method,
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-XSRF-TOKEN': decodeURIComponent(csrf ?? ''),
        },
        ...(data ? { body: JSON.stringify(data) } : {}),
    });
    const result = await response.json();
    if (!response.ok)
        throw new Error(result.message ?? 'Request failed. Retry.');
    return result as T;
}
function DeviceSettings({
    device,
    cloud,
    onMessage,
    onRemove,
}: {
    device: Device;
    cloud: Cloud;
    onMessage: (text: string, error?: boolean) => void;
    onRemove: () => void;
}) {
    const form = useHttp<DeviceConfig, { settings: DeviceConfig }>({
        ...device.config,
        auto_sync: device.config.auto_sync ?? cloud.settings.auto_pull,
    });
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState('');
    const input = (
        key: 'name' | 'host' | 'site' | 'user' | 'port' | 'retry_count',
        label: string,
        type = 'text',
    ) => (
        <Field label={label} error={form.errors[key]}>
            <div className="uc-field">
                <input
                    type={type}
                    required={key !== 'site'}
                    value={form.data[key]}
                    min={key === 'port' ? 1 : 0}
                    max={
                        key === 'port'
                            ? 65535
                            : key === 'retry_count'
                              ? 10
                              : undefined
                    }
                    onChange={(e) =>
                        form.setData(
                            key,
                            (type === 'number'
                                ? Number(e.target.value)
                                : e.target.value) as never,
                        )
                    }
                />
            </div>
        </Field>
    );
    const option = (
        key: 'interval' | 'bandwidth' | 'snapshot_timeout' | 'retry_delay',
        label: string,
        options: [string, string][],
        disabled = false,
    ) => (
        <div>
            <Select
                label={label}
                value={String(form.data[key])}
                options={options}
                onChange={(value) => form.setData(key, Number(value))}
                disabled={disabled}
            />
            {form.errors[key] && (
                <p className="uc-data" role="alert">
                    {form.errors[key]}
                </p>
            )}
        </div>
    );
    async function test() {
        setTesting(true);
        setTestResult('Opening SSH connection…');
        try {
            const result = await json<{
                milliseconds: number;
                state: { version: string };
            }>(testDevice.url(device.id), 'POST', form.data);
            setTestResult(
                `Connected in ${result.milliseconds} ms · agent ${result.state.version}`,
            );
        } catch (e) {
            setTestResult(
                e instanceof Error ? e.message : 'Connection failed. Retry.',
            );
        } finally {
            setTesting(false);
        }
    }
    return (
        <div className="uc-device-settings">
            <form
                className="uc-settings"
                onSubmit={async (e) => {
                    e.preventDefault();
                    try {
                        const result = await form.put(
                            updateDevice.url(device.id),
                        );
                        form.setDefaults(result.settings);
                        form.setData(result.settings);
                        onMessage(
                            'Device settings saved. Changes apply from the next sync.',
                        );
                        router.reload({ only: ['cloud'] });
                    } catch {
                        onMessage(
                            'Device settings could not be saved. Check the fields and retry.',
                            true,
                        );
                    }
                }}
            >
                <section>
                    <h2 className="uc-heading">Identity</h2>
                    {input('name', 'Device name')}
                    {input('site', 'Site')}
                    <p className="uc-input-hint">
                        Optional location label for grouping and filtering
                        devices, such as Garage or Office.
                    </p>
                    <p className="uc-input-hint">
                        Device ID {device.id}. Saved files remain associated
                        with this ID.
                    </p>
                </section>
                <section>
                    <h2 className="uc-heading">Connection</h2>
                    {input('host', 'Pi hostname or IP')}
                    <div className="uc-two-fields">
                        {input('port', 'SSH port', 'number')}
                        {input('user', 'Username')}
                    </div>
                    <p className="uc-input-hint">
                        Uses the server’s existing SSH key and trusted host
                        keys.
                    </p>
                    <div className="uc-inline">
                        <Button
                            disabled={testing || form.processing}
                            onClick={() => void test()}
                        >
                            <PlugZap size={14} />
                            {testing ? 'Testing…' : 'Test connection'}
                        </Button>
                        <span className="uc-data uc-break" role="status">
                            {testResult}
                        </span>
                    </div>
                </section>
                <section>
                    <h2 className="uc-heading">Sync</h2>
                    <label className="uc-switch-row">
                        <span>
                            <span className="uc-label">Automatic sync</span>
                            <span className="uc-input-hint">
                                {form.data.auto_sync
                                    ? 'Retrieve clips on the interval below.'
                                    : 'Paused · manual pulls remain available.'}
                            </span>
                        </span>
                        <input
                            type="checkbox"
                            role="switch"
                            aria-label="Automatic sync"
                            checked={!!form.data.auto_sync}
                            onChange={(e) =>
                                form.setData('auto_sync', e.target.checked)
                            }
                        />
                    </label>
                    <div className="uc-two-fields">
                        {option(
                            'interval',
                            'Sync interval',
                            [
                                ['30', 'Every 30 s'],
                                ['60', 'Every minute'],
                                ['300', 'Every 5 min'],
                                ['900', 'Every 15 min'],
                                ['3600', 'Every hour'],
                                ['21600', 'Every 6 h'],
                            ],
                            !form.data.auto_sync,
                        )}
                        {option('bandwidth', 'Bandwidth limit', [
                            ['0', 'Unlimited'],
                            ['0.5', '500 KB/s'],
                            ['1', '1 MB/s'],
                            ['2', '2 MB/s'],
                            ['5', '5 MB/s'],
                            ['10', '10 MB/s'],
                            ['25', '25 MB/s'],
                        ])}
                    </div>
                </section>
                <section>
                    <h2 className="uc-heading">Snapshot</h2>
                    {option('snapshot_timeout', 'Snapshot timeout', [
                        ['60', '1 min'],
                        ['300', '5 min'],
                        ['600', '10 min'],
                        ['900', '15 min'],
                        ['1800', '30 min'],
                        ['3600', '1 h'],
                    ])}
                    <p className="uc-input-hint">
                        The attached device keeps writing while the server reads
                        a read-only snapshot. The lease expires after this time;
                        retry retrieves remaining files.
                    </p>
                </section>
                <section>
                    <h2 className="uc-heading">Retry policy</h2>
                    <div className="uc-two-fields">
                        {input('retry_count', 'Retry count', 'number')}
                        {option('retry_delay', 'Retry delay', [
                            ['5', '5 s'],
                            ['15', '15 s'],
                            ['30', '30 s'],
                            ['60', '1 min'],
                            ['300', '5 min'],
                        ])}
                    </div>
                    <p className="uc-input-hint">
                        0 gives up after the first failure. Verified files are
                        skipped on retry.
                    </p>
                </section>
                <div className="uc-settings-actions">
                    <span className="uc-data uc-muted">
                        {form.isDirty ? 'Unsaved changes' : ''}
                    </span>
                    <Button
                        disabled={!form.isDirty || form.processing}
                        onClick={() => {
                            form.reset();
                            form.clearErrors();
                        }}
                    >
                        Discard
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        disabled={!form.isDirty || form.processing}
                    >
                        <Check size={14} />
                        {form.processing ? 'Saving…' : 'Save settings'}
                    </Button>
                </div>
            </form>
            <aside className="uc-details">
                <section className="uc-detail-card">
                    <h2 className="uc-label uc-muted">In effect now</h2>
                    <Details
                        items={[
                            [
                                'Auto sync',
                                (device.config.auto_sync ??
                                cloud.settings.auto_pull)
                                    ? `Every ${device.config.auto_sync == null ? cloud.settings.pull_interval : device.config.interval} s`
                                    : 'Paused',
                            ],
                            ['Next sync', nextSync(device, cloud.settings)],
                            [
                                'Bandwidth',
                                device.config.bandwidth
                                    ? `${device.config.bandwidth} MB/s`
                                    : 'Unlimited',
                            ],
                            [
                                'Snapshot',
                                device.snapshot
                                    ? 'Open'
                                    : `Closed · ${device.config.snapshot_timeout} s limit`,
                            ],
                            [
                                'Retries',
                                `${device.config.retry_count} × ${device.config.retry_delay} s`,
                            ],
                        ]}
                    />
                    <p className="uc-input-hint">
                        Changes apply from the next sync. A running transfer
                        uses its original limits.
                    </p>
                </section>
                <section className="uc-detail-card">
                    <h2 className="uc-label uc-muted">Remove</h2>
                    <p className="uc-data">
                        Takes the device out of the fleet. Pulled files stay on
                        the server; the Pi stays running.
                    </p>
                    <Button
                        small
                        variant="inverse"
                        disabled={
                            isActive(device.transfer) || !!device.operation
                        }
                        onClick={onRemove}
                    >
                        <Trash2 size={14} />
                        Remove device
                    </Button>
                </section>
            </aside>
        </div>
    );
}

export default function UsbCloudPage({ cloud }: { cloud: Cloud }) {
    const [screen, setScreen] = useState<Screen>('devices');
    const [tab, setTab] = useState('all');
    const [deviceTab, setDeviceTab] = useState('overview');
    const [selected, setSelected] = useState(cloud.devices[0]?.id ?? '');
    const [fileTab, setFileTab] = useState('pending');
    const [filters, setFilters] = useState<
        Record<string, Record<string, string>>
    >({});
    const [filterOpen, setFilterOpen] = useState<Record<string, boolean>>({});
    const [mobileNav, setMobileNav] = useState(false);
    const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
    const [previewId, setPreviewId] = useState('');
    const [galleryId, setGalleryId] = useState('');
    const [message, setMessage] = useState('');
    const [error, setError] = useState(false);
    const [working, setWorking] = useState('');
    const operationRef = useRef(false);
    const [unmount, setUnmount] = useState<Device | null>(null);
    const [remove, setRemove] = useState<Device | null>(null);
    const [addOpen, setAddOpen] = useState(false);
    const [scanBusy, setScanBusy] = useState(false);
    const [found, setFound] = useState<
        { host: string; port: number; id?: string; name?: string }[]
    >([]);
    const [scanMessage, setScanMessage] = useState('');
    const [addForm, setAddForm] = useState({
        host: '',
        port: 22,
        user: 'pi',
        name: '',
    });
    const [addError, setAddError] = useState('');
    const [storageSize, setStorageSize] = useState('');
    const [installerProfile, setInstallerProfile] = useState(
        cloud.server.installer_profiles[0]?.id ?? '',
    );
    const selectedInstallerProfile = cloud.server.installer_profiles.find(
        (profile) => profile.id === installerProfile,
    );
    const [existingClient, setExistingClient] = useState(false);
    const [installation, setInstallation] = useState<{
        command: string;
        expires_at: string;
    } | null>(null);
    const [copyMessage, setCopyMessage] = useState('');
    useEffect(() => {
        setInstallation(null);
        setCopyMessage('');
    }, [addForm, storageSize, installerProfile, existingClient, addOpen]);
    const [dismissedTransfers, setDismissedTransfers] =
        useState<TransferDismissals>(() => {
            try {
                return parseTransferDismissals(
                    localStorage.getItem(transferDismissalsKey),
                );
            } catch {
                return {};
            }
        });
    const [logRows, setLogRows] = useState<LogRowState[]>([
        { id: 'row-0', panes: [{ id: 'pane-0', source: 'server' }] },
    ]);
    const nextLogId = useRef(1);
    const notice = useRef<HTMLDivElement>(null);
    const settings = useHttp<CloudSettings, { settings: CloudSettings }>(
        cloud.settings,
    );
    const theme = settings.data.theme;
    const active =
        cloud.devices.find((d) => d.id === selected) ?? cloud.devices[0];
    const faultMessage = cloud.devices.find((d) => d.status === 'fault')?.error;
    const logDeviceKey = [
        ...new Set(
            screen === 'log'
                ? logRows
                      .flatMap((r) => r.panes.map((p) => p.source))
                      .filter((s) => s !== 'server')
                : screen === 'device' &&
                    active &&
                    ['overview', 'log'].includes(deviceTab)
                  ? [active.id]
                  : [],
        ),
    ]
        .sort()
        .join(',');
    usePoll(1500, () => ({
        only: ['cloud'],
        data: { log_devices: logDeviceKey ? logDeviceKey.split(',') : [] },
    }));
    useEffect(() => {
        if (logDeviceKey)
            router.reload({
                only: ['cloud'],
                data: { log_devices: logDeviceKey.split(',') },
            });
    }, [logDeviceKey]);
    const reload = () =>
        router.reload({
            only: ['cloud'],
            data: { log_devices: logDeviceKey ? logDeviceKey.split(',') : [] },
        });
    const notify = (text: string, failed = false) => {
        setMessage(text);
        setError(failed);
        requestAnimationFrame(() => notice.current?.focus());
    };
    const navigate = (next: Screen) => {
        setScreen(next);
        setMobileNav(false);
        setMessage('');
    };
    const openDevice = (id: string, tab = 'overview') => {
        setSelected(id);
        setDeviceTab(tab);
        navigate('device');
    };
    const getFilter = (page: string, key: string, fallback = 'any') =>
        filters[page]?.[key] ?? fallback;
    const setFilter = (page: string, key: string, value: string) =>
        setFilters((old) => ({
            ...old,
            [page]: { ...old[page], [key]: value },
        }));
    const filterCount = (page: string) =>
        Object.entries(filters[page] ?? {}).filter(
            ([key, value]) => key !== 'sort' && value !== '' && value !== 'any',
        ).length;
    const deviceOptions: [string, string][] = [
        ['any', 'Any device'],
        ...[
            ...new Set([
                ...cloud.devices.map((d) => d.id),
                ...cloud.files.map((f) => f.device),
            ]),
        ].map((id) => [id, id] as [string, string]),
    ];
    const pending = cloud.files.filter((f) =>
        ['pending', 'queued'].includes(f.state),
    ).length;
    const inflight = cloud.devices.filter(
        (d) => isActive(d.transfer) || d.transfer?.state === 'paused',
    );
    const doneBytes = inflight.reduce(
        (n, d) =>
            n +
            (d.transfer?.done_bytes ?? 0) +
            (d.transfer?.current_bytes ?? 0),
        0,
    );
    const totalBytes = inflight.reduce(
        (n, d) => n + (d.transfer?.total_bytes ?? 0),
        0,
    );
    const allTransfers = visibleTransferDevices(
        cloud.devices,
        dismissedTransfers,
    );
    const transferVisible = allTransfers.length > 0;
    function dismissFinishedTransfers() {
        const next = dismissTransferRuns(allTransfers, dismissedTransfers);
        setDismissedTransfers(next);
        try {
            localStorage.setItem(transferDismissalsKey, JSON.stringify(next));
        } catch {
            // Keep dismissal working in this page when browser storage is unavailable.
        }
    }
    const hasRunning = inflight.some((d) => isActive(d.transfer));
    const hasPaused = inflight.some((d) => d.transfer?.state === 'paused');
    const downloadable = selectedFiles.filter((id) =>
        cloud.files.some((f) => f.id === id && f.state === 'pulled'),
    );
    async function perform(label: string, action: () => Promise<void>) {
        if (operationRef.current) return;
        operationRef.current = true;
        setWorking(label);
        setMessage('');
        setError(false);
        try {
            await action();
        } catch (e) {
            notify(
                e instanceof Error ? e.message : 'Request failed. Retry.',
                true,
            );
        } finally {
            operationRef.current = false;
            setWorking('');
            reload();
        }
    }
    async function control(action: TransferAction, id?: string) {
        await perform(`${id ?? 'Fleet'}: ${action}…`, async () => {
            for (const device of id?.split('|') ?? [undefined]) {
                await json(transfer.url(), 'POST', { action, device });
            }
            notify(
                action === 'start'
                    ? 'Pull queued. Progress appears below.'
                    : `${action === 'cancel' ? 'Stop' : action.charAt(0).toUpperCase() + action.slice(1)} requested.`,
            );
        });
    }
    async function run(action: DeviceAction, id?: string) {
        if (action === 'pull') {
            await control('start', id);
            return;
        }
        await perform(`${id ?? 'Fleet'}: ${action}…`, async () => {
            const csrf = document.cookie
                .split('; ')
                .find((c) => c.startsWith('XSRF-TOKEN='))
                ?.slice(11);
            const response = await fetch(operate.url(), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    'X-XSRF-TOKEN': decodeURIComponent(csrf ?? ''),
                },
                body: JSON.stringify({ action, device: id }),
            });
            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.message ?? 'Device request failed.');
            }
            const events = (await response.text())
                .trim()
                .split('\n')
                .map(
                    (line) =>
                        JSON.parse(line) as {
                            type: string;
                            message: string;
                            success: boolean;
                        },
                )
                .filter((e) => e.type === 'result');
            if (!events.length)
                throw new Error(
                    'Connection ended before a result arrived. Refresh to check the device.',
                );
            notify(
                events.map((e) => e.message).join(' '),
                events.some((e) => !e.success),
            );
        });
    }
    async function scan() {
        setScanBusy(true);
        setScanMessage('Listening for USBCloud clients on the local network…');
        try {
            const result = await json<{
                devices: typeof found;
                message: string;
            }>(discover.url());
            setFound(result.devices);
            setScanMessage(result.message);
        } catch (e) {
            setScanMessage(
                e instanceof Error ? e.message : 'Discovery failed. Retry.',
            );
        } finally {
            setScanBusy(false);
        }
    }
    function showFiles(id: string) {
        navigate('files');
        setFilter('files', 'device', id);
        setFileTab('all');
        setFilterOpen((old) => ({ ...old, files: true }));
    }
    const matches = (
        page: string,
        key: string,
        predicate: (value: string) => boolean,
    ) =>
        getFilter(page, key)
            .split('|')
            .map(decodeURIComponent)
            .some((value) => value === 'any' || predicate(value));
    const deviceRows = cloud.devices
        .filter((d) => {
            const q = getFilter('devices', 'q', '').toLowerCase();
            const fs = d.filesystem;
            const used =
                fs && fs.total_bytes > 0
                    ? fs.used_bytes / fs.total_bytes
                    : null;
            return (
                (tab === 'all' ||
                    (tab === 'syncing'
                        ? isActive(d.transfer) || d.transfer?.state === 'paused'
                        : d.status === tab)) &&
                `${d.id} ${d.name} ${d.address} ${d.hostname ?? ''}`
                    .toLowerCase()
                    .includes(q) &&
                matches('devices', 'site', (v) => d.config.site === v) &&
                matches('devices', 'firmware', (v) =>
                    v === 'current'
                        ? d.firmware === cloud.server.client_version
                        : d.firmware !== cloud.server.client_version,
                ) &&
                matches(
                    'devices',
                    'storage',
                    (v) =>
                        used != null &&
                        (v === 'under50'
                            ? used < 0.5
                            : used >= Number(v) / 100),
                ) &&
                matches('devices', 'pending', (v) =>
                    v === 'some' ? (d.pending ?? 0) > 0 : d.pending === 0,
                ) &&
                matches(
                    'devices',
                    'auto',
                    (v) =>
                        (v === 'on') ===
                        (d.config.auto_sync ?? cloud.settings.auto_pull),
                )
            );
        })
        .sort((a, b) => {
            switch (getFilter('devices', 'sort', 'id')) {
                case 'name':
                    return a.name.localeCompare(b.name);
                case 'pending':
                    return (b.pending ?? -1) - (a.pending ?? -1);
                case 'used':
                    return (
                        (b.filesystem
                            ? b.filesystem.used_bytes / b.filesystem.total_bytes
                            : 0) -
                        (a.filesystem
                            ? a.filesystem.used_bytes / a.filesystem.total_bytes
                            : 0)
                    );
                case 'status':
                    return (
                        ['fault', 'offline', 'syncing', 'online'].indexOf(
                            a.status,
                        ) -
                        ['fault', 'offline', 'syncing', 'online'].indexOf(
                            b.status,
                        )
                    );
                default:
                    return a.id.localeCompare(b.id);
            }
        });
    function filterFiles(page: string, source: StoredFile[]) {
        return source
            .filter((f) => {
                const q = getFilter(page, 'q', '').toLowerCase();
                const secs = f.media?.duration;
                return (
                    `${f.name} ${f.device}`.toLowerCase().includes(q) &&
                    matches(page, 'device', (v) => f.device === v) &&
                    matches(page, 'type', (v) => kind(f) === v) &&
                    matches(page, 'date', (v) =>
                        dateMatches(v, f.modified_at ?? f.saved_at),
                    ) &&
                    matches(page, 'size', (v) =>
                        v === 'small'
                            ? f.bytes < 1e7
                            : f.bytes >= Number(v) * 1e6,
                    ) &&
                    matches(
                        page,
                        'length',
                        (v) =>
                            secs != null &&
                            (v === 'short'
                                ? secs < 30
                                : v === 'medium'
                                  ? secs >= 30 && secs < 120
                                  : secs >= 120),
                    ) &&
                    matches(page, 'state', (v) => f.state === v)
                );
            })
            .sort((a, b) => {
                const time = (f: StoredFile) =>
                    Date.parse(f.modified_at ?? f.saved_at ?? '') || 0;
                switch (getFilter(page, 'sort', 'newest')) {
                    case 'oldest':
                        return time(a) - time(b);
                    case 'largest':
                        return b.bytes - a.bytes;
                    case 'name':
                        return a.name.localeCompare(b.name);
                    case 'device':
                        return (
                            a.device.localeCompare(b.device) ||
                            time(b) - time(a)
                        );
                    case 'longest':
                        return (
                            (b.media?.duration ?? -1) -
                            (a.media?.duration ?? -1)
                        );
                    default:
                        return time(b) - time(a);
                }
            });
    }
    const fileRows = filterFiles('files', cloud.files).filter(
        (f) =>
            fileTab === 'all' ||
            (fileTab === 'inflight'
                ? ['pulling', 'paused'].includes(f.state)
                : fileTab === 'pending'
                  ? ['pending', 'queued'].includes(f.state)
                  : f.state === fileTab),
    );
    const videos = filterFiles('gallery', cloud.files.filter(isVideo));
    const currentClip = videos.find((f) => f.id === galleryId) ?? videos[0];
    const currentIndex = currentClip
        ? videos.findIndex((f) => f.id === currentClip.id)
        : -1;
    const preview = cloud.files.find((f) => f.id === previewId);
    const title =
        screen === 'device'
            ? (active?.name ?? 'Device')
            : {
                  devices: 'Fleet overview',
                  files: 'Files',
                  gallery: 'Gallery',
                  log: 'Logs',
                  settings: 'Settings',
              }[screen];
    const fieldSelect = (
        page: string,
        key: string,
        label: string,
        options: [string, string][],
        fallback = 'any',
    ) => (
        <MultiSelect
            key={key}
            label={label}
            values={getFilter(page, key, fallback)
                .split('|')
                .map(decodeURIComponent)}
            options={options}
            multiple={key !== 'sort'}
            onChange={(values) =>
                setFilter(
                    page,
                    key,
                    values.length
                        ? values.map(encodeURIComponent).join('|')
                        : fallback,
                )
            }
        />
    );
    function filterBar(page: string) {
        return (
            filterOpen[page] && (
                <div className="uc-filter-bar">
                    <Field label="Search">
                        <div className="uc-field">
                            <Search size={14} />
                            <input
                                aria-label={
                                    page === 'devices'
                                        ? 'Search devices'
                                        : page === 'gallery'
                                          ? 'Search clips'
                                          : 'Search files'
                                }
                                value={getFilter(page, 'q', '')}
                                placeholder={
                                    page === 'devices'
                                        ? 'ID, name, host or address'
                                        : 'File name or path'
                                }
                                onChange={(e) =>
                                    setFilter(page, 'q', e.target.value)
                                }
                            />
                        </div>
                    </Field>
                    {page === 'devices' ? (
                        <>
                            {fieldSelect(page, 'site', 'Site', [
                                ['any', 'Any site'],
                                ...[
                                    ...new Set(
                                        cloud.devices
                                            .map((d) => d.config.site)
                                            .filter(Boolean),
                                    ),
                                ].map(
                                    (site) => [site, site] as [string, string],
                                ),
                            ])}
                            {fieldSelect(page, 'firmware', 'Firmware', [
                                ['any', 'Any version'],
                                [
                                    'current',
                                    `Current (${cloud.server.client_version})`,
                                ],
                                ['outdated', 'Needs update'],
                            ])}
                            {fieldSelect(page, 'storage', 'Storage', [
                                ['any', 'Any'],
                                ['under50', 'Under 50% used'],
                                ['75', 'Over 75% used'],
                                ['90', 'Over 90% used'],
                            ])}
                            {fieldSelect(page, 'pending', 'Pending', [
                                ['any', 'Any'],
                                ['some', 'Has pending files'],
                                ['none', 'Nothing pending'],
                            ])}
                            {fieldSelect(page, 'auto', 'Auto sync', [
                                ['any', 'Any'],
                                ['on', 'Enabled'],
                                ['off', 'Paused'],
                            ])}
                            {fieldSelect(
                                page,
                                'sort',
                                'Sort by',
                                [
                                    ['id', 'Device ID'],
                                    ['name', 'Name'],
                                    ['status', 'Status (worst first)'],
                                    ['pending', 'Most pending'],
                                    ['used', 'Fullest storage'],
                                ],
                                'id',
                            )}
                        </>
                    ) : (
                        <>
                            {fieldSelect(
                                page,
                                'device',
                                'Device',
                                deviceOptions,
                            )}
                            {page === 'files' &&
                                fieldSelect(page, 'type', 'Type', [
                                    ['any', 'Any type'],
                                    ['video', 'Video'],
                                    ['audio', 'Audio'],
                                    ['image', 'Images'],
                                    ['doc', 'Documents'],
                                    ['data', 'Data'],
                                ])}
                            {fieldSelect(
                                page,
                                'date',
                                page === 'gallery' ? 'Recorded' : 'Modified',
                                dateOptions,
                            )}
                            {page === 'files' ? (
                                fieldSelect(page, 'size', 'Size', [
                                    ['any', 'Any size'],
                                    ['small', 'Under 10 MB'],
                                    ['10', 'Over 10 MB'],
                                    ['100', 'Over 100 MB'],
                                    ['1000', 'Over 1 GB'],
                                ])
                            ) : (
                                <>
                                    {fieldSelect(page, 'length', 'Length', [
                                        ['any', 'Any length'],
                                        ['short', 'Under 30 s'],
                                        ['medium', '30 s – 2 min'],
                                        ['long', 'Over 2 min'],
                                    ])}
                                    {fieldSelect(page, 'state', 'State', [
                                        ['any', 'Any state'],
                                        ['pulled', 'Pulled'],
                                        ['pending', 'Pending'],
                                        ['pulling', 'Pulling'],
                                        ['paused', 'Paused'],
                                        ['failed', 'Failed'],
                                    ])}
                                </>
                            )}
                            {fieldSelect(
                                page,
                                'sort',
                                'Sort by',
                                [
                                    ['newest', 'Newest first'],
                                    ['oldest', 'Oldest first'],
                                    ['largest', 'Largest first'],
                                    ['name', 'Name'],
                                    ['device', 'Device'],
                                    ...(page === 'gallery'
                                        ? [
                                              ['longest', 'Longest first'] as [
                                                  string,
                                                  string,
                                              ],
                                          ]
                                        : []),
                                ],
                                'newest',
                            )}
                        </>
                    )}
                    <Button
                        variant="ghost"
                        onClick={() =>
                            setFilters((old) => ({ ...old, [page]: {} }))
                        }
                    >
                        <X size={14} />
                        Clear
                    </Button>
                </div>
            )
        );
    }
    function fileTable(
        rows: StoredFile[],
        caption: string,
        selectable = false,
        compact = false,
    ) {
        const hasDuration =
            !compact && rows.some((file) => file.media?.duration != null);
        return (
            <div
                className={`uc-table-wrap ${compact ? 'uc-recent-files' : ''}`}
            >
                <table className="uc-table uc-data">
                    <caption className="uc-label">{caption}</caption>
                    <thead>
                        <tr>
                            {selectable && (
                                <th>
                                    <input
                                        type="checkbox"
                                        aria-label="Select all downloadable files"
                                        checked={
                                            rows.some(
                                                (f) => f.state === 'pulled',
                                            ) &&
                                            rows
                                                .filter(
                                                    (f) => f.state === 'pulled',
                                                )
                                                .slice(0, 100)
                                                .every((f) =>
                                                    selectedFiles.includes(
                                                        f.id,
                                                    ),
                                                )
                                        }
                                        onChange={(e) =>
                                            setSelectedFiles(
                                                e.target.checked
                                                    ? rows
                                                          .filter(
                                                              (f) =>
                                                                  f.state ===
                                                                  'pulled',
                                                          )
                                                          .slice(0, 100)
                                                          .map((f) => f.id)
                                                    : [],
                                            )
                                        }
                                    />
                                </th>
                            )}
                            {[
                                'File',
                                'Device',
                                'Size',
                                ...(hasDuration ? ['Duration'] : []),
                                'Modified',
                                'State',
                            ].map((label) => (
                                <th
                                    key={label}
                                    scope="col"
                                    className={`uc-label ${['Size', 'Modified'].includes(label) ? 'uc-right' : ''}`}
                                >
                                    {label}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((f) => (
                            <tr
                                key={f.id}
                                className={
                                    previewId === f.id ? 'uc-tr-selected' : ''
                                }
                            >
                                {selectable && (
                                    <td>
                                        <input
                                            type="checkbox"
                                            aria-label={`Select ${f.name}`}
                                            disabled={
                                                f.state !== 'pulled' ||
                                                (!selectedFiles.includes(
                                                    f.id,
                                                ) &&
                                                    selectedFiles.length >= 100)
                                            }
                                            checked={selectedFiles.includes(
                                                f.id,
                                            )}
                                            onChange={(e) =>
                                                setSelectedFiles((old) =>
                                                    e.target.checked
                                                        ? [...old, f.id]
                                                        : old.filter(
                                                              (id) =>
                                                                  id !== f.id,
                                                          ),
                                                )
                                            }
                                        />
                                    </td>
                                )}
                                <td>
                                    <button
                                        type="button"
                                        className="uc-row-select uc-file-name"
                                        title={f.name}
                                        onClick={() => {
                                            setPreviewId(f.id);
                                            if (screen === 'device') {
                                                showFiles(f.device);
                                            }
                                        }}
                                    >
                                        {f.name.split('/').at(-1)}
                                    </button>
                                </td>
                                <td>{f.device}</td>
                                <td className="uc-right">{bytes(f.bytes)}</td>
                                {hasDuration && (
                                    <td className="uc-right uc-duration">
                                        {duration(f.media?.duration)}
                                    </td>
                                )}
                                <td
                                    className="uc-right uc-muted"
                                    title={date(f.modified_at)}
                                >
                                    {compact && f.modified_at
                                        ? new Date(
                                              f.modified_at,
                                          ).toLocaleDateString('en-CA')
                                        : date(f.modified_at)}
                                </td>
                                <td>
                                    <span
                                        className={`uc-label ${f.state === 'pulled' ? 'uc-accent' : ''}`}
                                    >
                                        {f.state}
                                    </span>
                                    {f.progress != null &&
                                        ['pulling', 'paused'].includes(
                                            f.state,
                                        ) && (
                                            <ProgressMeter
                                                label="File progress"
                                                value={f.progress}
                                                max={f.bytes}
                                            />
                                        )}
                                </td>
                            </tr>
                        ))}
                        {!rows.length && (
                            <tr>
                                <td
                                    colSpan={
                                        (selectable ? 6 : 5) +
                                        (hasDuration ? 1 : 0)
                                    }
                                    className="uc-table-empty"
                                >
                                    {compact
                                        ? 'No files pulled from this device yet.'
                                        : '0 files match. Pull from a device or adjust the filters.'}
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
        );
    }
    function deviceCard(d: Device) {
        return (
            <section className="uc-card uc-card-selected">
                <div className="uc-card-head">
                    <div>
                        <span className="uc-label uc-accent">
                            <HardDrive size={14} /> {d.id}
                        </span>
                        <h2 className="uc-heading">{d.name}</h2>
                    </div>
                    <Badge status={d.status} />
                </div>
                <Meter device={d} />
                <div className="uc-card-meta">
                    <Details
                        items={[
                            ['Last sync', ago(d.last_sync)],
                            [
                                'Pending',
                                d.pending == null
                                    ? 'Not scanned'
                                    : `${d.pending} files`,
                            ],
                        ]}
                    />
                </div>
                <div className="uc-card-actions">
                    <Button
                        small
                        variant="ghost"
                        disabled={!!working}
                        onClick={() => void run('refresh', d.id)}
                    >
                        <RefreshCw size={14} />
                        Refresh
                    </Button>
                    <Button
                        small
                        disabled={
                            !!working ||
                            isActive(d.transfer) ||
                            d.transfer?.state === 'paused' ||
                            d.status === 'offline'
                        }
                        onClick={() => void control('start', d.id)}
                    >
                        <CloudDownload size={14} />
                        Pull
                    </Button>
                    <Button
                        small
                        disabled={
                            !!working ||
                            !!d.operation ||
                            isActive(d.transfer) ||
                            d.status === 'offline'
                        }
                        onClick={() =>
                            d.gadget_loaded
                                ? setUnmount(d)
                                : void run('mount', d.id)
                        }
                    >
                        {d.gadget_loaded ? (
                            <Unplug size={14} />
                        ) : (
                            <PlugZap size={14} />
                        )}{' '}
                        {d.gadget_loaded ? 'Unmount' : 'Mount'}
                    </Button>
                </div>
            </section>
        );
    }
    function volumeDetails(d: Device) {
        if (!d.volumes?.length) {
            return (
                <p className="uc-data uc-muted">
                    Volume details appear after the next scan or pull with an
                    updated client.
                </p>
            );
        }
        return (
            <div className="uc-stack">
                {d.volumes.map((volume) => (
                    <div key={volume.id} className="uc-stack">
                        <Details
                            items={[
                                [
                                    'Volume',
                                    volume.label
                                        ? `${volume.id} · ${volume.label}`
                                        : volume.id,
                                ],
                                ['Filesystem', volume.type ?? 'Unknown'],
                                [
                                    'Last scan',
                                    volume.mounted ? 'Readable' : 'Unreadable',
                                ],
                                ['Capacity', bytes(volume.total_bytes)],
                                ['Free', bytes(volume.free_bytes)],
                                ['UUID', volume.uuid ?? 'Unavailable'],
                                ['Generation', volume.generation],
                            ]}
                        />
                        {volume.error && (
                            <ErrorSummary
                                message={volume.error}
                                theme={theme}
                            />
                        )}
                    </div>
                ))}
                {d.volume_changes?.map((change) => (
                    <p
                        key={`${change.volume_id}-${change.kind}`}
                        className="uc-data uc-muted"
                    >
                        {change.volume_id} ·{' '}
                        {change.kind === 'reformatted'
                            ? 'Reformatted or replaced since the previous scan'
                            : change.kind === 'removed'
                              ? 'Removed since the previous scan'
                              : 'New volume detected'}
                    </p>
                ))}
            </div>
        );
    }
    function deviceDetails(d: Device) {
        return (
            <section className="uc-detail-card">
                <h2 className="uc-label uc-muted">Details</h2>
                <Details
                    items={[
                        ['Host', d.hostname ?? d.config.host],
                        ['Address', d.address],
                        ['Mount', d.filesystem?.mount],
                        ['Firmware', d.firmware],
                        [
                            'Auto sync',
                            (d.config.auto_sync ?? cloud.settings.auto_pull)
                                ? `Every ${d.config.auto_sync == null ? cloud.settings.pull_interval : d.config.interval} s`
                                : 'Paused',
                        ],
                        ['Free', bytes(d.filesystem?.free_bytes)],
                        ['Last file', d.last_file],
                    ]}
                />
                {!!d.volumes?.length && (
                    <details className="uc-stack">
                        <summary className="uc-label">
                            Volumes · {d.volumes.length}
                        </summary>
                        {volumeDetails(d)}
                    </details>
                )}
                <div className="uc-detail-footer uc-card-actions">
                    <Button
                        small
                        variant="ghost"
                        onClick={() => showFiles(d.id)}
                    >
                        <Folder size={14} />
                        Files
                    </Button>
                    <Button
                        small
                        variant="ghost"
                        onClick={() => openDevice(d.id, 'log')}
                    >
                        <Terminal size={14} />
                        Log
                    </Button>
                    <Button
                        small
                        variant="primary"
                        onClick={() => openDevice(d.id)}
                    >
                        <ChevronRight size={14} />
                        Open device
                    </Button>
                </div>
            </section>
        );
    }
    function fileDetails(f: StoredFile) {
        const d = cloud.devices.find((d) => d.id === f.device);
        return (
            <section className="uc-detail-card">
                <h2 className="uc-label uc-muted">File details</h2>
                <Details
                    items={[
                        [
                            'Device',
                            <button
                                className="uc-text-button"
                                disabled={!d}
                                onClick={() => openDevice(f.device)}
                            >
                                {f.device}
                            </button>,
                        ],
                        ['Recorded', date(f.modified_at)],
                        ['Size', bytes(f.bytes)],
                        ['Duration', duration(f.media?.duration)],
                        [
                            'Resolution',
                            f.media?.width && f.media.height
                                ? `${f.media.width} × ${f.media.height}`
                                : '—',
                        ],
                        ['State', f.state],
                        ['Source', f.on_device ? 'On USB' : 'Archive only'],
                        ['Path', f.source_path ?? f.name],
                        ...(f.volume_id
                            ? [['Volume', f.volume_id] as [string, ReactNode]]
                            : []),
                        ...(f.export_path
                            ? [
                                  ['Readable export', f.export_path] as [
                                      string,
                                      ReactNode,
                                  ],
                              ]
                            : []),
                        [
                            'Server',
                            f.state === 'pulled'
                                ? `objects/${f.sha256}`
                                : 'Not yet pulled',
                        ],
                    ]}
                />
                <details className="uc-data uc-break">
                    <summary>SHA-256</summary>
                    <code>{f.sha256}</code>
                </details>
                <div className="uc-card-actions">
                    {f.state === 'pulled' ? (
                        <a
                            className="uc-btn uc-btn-sm"
                            href={downloadFile.url(f.id)}
                        >
                            <Download size={14} />
                            Download
                        </a>
                    ) : (
                        <Button
                            small
                            disabled={!!working || !d || isActive(d.transfer)}
                            onClick={() => void control('start', f.device)}
                        >
                            <CloudDownload size={14} />
                            Pull from device
                        </Button>
                    )}
                    {isVideo(f) && screen !== 'gallery' && (
                        <Button
                            small
                            variant="ghost"
                            onClick={() => {
                                setGalleryId(f.id);
                                setFilters((old) => ({ ...old, gallery: {} }));
                                navigate('gallery');
                            }}
                        >
                            <Film size={14} />
                            Gallery
                        </Button>
                    )}
                    <Button
                        small
                        variant="ghost"
                        onClick={() => {
                            setPreviewId(f.id);
                            showFiles(f.device);
                        }}
                    >
                        <Folder size={14} />
                        Files
                    </Button>
                </div>
            </section>
        );
    }
    function transferStrip() {
        if (!transferVisible) return null;
        const total = allTransfers.reduce(
            (n, d) => n + (d.transfer?.total_bytes ?? 0),
            0,
        );
        const done = allTransfers.reduce(
            (n, d) =>
                n +
                (d.transfer?.done_bytes ?? 0) +
                (isActive(d.transfer) ? (d.transfer?.current_bytes ?? 0) : 0),
            0,
        );
        return (
            <section
                className="uc-detail-card uc-transfer uc-transfer-strip"
                aria-label="Fleet pull progress"
            >
                <div className="uc-between">
                    <div>
                        <h2 className="uc-label uc-accent">
                            {hasRunning
                                ? 'Pull in progress'
                                : hasPaused
                                  ? 'Pull paused'
                                  : 'Pull finished'}
                        </h2>
                        <p className="uc-data">
                            {allTransfers
                                .map((d) => `${d.id} · ${d.transfer?.stage}`)
                                .join(' / ')}
                        </p>
                    </div>
                    <div className="uc-inline">
                        {hasRunning && (
                            <Button
                                small
                                disabled={!!working}
                                onClick={() => void control('pause')}
                            >
                                <Pause size={14} />
                                Pause
                            </Button>
                        )}
                        {hasPaused && (
                            <Button
                                small
                                disabled={!!working}
                                onClick={() => void control('resume')}
                            >
                                <Play size={14} />
                                Resume
                            </Button>
                        )}
                        {(hasRunning || hasPaused) && (
                            <Button
                                small
                                disabled={!!working}
                                onClick={() => void control('cancel')}
                            >
                                <X size={14} />
                                Cancel
                            </Button>
                        )}
                        {!hasRunning && !hasPaused && (
                            <Button small onClick={dismissFinishedTransfers}>
                                <Check size={14} />
                                Dismiss
                            </Button>
                        )}
                    </div>
                </div>
                <ProgressMeter
                    label="Transferred"
                    value={Math.min(total, done)}
                    max={total}
                    caption={`${bytes(Math.min(total, done))} of ${bytes(total)}`}
                />
                <div className="uc-inline uc-data uc-muted">
                    {allTransfers.reduce(
                        (n, d) => n + (d.transfer?.skipped ?? 0),
                        0,
                    )}{' '}
                    already saved files skipped
                </div>
            </section>
        );
    }
    function createPane(source: string): LogPaneState {
        return { id: `pane-${nextLogId.current++}`, source };
    }
    function createRow(): LogRowState {
        return {
            id: `row-${nextLogId.current++}`,
            panes: [createPane('server')],
        };
    }
    function exportLogs() {
        const sources = [
            ...new Set(logRows.flatMap((r) => r.panes.map((p) => p.source))),
        ];
        const entries = sources
            .flatMap((s) =>
                s === 'server'
                    ? cloud.logs.server
                    : (cloud.logs.devices[s] ?? []),
            )
            .sort((a, b) => a.at.localeCompare(b.at));
        const url = URL.createObjectURL(
            new Blob(
                [
                    entries
                        .map(
                            (e) =>
                                `${e.at} ${e.level.toUpperCase()} ${e.source} [${e.origin}] ${e.device ?? ''} ${e.message}`,
                        )
                        .join('\n'),
                ],
                { type: 'text/plain' },
            ),
        );
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'usbcloud-logs.txt';
        anchor.click();
        URL.revokeObjectURL(url);
    }
    return (
        <MultiSelectTheme.Provider value={theme}>
            <div className="usbcloud uc-shell" data-theme={theme}>
                <Head title={`${title} · USBCloud`} />
                <a className="uc-skip" href="#usbcloud-content">
                    Skip to content
                </a>
                <nav
                    className={`uc-sidenav ${mobileNav ? 'uc-nav-open' : ''}`}
                    aria-label="USBCloud navigation"
                >
                    <div className="uc-sidenav-brand">
                        <span className="uc-heading uc-sidenav-brand-name">
                            USBCloud
                        </span>
                        <span className="uc-sidenav-version">
                            v{cloud.server.client_version}
                        </span>
                    </div>
                    {[
                        {
                            label: 'Fleet',
                            items: [
                                {
                                    id: 'devices' as const,
                                    label: 'Devices',
                                    icon: HardDrive,
                                    count: cloud.devices.length,
                                },
                                {
                                    id: 'files' as const,
                                    label: 'Files',
                                    icon: Folder,
                                    count: pending,
                                },
                                {
                                    id: 'gallery' as const,
                                    label: 'Gallery',
                                    icon: Film,
                                    count: cloud.files.filter(isVideo).length,
                                },
                            ],
                        },
                        {
                            label: 'Server',
                            items: [
                                {
                                    id: 'log' as const,
                                    label: 'Log',
                                    icon: Terminal,
                                    count: undefined,
                                },
                                {
                                    id: 'settings' as const,
                                    label: 'Settings',
                                    icon: Settings2,
                                    count: undefined,
                                },
                            ],
                        },
                    ].map((group) => (
                        <div key={group.label} className="uc-sidenav-section">
                            <div className="uc-sidenav-label uc-label">
                                {group.label}
                            </div>
                            <ul className="uc-sidenav-list">
                                {group.items.map((item) => (
                                    <li key={item.id}>
                                        <button
                                            type="button"
                                            className={`uc-sidenav-item ${screen === item.id || (screen === 'device' && item.id === 'devices') ? 'uc-sidenav-item-active' : ''}`}
                                            aria-current={
                                                screen === item.id ||
                                                (screen === 'device' &&
                                                    item.id === 'devices')
                                                    ? 'page'
                                                    : undefined
                                            }
                                            onClick={() => navigate(item.id)}
                                        >
                                            <span className="uc-sidenav-caret">
                                                &gt;
                                            </span>
                                            <item.icon size={16} />
                                            <span className="uc-sidenav-item-label">
                                                {item.label}
                                            </span>
                                            {item.count != null && (
                                                <span className="uc-sidenav-count">
                                                    {item.count}
                                                </span>
                                            )}
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ))}
                    <div className="uc-sidenav-foot uc-data">
                        {cloud.settings.server_name}
                        <span className="uc-foot-note">Local management</span>
                    </div>
                </nav>
                <main className="uc-main" id="usbcloud-content">
                    <header className="uc-toolbar">
                        <div className="uc-toolbar-lead">
                            <div className="uc-toolbar-crumb uc-label">
                                USBCloud <span className="uc-sep">/</span>{' '}
                                {['log', 'settings'].includes(screen)
                                    ? 'Server'
                                    : 'Fleet'}{' '}
                                {screen === 'device' && active
                                    ? ` / ${active.id}`
                                    : ''}
                            </div>
                            <h1 className="uc-title uc-toolbar-title">
                                {title}
                            </h1>
                        </div>
                        <div className="uc-toolbar-actions">
                            <Button
                                variant="ghost"
                                className="uc-mobile-menu"
                                aria-expanded={mobileNav}
                                aria-label="Toggle navigation"
                                onClick={() => setMobileNav(!mobileNav)}
                            >
                                <Menu size={16} />
                            </Button>
                            {['devices', 'files', 'gallery'].includes(
                                screen,
                            ) && (
                                <Button
                                    variant="ghost"
                                    aria-expanded={!!filterOpen[screen]}
                                    onClick={() =>
                                        setFilterOpen((old) => ({
                                            ...old,
                                            [screen]: !old[screen],
                                        }))
                                    }
                                >
                                    <SlidersHorizontal size={16} />
                                    Filter
                                    {filterCount(screen)
                                        ? ` · ${filterCount(screen)}`
                                        : ''}
                                </Button>
                            )}
                            {screen === 'devices' && (
                                <>
                                    <Button
                                        disabled={!!working}
                                        onClick={() => void run('refresh')}
                                        aria-label="Refresh all devices"
                                    >
                                        <RefreshCw size={16} />
                                        Refresh
                                    </Button>
                                    <Button
                                        onClick={() => {
                                            setAddOpen(true);
                                            setAddError('');
                                            if (existingClient) void scan();
                                        }}
                                    >
                                        <Plus size={16} />
                                        Add device
                                    </Button>
                                    <Button
                                        variant="primary"
                                        disabled={
                                            !!working ||
                                            !cloud.devices.length ||
                                            hasRunning ||
                                            hasPaused
                                        }
                                        onClick={() => void control('start')}
                                    >
                                        <CloudDownload size={16} />
                                        {hasRunning
                                            ? 'Pulling…'
                                            : hasPaused
                                              ? 'Pull paused'
                                              : 'Pull new files'}
                                    </Button>
                                </>
                            )}
                            {screen === 'files' && (
                                <>
                                    <a
                                        className={`uc-btn ${!downloadable.length ? 'uc-disabled' : ''}`}
                                        aria-disabled={!downloadable.length}
                                        href={
                                            downloadable.length
                                                ? downloadable.length === 1
                                                    ? downloadFile.url(
                                                          downloadable[0],
                                                      )
                                                    : download.url({
                                                          query: {
                                                              files: downloadable,
                                                          },
                                                      })
                                                : undefined
                                        }
                                    >
                                        <Download size={16} />
                                        Download selected
                                        {downloadable.length
                                            ? ` (${downloadable.length})`
                                            : ''}
                                    </a>
                                    <Button
                                        variant="primary"
                                        disabled={
                                            !!working ||
                                            hasRunning ||
                                            hasPaused ||
                                            !cloud.devices.length
                                        }
                                        onClick={() =>
                                            void control(
                                                'start',
                                                getFilter('files', 'device') ===
                                                    'any'
                                                    ? undefined
                                                    : getFilter(
                                                          'files',
                                                          'device',
                                                      ),
                                            )
                                        }
                                    >
                                        <CloudDownload size={16} />
                                        Pull pending
                                    </Button>
                                </>
                            )}
                            {screen === 'device' && active && (
                                <>
                                    <Button
                                        variant="ghost"
                                        onClick={() => navigate('devices')}
                                    >
                                        Back to fleet
                                    </Button>
                                    <Button
                                        disabled={!!working}
                                        onClick={() =>
                                            void run('refresh', active.id)
                                        }
                                    >
                                        <RefreshCw size={16} />
                                        Refresh
                                    </Button>
                                    <Button
                                        disabled={
                                            !!working ||
                                            !!active.operation ||
                                            isActive(active.transfer) ||
                                            active.status === 'offline'
                                        }
                                        onClick={() =>
                                            active.gadget_loaded
                                                ? setUnmount(active)
                                                : void run('mount', active.id)
                                        }
                                    >
                                        <Unplug size={16} />
                                        {active.gadget_loaded
                                            ? 'Unmount'
                                            : 'Mount'}
                                    </Button>
                                    <Button
                                        variant="primary"
                                        disabled={
                                            !!working ||
                                            isActive(active.transfer) ||
                                            active.transfer?.state ===
                                                'paused' ||
                                            active.status === 'offline'
                                        }
                                        onClick={() =>
                                            void control('start', active.id)
                                        }
                                    >
                                        <CloudDownload size={16} />
                                        Pull now
                                    </Button>
                                </>
                            )}
                            {screen === 'log' && (
                                <>
                                    <Button
                                        variant="ghost"
                                        disabled={!logRows.length}
                                        onClick={() => setLogRows([])}
                                    >
                                        <X size={16} />
                                        Close all
                                    </Button>
                                    <Button
                                        disabled={!logRows.length}
                                        onClick={exportLogs}
                                    >
                                        <Download size={16} />
                                        Export open logs
                                    </Button>
                                    <Button
                                        onClick={() =>
                                            setLogRows((old) => [
                                                ...old,
                                                createRow(),
                                            ])
                                        }
                                    >
                                        <Terminal size={16} />
                                        Add row
                                    </Button>
                                </>
                            )}
                            {screen === 'settings' && (
                                <Button
                                    variant="ghost"
                                    disabled={settings.processing}
                                    onClick={() => {
                                        settings.setData(cloud.settings);
                                        settings.clearErrors();
                                        reload();
                                    }}
                                >
                                    <RefreshCw size={16} />
                                    Reload config
                                </Button>
                            )}
                        </div>
                    </header>
                    {screen === 'devices' && (
                        <Tabs
                            label="Device status"
                            value={tab}
                            onChange={setTab}
                            items={[
                                {
                                    id: 'all',
                                    label: 'All',
                                    count: cloud.devices.length,
                                },
                                ...(
                                    [
                                        'online',
                                        'syncing',
                                        'offline',
                                        'fault',
                                    ] as const
                                ).map((status) => ({
                                    id: status,
                                    label:
                                        status === 'syncing'
                                            ? 'In flight'
                                            : status === 'fault'
                                              ? 'Faults'
                                              : status,
                                    count:
                                        status === 'syncing'
                                            ? inflight.length
                                            : cloud.devices.filter(
                                                  (d) => d.status === status,
                                              ).length,
                                })),
                            ]}
                        />
                    )}
                    {screen === 'device' && active && (
                        <Tabs
                            label="Device sections"
                            value={deviceTab}
                            onChange={setDeviceTab}
                            items={[
                                { id: 'overview', label: 'Overview' },
                                {
                                    id: 'files',
                                    label: 'Files',
                                    count: cloud.files.filter(
                                        (f) => f.device === active.id,
                                    ).length,
                                },
                                { id: 'log', label: 'Log' },
                                { id: 'settings', label: 'Settings' },
                            ]}
                        />
                    )}
                    {screen === 'files' && (
                        <Tabs
                            label="File state"
                            value={fileTab}
                            onChange={setFileTab}
                            items={[
                                'pending',
                                'inflight',
                                'pulled',
                                'failed',
                                'all',
                            ].map((state) => ({
                                id: state,
                                label:
                                    state === 'inflight' ? 'In flight' : state,
                                count: cloud.files.filter(
                                    (f) =>
                                        state === 'all' ||
                                        (state === 'inflight'
                                            ? ['pulling', 'paused'].includes(
                                                  f.state,
                                              )
                                            : state === 'pending'
                                              ? ['pending', 'queued'].includes(
                                                    f.state,
                                                )
                                              : f.state === state),
                                ).length,
                            }))}
                        />
                    )}
                    <div
                        ref={notice}
                        tabIndex={-1}
                        className={`uc-notice ${!message && !working ? 'uc-notice-hidden' : ''}`}
                        role={error ? 'alert' : 'status'}
                    >
                        {working ? (
                            <>
                                <RefreshCw size={16} className="uc-spinning" />
                                {working}
                            </>
                        ) : (
                            <>
                                {error ? <X size={16} /> : <Check size={16} />}
                                {error ? (
                                    <ErrorSummary
                                        message={message}
                                        theme={theme}
                                    />
                                ) : (
                                    <span className="uc-break">{message}</span>
                                )}
                                <Button
                                    small
                                    variant="ghost"
                                    aria-label="Dismiss message"
                                    onClick={() => setMessage('')}
                                >
                                    <X size={14} />
                                </Button>
                            </>
                        )}
                    </div>
                    {['devices', 'files', 'gallery'].includes(screen) &&
                        filterBar(screen)}
                    {screen === 'devices' && (
                        <div className="uc-page">
                            {transferStrip()}
                            <div className="uc-stats">
                                {[
                                    {
                                        label: 'Devices',
                                        value: cloud.devices.length,
                                        text: `${cloud.devices.filter((d) => d.status === 'online').length} online · ${cloud.devices.filter((d) => d.status === 'offline').length} offline`,
                                    },
                                    {
                                        label: 'In flight',
                                        value: inflight.length,
                                        text: `${inflight.reduce((n, d) => n + Math.max(0, (d.transfer?.total_files ?? 0) - (d.transfer?.done_files ?? 0)), 0)} files in flight · ${bytes(inflight.reduce((n, d) => n + (d.transfer?.rate ?? 0), 0))}/s`,
                                    },
                                    {
                                        label: 'Pending files',
                                        value: cloud.files.filter(
                                            (f) => f.state !== 'pulled',
                                        ).length,
                                        text: `across ${cloud.devices.filter((d) => (d.pending ?? 0) > 0).length} devices`,
                                    },
                                    {
                                        label: 'Faults',
                                        value: cloud.devices.filter(
                                            (d) => d.status === 'fault',
                                        ).length,
                                        text: faultMessage ? (
                                            <ErrorSummary
                                                message={faultMessage}
                                                theme={theme}
                                            />
                                        ) : (
                                            '0 faults'
                                        ),
                                    },
                                ].map((stat, i) => (
                                    <section
                                        className="uc-stat"
                                        key={stat.label}
                                    >
                                        <div className="uc-label uc-muted">
                                            {stat.label}
                                        </div>
                                        <div
                                            className={`uc-stat-value ${i === 1 ? 'uc-accent' : ''}`}
                                        >
                                            {stat.value}
                                        </div>
                                        <div className="uc-data uc-muted">
                                            {stat.text}
                                        </div>
                                        {i === 1 && (
                                            <ProgressMeter
                                                label="Progress"
                                                value={Math.min(
                                                    totalBytes,
                                                    doneBytes,
                                                )}
                                                max={totalBytes}
                                                caption={`${bytes(Math.min(totalBytes, doneBytes))} of ${bytes(totalBytes)}`}
                                            />
                                        )}
                                    </section>
                                ))}
                            </div>
                            <div className="uc-fleet-layout">
                                <div className="uc-table-wrap">
                                    <table className="uc-table uc-data">
                                        <caption className="uc-label">
                                            {deviceRows.length} of{' '}
                                            {cloud.devices.length} devices
                                            {filterCount('devices')
                                                ? ` · ${filterCount('devices')} filters`
                                                : ''}
                                        </caption>
                                        <thead>
                                            <tr>
                                                {[
                                                    'Device',
                                                    'Name',
                                                    'Status',
                                                    'Used',
                                                    'Pending',
                                                    'Last sync',
                                                    '',
                                                ].map((label) => (
                                                    <th
                                                        key={label}
                                                        scope="col"
                                                        className="uc-label"
                                                    >
                                                        {label || (
                                                            <span className="sr-only">
                                                                Open device
                                                            </span>
                                                        )}
                                                    </th>
                                                ))}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {deviceRows.map((d) => (
                                                <tr
                                                    key={d.id}
                                                    className={
                                                        active?.id === d.id
                                                            ? 'uc-tr-selected'
                                                            : ''
                                                    }
                                                >
                                                    <td className="uc-key">
                                                        <button
                                                            type="button"
                                                            className="uc-row-select"
                                                            aria-label={`Select ${d.id}`}
                                                            aria-pressed={
                                                                active?.id ===
                                                                d.id
                                                            }
                                                            onClick={() =>
                                                                setSelected(
                                                                    d.id,
                                                                )
                                                            }
                                                        >
                                                            {d.id}
                                                        </button>
                                                    </td>
                                                    <td>{d.name}</td>
                                                    <td>
                                                        <Badge
                                                            status={d.status}
                                                        />
                                                        {d.transfer?.state ===
                                                            'paused' && (
                                                            <span className="uc-label">
                                                                {' '}
                                                                Paused
                                                            </span>
                                                        )}
                                                        {isActive(
                                                            d.transfer,
                                                        ) && (
                                                            <ProgressMeter
                                                                label={`${d.id} progress`}
                                                                value={Math.min(
                                                                    d.transfer!
                                                                        .total_bytes,
                                                                    d.transfer!
                                                                        .done_bytes +
                                                                        d
                                                                            .transfer!
                                                                            .current_bytes,
                                                                )}
                                                                max={
                                                                    d.transfer!
                                                                        .total_bytes
                                                                }
                                                            />
                                                        )}
                                                    </td>
                                                    <td>
                                                        {bytes(
                                                            d.filesystem
                                                                ?.used_bytes,
                                                        )}
                                                    </td>
                                                    <td>{d.pending ?? '—'}</td>
                                                    <td
                                                        title={date(
                                                            d.last_sync,
                                                        )}
                                                    >
                                                        {ago(d.last_sync)}
                                                    </td>
                                                    <td>
                                                        <Button
                                                            small
                                                            variant="ghost"
                                                            aria-label={`Open ${d.id}`}
                                                            onClick={() =>
                                                                openDevice(d.id)
                                                            }
                                                        >
                                                            <ChevronRight
                                                                size={14}
                                                            />
                                                        </Button>
                                                    </td>
                                                </tr>
                                            ))}
                                            {!deviceRows.length && (
                                                <tr>
                                                    <td
                                                        colSpan={7}
                                                        className="uc-table-empty"
                                                    >
                                                        {cloud.devices.length
                                                            ? '0 devices match these filters.'
                                                            : 'No devices in the fleet. Add a device to get started.'}
                                                    </td>
                                                </tr>
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                                {active && (
                                    <aside className="uc-details">
                                        {deviceCard(active)}
                                        {active.transfer && (
                                            <TransferPanel
                                                device={active}
                                                theme={theme}
                                                onControl={(a, id) =>
                                                    void control(a, id)
                                                }
                                                disabled={!!working}
                                            />
                                        )}{' '}
                                        {deviceDetails(active)}
                                        <p className="uc-data uc-muted uc-freshness">
                                            Status checked{' '}
                                            {ago(active.checked_at)}. Inventory:{' '}
                                            {ago(active.scanned_at)}. Storage
                                            reflects the latest snapshot.
                                        </p>
                                    </aside>
                                )}
                            </div>
                        </div>
                    )}
                    {screen === 'device' && active && (
                        <div
                            className={`uc-page ${deviceTab === 'overview' ? 'uc-device-page' : ''}`}
                        >
                            {deviceTab === 'overview' && (
                                <div className="uc-device-overview">
                                    <DeviceSummary
                                        device={active}
                                        defaults={cloud.settings}
                                    />
                                    <HealthTiles device={active} />
                                    <div className="uc-device-panels">
                                        <section className="uc-detail-card uc-drive-panel">
                                            <div className="uc-panel-heading">
                                                <h2 className="uc-label uc-muted">
                                                    Drive
                                                </h2>
                                                <span
                                                    className="uc-label uc-muted uc-ellipsis"
                                                    title={
                                                        active.filesystem?.mount
                                                    }
                                                >
                                                    {active.filesystem?.mount ??
                                                        'Not scanned'}
                                                </span>
                                            </div>
                                            <Meter
                                                device={active}
                                                label="Used"
                                            />
                                            <Details
                                                items={[
                                                    [
                                                        'Free',
                                                        bytes(
                                                            active.filesystem
                                                                ?.free_bytes,
                                                        ),
                                                    ],
                                                    [
                                                        'Filesystem',
                                                        active.filesystem?.type,
                                                    ],
                                                    [
                                                        'USB state',
                                                        active.usb_state ||
                                                            'Unknown',
                                                    ],
                                                    [
                                                        'Last file',
                                                        <span
                                                            className="uc-ellipsis"
                                                            title={
                                                                active.last_file ??
                                                                undefined
                                                            }
                                                        >
                                                            {active.last_file ??
                                                                '—'}
                                                        </span>,
                                                    ],
                                                ]}
                                            />
                                        </section>
                                        <section
                                            className="uc-detail-card uc-volume-panel"
                                            aria-label="Device volumes"
                                        >
                                            <div className="uc-panel-heading">
                                                <h2 className="uc-label uc-muted">
                                                    Volumes
                                                </h2>
                                                <span className="uc-label uc-muted">
                                                    {active.volumes?.length
                                                        ? `${active.volumes.length} ${active.volumes.length === 1 ? 'volume' : 'volumes'}`
                                                        : 'None yet'}
                                                </span>
                                            </div>
                                            {active.volumes?.length ? (
                                                active.volumes.map((volume) => (
                                                    <div
                                                        key={volume.id}
                                                        className="uc-volume-row"
                                                    >
                                                        <div className="uc-volume-info">
                                                            <span
                                                                className="uc-data uc-volume-name"
                                                                title={
                                                                    volume.label ??
                                                                    volume.id
                                                                }
                                                            >
                                                                {volume.label
                                                                    ? `${volume.id} · ${volume.label}`
                                                                    : volume.id}
                                                            </span>
                                                            <span
                                                                className="uc-data uc-muted uc-ellipsis"
                                                                title={`${volume.type ?? 'Unknown'} · ${bytes(volume.total_bytes)}`}
                                                            >
                                                                {volume.type ??
                                                                    'Unknown'}{' '}
                                                                ·{' '}
                                                                {bytes(
                                                                    volume.total_bytes,
                                                                )}
                                                            </span>
                                                        </div>
                                                        <span
                                                            className={`uc-label uc-volume-readable ${volume.mounted ? 'uc-accent' : 'uc-inverse'}`}
                                                        >
                                                            {volume.mounted
                                                                ? 'Readable'
                                                                : 'Not readable'}
                                                        </span>
                                                        {volume.error && (
                                                            <div className="uc-volume-error uc-data">
                                                                <ErrorSummary
                                                                    message={
                                                                        volume.error
                                                                    }
                                                                    theme={
                                                                        theme
                                                                    }
                                                                />
                                                            </div>
                                                        )}
                                                    </div>
                                                ))
                                            ) : (
                                                <p className="uc-data uc-muted uc-volume-empty">
                                                    No volume details reported.
                                                    Volumes appear after a
                                                    snapshot with an updated
                                                    client; pull now or wait for
                                                    the next sync.
                                                </p>
                                            )}
                                            {active.volume_changes?.map(
                                                (change) => (
                                                    <p
                                                        key={`${change.volume_id}-${change.kind}`}
                                                        className="uc-data uc-muted"
                                                    >
                                                        {change.volume_id} ·{' '}
                                                        {change.kind ===
                                                        'reformatted'
                                                            ? 'Reformatted or replaced since the previous scan'
                                                            : change.kind ===
                                                                'removed'
                                                              ? 'Removed since the previous scan'
                                                              : 'New volume detected'}
                                                    </p>
                                                ),
                                            )}
                                            <p
                                                className="uc-data uc-muted uc-volume-scan"
                                                title={date(active.scanned_at)}
                                            >
                                                {active.scanned_at
                                                    ? `Last scanned ${ago(active.scanned_at)} · readability reflects that scan.`
                                                    : 'Never scanned.'}
                                            </p>
                                        </section>
                                        {active.transfer &&
                                        !['completed', 'cancelled'].includes(
                                            active.transfer.state,
                                        ) ? (
                                            <TransferPanel
                                                device={active}
                                                theme={theme}
                                                onControl={(action, id) =>
                                                    void control(action, id)
                                                }
                                                disabled={!!working}
                                            />
                                        ) : (
                                            <section className="uc-detail-card">
                                                <h2 className="uc-label uc-muted">
                                                    Transfer
                                                </h2>
                                                <p className="uc-data">
                                                    {active.status === 'offline'
                                                        ? 'Unreachable'
                                                        : active.status ===
                                                            'fault'
                                                          ? 'Blocked'
                                                          : 'Idle'}{' '}
                                                    ·{' '}
                                                    {active.pending == null
                                                        ? 'inventory not yet scanned'
                                                        : active.pending > 0
                                                          ? `${active.pending} new files waiting for the next sync`
                                                          : `nothing new since ${ago(active.last_sync)}`}
                                                    .
                                                </p>
                                                <Details
                                                    items={[
                                                        [
                                                            'Next sync',
                                                            nextSync(
                                                                active,
                                                                cloud.settings,
                                                            ),
                                                        ],
                                                        [
                                                            'Pending',
                                                            active.pending ==
                                                            null
                                                                ? 'Not scanned'
                                                                : `${active.pending} files`,
                                                        ],
                                                        [
                                                            'Bandwidth',
                                                            active.config
                                                                .bandwidth
                                                                ? `${active.config.bandwidth} MB/s`
                                                                : 'Unlimited',
                                                        ],
                                                        [
                                                            'Retries',
                                                            `${active.config.retry_count} × ${active.config.retry_delay} s`,
                                                        ],
                                                        [
                                                            'Snapshot',
                                                            `${active.config.snapshot_timeout % 60 === 0 ? `${active.config.snapshot_timeout / 60} min` : `${active.config.snapshot_timeout} s`} idle limit`,
                                                        ],
                                                    ]}
                                                />
                                            </section>
                                        )}
                                    </div>
                                    <div className="uc-device-secondary">
                                        <section className="uc-detail-card">
                                            <div className="uc-panel-heading">
                                                <h2 className="uc-label uc-muted">
                                                    Client
                                                </h2>
                                                <span
                                                    className="uc-label uc-muted uc-ellipsis"
                                                    title={date(
                                                        active.checked_at,
                                                    )}
                                                >
                                                    {active.checked_at
                                                        ? `${active.status === 'offline' ? 'Last report' : 'Reported'} ${ago(active.checked_at)}`
                                                        : 'Awaiting report'}
                                                </span>
                                            </div>
                                            <Details
                                                items={[
                                                    [
                                                        'Host',
                                                        <span
                                                            className="uc-ellipsis"
                                                            title={
                                                                active.hostname ??
                                                                active.config
                                                                    .host
                                                            }
                                                        >
                                                            {active.hostname ??
                                                                active.config
                                                                    .host}
                                                        </span>,
                                                    ],
                                                    ['Address', active.address],
                                                    [
                                                        'SSH',
                                                        `port ${active.config.port} · user ${active.config.user}`,
                                                    ],
                                                    ['Model', active.model],
                                                    [
                                                        'Agent',
                                                        active.firmware
                                                            ? `USBCloud agent ${active.firmware}`
                                                            : '—',
                                                    ],
                                                    [
                                                        'Uptime',
                                                        uptime(
                                                            active.uptime_seconds,
                                                        ),
                                                    ],
                                                    [
                                                        'Site',
                                                        active.config.site ||
                                                            '—',
                                                    ],
                                                    [
                                                        'Reports via',
                                                        active.status_source ===
                                                        'heartbeat'
                                                            ? 'API heartbeat · every 30 s'
                                                            : 'SSH · client upgrade needed',
                                                    ],
                                                    [
                                                        'Last report',
                                                        active.checked_at ? (
                                                            <span
                                                                title={date(
                                                                    active.checked_at,
                                                                )}
                                                            >
                                                                {ago(
                                                                    active.checked_at,
                                                                )}
                                                            </span>
                                                        ) : (
                                                            'Waiting for first heartbeat'
                                                        ),
                                                    ],
                                                ]}
                                            />
                                            <div className="uc-card-actions">
                                                <Button
                                                    small
                                                    variant="ghost"
                                                    onClick={() =>
                                                        setDeviceTab('settings')
                                                    }
                                                >
                                                    <Settings2 size={14} />
                                                    Settings
                                                </Button>
                                            </div>
                                        </section>
                                        {fileTable(
                                            cloud.files
                                                .filter(
                                                    (file) =>
                                                        file.device ===
                                                        active.id,
                                                )
                                                .slice(0, 6),
                                            `Recent files · ${active.id}`,
                                            false,
                                            true,
                                        )}
                                    </div>
                                    {cloud.logs.errors[active.id] && (
                                        <p className="uc-data" role="alert">
                                            Log stream unavailable:{' '}
                                            {cloud.logs.errors[active.id]}.
                                            Retrying automatically.
                                        </p>
                                    )}
                                    <LogPane
                                        key={active.id}
                                        overview
                                        title={`${active.id} · client log`}
                                        entries={
                                            cloud.logs.devices[active.id] ?? []
                                        }
                                        actions={
                                            <Button
                                                small
                                                variant="ghost"
                                                onClick={() =>
                                                    setDeviceTab('log')
                                                }
                                            >
                                                <Terminal size={14} />
                                                Full log
                                            </Button>
                                        }
                                    />
                                </div>
                            )}
                            {deviceTab === 'files' &&
                                fileTable(
                                    cloud.files.filter(
                                        (f) => f.device === active.id,
                                    ),
                                    `Files · ${active.id}`,
                                )}
                            {deviceTab === 'log' && (
                                <>
                                    {cloud.logs.errors[active.id] && (
                                        <p className="uc-data" role="alert">
                                            Log stream unavailable:{' '}
                                            {cloud.logs.errors[active.id]}.
                                            Retrying automatically.
                                        </p>
                                    )}
                                    <LogPane
                                        title={`${active.id} · client`}
                                        entries={
                                            cloud.logs.devices[active.id] ?? []
                                        }
                                    />
                                </>
                            )}
                            {deviceTab === 'settings' && (
                                <DeviceSettings
                                    key={active.id}
                                    device={active}
                                    cloud={cloud}
                                    onMessage={notify}
                                    onRemove={() => setRemove(active)}
                                />
                            )}
                        </div>
                    )}
                    {screen === 'files' && (
                        <div className="uc-page">
                            {transferStrip()}
                            {selectedFiles.length > 0 && (
                                <div className="uc-inline">
                                    <span className="uc-data">
                                        {selectedFiles.length} selected
                                    </span>
                                    <Button
                                        small
                                        variant="ghost"
                                        onClick={() => setSelectedFiles([])}
                                    >
                                        Clear selection
                                    </Button>
                                </div>
                            )}
                            <div
                                className={`uc-files-layout ${preview ? 'uc-files-with-preview' : ''}`}
                            >
                                {fileTable(
                                    fileRows,
                                    `${fileRows.length} of ${cloud.files.length} files`,
                                    true,
                                )}
                                {preview && (
                                    <aside
                                        className="uc-preview"
                                        aria-label="File preview"
                                    >
                                        <section className="uc-detail-card">
                                            <div className="uc-between">
                                                <h2 className="uc-heading uc-break">
                                                    {preview.name
                                                        .split('/')
                                                        .at(-1)}
                                                </h2>
                                                <Button
                                                    small
                                                    variant="ghost"
                                                    aria-label="Close preview"
                                                    onClick={() =>
                                                        setPreviewId('')
                                                    }
                                                >
                                                    <X size={14} />
                                                </Button>
                                            </div>
                                            <MediaPlayer
                                                key={preview.id}
                                                file={preview}
                                            />
                                        </section>
                                        {fileDetails(preview)}
                                    </aside>
                                )}
                            </div>
                            <p className="uc-data uc-muted">
                                Archived copies are retained after source
                                deletion. Pull checks for new files; Refresh
                                checks status only.
                            </p>
                        </div>
                    )}
                    {screen === 'gallery' && (
                        <div className="uc-page uc-gallery-page">
                            <div className="uc-gallery-caption uc-label uc-muted">
                                {videos.length} clips match
                            </div>
                            <div className="uc-gallery">
                                <aside
                                    className="uc-clip-list"
                                    aria-label="Clips"
                                >
                                    {videos.map((f) => (
                                        <button
                                            type="button"
                                            key={f.id}
                                            className={`uc-clip ${f.id === currentClip?.id ? 'uc-clip-selected' : ''}`}
                                            aria-pressed={
                                                f.id === currentClip?.id
                                            }
                                            onClick={() => setGalleryId(f.id)}
                                        >
                                            <span className="uc-clip-thumbnail">
                                                {f.state === 'pulled' ? (
                                                    <video
                                                        muted
                                                        preload="metadata"
                                                        src={downloadFile.url(
                                                            f.id,
                                                            {
                                                                query: {
                                                                    preview: true,
                                                                },
                                                            },
                                                        )}
                                                    >
                                                        <track kind="captions" />
                                                    </video>
                                                ) : (
                                                    <Film size={24} />
                                                )}
                                                <span>
                                                    {duration(
                                                        f.media?.duration,
                                                    )}
                                                </span>
                                            </span>
                                            <strong className="uc-data uc-break">
                                                {f.name.split('/').at(-1)}
                                            </strong>
                                            <span className="uc-data uc-muted">
                                                {f.device} · {f.state}
                                                {f.media?.duration != null
                                                    ? ` · ${duration(f.media.duration)}`
                                                    : ''}
                                            </span>
                                            <span className="uc-data uc-muted">
                                                {date(f.modified_at)}
                                            </span>
                                        </button>
                                    ))}
                                    {!videos.length && (
                                        <p className="uc-data uc-muted">
                                            0 clips match. Adjust filters or
                                            pull video clips from a device.
                                        </p>
                                    )}
                                </aside>
                                {currentClip ? (
                                    <>
                                        <section className="uc-gallery-player">
                                            <div className="uc-between">
                                                <div>
                                                    <span className="uc-label uc-muted">
                                                        {currentClip.device} /{' '}
                                                        {currentClip.state}
                                                    </span>
                                                    <h2 className="uc-heading uc-break">
                                                        {currentClip.name
                                                            .split('/')
                                                            .at(-1)}
                                                    </h2>
                                                </div>
                                                <div className="uc-inline">
                                                    <Button
                                                        small
                                                        variant="ghost"
                                                        aria-label="Previous clip"
                                                        disabled={
                                                            currentIndex <= 0
                                                        }
                                                        onClick={() =>
                                                            setGalleryId(
                                                                videos[
                                                                    currentIndex -
                                                                        1
                                                                ].id,
                                                            )
                                                        }
                                                    >
                                                        Prev
                                                    </Button>
                                                    <Button
                                                        small
                                                        variant="ghost"
                                                        aria-label="Next clip"
                                                        disabled={
                                                            currentIndex >=
                                                            videos.length - 1
                                                        }
                                                        onClick={() =>
                                                            setGalleryId(
                                                                videos[
                                                                    currentIndex +
                                                                        1
                                                                ].id,
                                                            )
                                                        }
                                                    >
                                                        Next
                                                        <ChevronRight
                                                            size={14}
                                                        />
                                                    </Button>
                                                </div>
                                            </div>
                                            <MediaPlayer
                                                key={currentClip.id}
                                                file={currentClip}
                                            />
                                            <p className="uc-data uc-muted">
                                                {date(currentClip.modified_at)}{' '}
                                                ·{' '}
                                                {duration(
                                                    currentClip.media?.duration,
                                                )}{' '}
                                                · {bytes(currentClip.bytes)}
                                            </p>
                                        </section>
                                        <aside
                                            className="uc-gallery-details"
                                            aria-label="Clip details"
                                        >
                                            {fileDetails(currentClip)}
                                            {cloud.devices.find(
                                                (d) =>
                                                    d.id === currentClip.device,
                                            ) && (
                                                <section className="uc-detail-card">
                                                    <h2 className="uc-label uc-muted">
                                                        Device
                                                    </h2>
                                                    <p className="uc-data">
                                                        {
                                                            cloud.devices.find(
                                                                (d) =>
                                                                    d.id ===
                                                                    currentClip.device,
                                                            )?.name
                                                        }
                                                    </p>
                                                    <Button
                                                        small
                                                        onClick={() =>
                                                            openDevice(
                                                                currentClip.device,
                                                            )
                                                        }
                                                    >
                                                        Open device
                                                        <ChevronRight
                                                            size={14}
                                                        />
                                                    </Button>
                                                </section>
                                            )}
                                        </aside>
                                    </>
                                ) : (
                                    <div className="uc-empty uc-data">
                                        No clip selected.
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                    {screen === 'log' && (
                        <div className="uc-page uc-log-page">
                            {!logRows.length && (
                                <div className="uc-empty uc-data">
                                    0 logs open. Add a row to start.
                                </div>
                            )}
                            {logRows.map((row) => (
                                <div key={row.id} className="uc-log-row">
                                    {row.panes.map((pane) => (
                                        <div
                                            key={pane.id}
                                            className="uc-log-column"
                                            data-log-pane={pane.id}
                                        >
                                            <div className="uc-inline uc-log-source-row">
                                                <div className="uc-log-source-select">
                                                    <MultiSelect
                                                        label="Log source"
                                                        multiple={false}
                                                        values={[pane.source]}
                                                        options={[
                                                            [
                                                                'server',
                                                                `${cloud.settings.server_name} · server`,
                                                            ],
                                                            ...cloud.devices.map(
                                                                (d) =>
                                                                    [
                                                                        d.id,
                                                                        `${d.id} · ${d.name}`,
                                                                    ] as [
                                                                        string,
                                                                        string,
                                                                    ],
                                                            ),
                                                        ]}
                                                        onChange={(values) =>
                                                            setLogRows((old) =>
                                                                old.map((r) =>
                                                                    r.id ===
                                                                    row.id
                                                                        ? {
                                                                              ...r,
                                                                              panes: r.panes.map(
                                                                                  (
                                                                                      p,
                                                                                  ) =>
                                                                                      p.id ===
                                                                                      pane.id
                                                                                          ? {
                                                                                                ...p,
                                                                                                source: values[0],
                                                                                            }
                                                                                          : p,
                                                                              ),
                                                                          }
                                                                        : r,
                                                                ),
                                                            )
                                                        }
                                                    />
                                                </div>
                                                <Button
                                                    variant="ghost"
                                                    aria-label="Close this log"
                                                    onClick={() =>
                                                        setLogRows((old) =>
                                                            old
                                                                .map((r) =>
                                                                    r.id ===
                                                                    row.id
                                                                        ? {
                                                                              ...r,
                                                                              panes: r.panes.filter(
                                                                                  (
                                                                                      p,
                                                                                  ) =>
                                                                                      p.id !==
                                                                                      pane.id,
                                                                              ),
                                                                          }
                                                                        : r,
                                                                )
                                                                .filter(
                                                                    (r) =>
                                                                        r.panes
                                                                            .length,
                                                                ),
                                                        )
                                                    }
                                                >
                                                    <X size={14} />
                                                    Close
                                                </Button>
                                            </div>
                                            {cloud.logs.errors[pane.source] && (
                                                <p
                                                    className="uc-data"
                                                    role="alert"
                                                >
                                                    Log stream unavailable:{' '}
                                                    {
                                                        cloud.logs.errors[
                                                            pane.source
                                                        ]
                                                    }
                                                    . Retrying automatically.
                                                </p>
                                            )}
                                            <LogPane
                                                title={
                                                    pane.source === 'server'
                                                        ? `${cloud.settings.server_name} · server`
                                                        : pane.source
                                                }
                                                entries={
                                                    pane.source === 'server'
                                                        ? cloud.logs.server
                                                        : (cloud.logs.devices[
                                                              pane.source
                                                          ] ?? [])
                                                }
                                            />
                                        </div>
                                    ))}
                                    <Button
                                        variant="ghost"
                                        className="uc-add-log"
                                        onClick={() =>
                                            setLogRows((old) =>
                                                old.map((r) =>
                                                    r.id === row.id
                                                        ? {
                                                              ...r,
                                                              panes: [
                                                                  ...r.panes,
                                                                  createPane(
                                                                      'server',
                                                                  ),
                                                              ],
                                                          }
                                                        : r,
                                                ),
                                            )
                                        }
                                    >
                                        <ChevronRight size={16} />
                                        Add to row
                                    </Button>
                                </div>
                            ))}
                            <div className="uc-log-bottom">
                                <Button
                                    variant="ghost"
                                    onClick={() =>
                                        setLogRows((old) => [
                                            ...old,
                                            createRow(),
                                        ])
                                    }
                                >
                                    <ChevronDown size={16} />
                                    Add row
                                </Button>
                            </div>
                        </div>
                    )}
                    {screen === 'settings' && (
                        <form
                            className="uc-page uc-settings"
                            onSubmit={async (e) => {
                                e.preventDefault();
                                try {
                                    const result = await settings.put(
                                        saveSettings.url(),
                                    );
                                    settings.setDefaults(result.settings);
                                    notify('Settings saved.');
                                    reload();
                                } catch {
                                    notify(
                                        'Settings could not be saved. Check the fields and retry.',
                                        true,
                                    );
                                }
                            }}
                        >
                            <section>
                                <h2 className="uc-heading">
                                    <Server size={18} />
                                    Server
                                </h2>
                                <Field
                                    label="Server name"
                                    error={settings.errors.server_name}
                                >
                                    <div className="uc-field">
                                        <input
                                            required
                                            maxLength={64}
                                            value={settings.data.server_name}
                                            onChange={(e) =>
                                                settings.setData(
                                                    'server_name',
                                                    e.target.value,
                                                )
                                            }
                                        />
                                    </div>
                                </Field>
                                <Field
                                    label="Listen address"
                                    hint="Managed by the web server and APP_URL."
                                >
                                    <div className="uc-field">
                                        <input
                                            readOnly
                                            value={cloud.server.url}
                                        />
                                    </div>
                                </Field>
                                <Field
                                    label="Storage root"
                                    hint="Content is stored once per SHA-256, in each device’s archive."
                                >
                                    <div className="uc-field">
                                        <input
                                            readOnly
                                            value={cloud.server.storage_root}
                                        />
                                    </div>
                                </Field>
                            </section>
                            <section>
                                <h2 className="uc-heading">
                                    Defaults for new devices
                                </h2>
                                <Field
                                    label="Pull interval"
                                    hint="Seconds. Minimum is 5 seconds."
                                    error={settings.errors.pull_interval}
                                >
                                    <div className="uc-field">
                                        <input
                                            type="number"
                                            min={5}
                                            max={86400}
                                            required
                                            value={settings.data.pull_interval}
                                            onChange={(e) =>
                                                settings.setData(
                                                    'pull_interval',
                                                    Number(e.target.value),
                                                )
                                            }
                                        />
                                    </div>
                                </Field>
                                <label className="uc-switch-row">
                                    <span className="uc-label">
                                        Automatically pull new files
                                    </span>
                                    <input
                                        type="checkbox"
                                        role="switch"
                                        aria-label="Automatically pull new files"
                                        checked={settings.data.auto_pull}
                                        onChange={(e) =>
                                            settings.setData(
                                                'auto_pull',
                                                e.target.checked,
                                            )
                                        }
                                    />
                                </label>
                                <p className="uc-input-hint">
                                    {cloud.server.scheduler_last_seen
                                        ? `Scheduler online · checked ${ago(cloud.server.scheduler_last_seen)}.`
                                        : 'Scheduler offline. Automatic pulls need the server scheduler.'}
                                </p>
                                <p className="uc-input-hint">
                                    {cloud.server.worker_last_seen
                                        ? `Transfer worker online · checked ${ago(cloud.server.worker_last_seen)}.`
                                        : 'Transfer worker has not checked in. Queued pulls need the USBCloud worker.'}
                                </p>
                                <Field
                                    label="Conflict policy"
                                    hint="Changed content is saved as another version. Existing copies are retained."
                                >
                                    <div className="uc-field">
                                        <input
                                            readOnly
                                            value="Keep all versions (SHA-256)"
                                        />
                                    </div>
                                </Field>
                                <Select
                                    label="Theme"
                                    value={theme}
                                    options={[
                                        ['phosphor', 'Phosphor'],
                                        ['paper', 'Paper'],
                                    ]}
                                    onChange={(value) =>
                                        settings.setData(
                                            'theme',
                                            value as Theme,
                                        )
                                    }
                                />
                            </section>
                            <div className="uc-settings-actions">
                                <Button
                                    disabled={
                                        !settings.isDirty || settings.processing
                                    }
                                    onClick={() => {
                                        settings.reset();
                                        settings.clearErrors();
                                    }}
                                >
                                    Discard
                                </Button>
                                <Button
                                    type="submit"
                                    variant="primary"
                                    disabled={
                                        !settings.isDirty || settings.processing
                                    }
                                >
                                    <Check size={16} />
                                    {settings.processing
                                        ? 'Saving…'
                                        : 'Save settings'}
                                </Button>
                            </div>
                        </form>
                    )}
                </main>
                <Dialog
                    open={!!unmount}
                    onOpenChange={(open) => {
                        if (!open) setUnmount(null);
                    }}
                >
                    <DialogContent
                        className="usbcloud uc-confirm"
                        data-theme={theme}
                    >
                        <DialogTitle className="uc-heading">
                            Unmount {unmount?.name}?
                        </DialogTitle>
                        <DialogDescription className="uc-data">
                            The USB disk will disconnect from the attached
                            device. Recording to USB stops until you mount it
                            again. Saved files stay on the server.
                        </DialogDescription>
                        <div className="uc-confirm-actions">
                            <Button
                                variant="ghost"
                                onClick={() => setUnmount(null)}
                            >
                                Keep mounted
                            </Button>
                            <Button
                                variant="inverse"
                                onClick={() => {
                                    const id = unmount!.id;
                                    setUnmount(null);
                                    void run('unmount', id);
                                }}
                            >
                                <Unplug size={16} />
                                Unmount
                            </Button>
                        </div>
                    </DialogContent>
                </Dialog>
                <Dialog
                    open={!!remove}
                    onOpenChange={(open) => {
                        if (!open) setRemove(null);
                    }}
                >
                    <DialogContent
                        className="usbcloud uc-confirm"
                        data-theme={theme}
                    >
                        <DialogTitle className="uc-heading">
                            Remove {remove?.name}?
                        </DialogTitle>
                        <DialogDescription className="uc-data">
                            This device will leave the fleet. Saved files stay
                            on the server, and the Pi remains running. You can
                            add it again by address.
                        </DialogDescription>
                        <div className="uc-confirm-actions">
                            <Button
                                variant="ghost"
                                onClick={() => setRemove(null)}
                            >
                                Keep device
                            </Button>
                            <Button
                                variant="inverse"
                                disabled={!!working}
                                onClick={() =>
                                    void perform(
                                        'Removing device…',
                                        async () => {
                                            const result = await json<{
                                                message: string;
                                            }>(
                                                removeDevice.url(remove!.id),
                                                'DELETE',
                                            );
                                            setRemove(null);
                                            navigate('devices');
                                            notify(result.message);
                                        },
                                    )
                                }
                            >
                                <Trash2 size={16} />
                                Remove device
                            </Button>
                        </div>
                    </DialogContent>
                </Dialog>
                <Dialog open={addOpen} onOpenChange={setAddOpen}>
                    <DialogContent
                        className="usbcloud uc-confirm uc-add-device-dialog"
                        data-theme={theme}
                    >
                        <DialogTitle className="uc-heading">
                            Add a device
                        </DialogTitle>
                        <DialogDescription className="uc-data">
                            Install a new Pi with one command, or connect an
                            existing client.
                        </DialogDescription>
                        {existingClient && (
                            <section className="uc-stack">
                                <div className="uc-between">
                                    <h2 className="uc-label uc-muted">
                                        Discovered on this network
                                    </h2>
                                    <Button
                                        small
                                        disabled={scanBusy}
                                        onClick={() => void scan()}
                                    >
                                        <RefreshCw
                                            size={14}
                                            className={
                                                scanBusy ? 'uc-spinning' : ''
                                            }
                                        />
                                        {scanBusy ? 'Scanning…' : 'Rescan'}
                                    </Button>
                                </div>
                                <p className="uc-data uc-muted" role="status">
                                    {scanMessage}
                                </p>
                                <div className="uc-discovery-list">
                                    {found.map((f) => (
                                        <div
                                            className="uc-discovery-result"
                                            key={`${f.host}:${f.port}`}
                                        >
                                            <div>
                                                <strong className="uc-data">
                                                    {f.name ?? f.host}
                                                </strong>
                                                <div className="uc-data uc-muted">
                                                    {f.host}:{f.port}
                                                </div>
                                            </div>
                                            {f.id ? (
                                                <Button
                                                    small
                                                    onClick={() => {
                                                        setAddOpen(false);
                                                        openDevice(f.id!);
                                                    }}
                                                >
                                                    Open {f.id}
                                                </Button>
                                            ) : (
                                                <Button
                                                    small
                                                    onClick={() =>
                                                        setAddForm((old) => ({
                                                            ...old,
                                                            host: f.host,
                                                            port: f.port,
                                                        }))
                                                    }
                                                >
                                                    Use address
                                                </Button>
                                            )}
                                        </div>
                                    ))}
                                    {!found.length && !scanBusy && (
                                        <p className="uc-data uc-muted">
                                            No clients found. Enter a hostname
                                            or IP below.
                                        </p>
                                    )}
                                </div>
                            </section>
                        )}
                        <form
                            className="uc-stack"
                            onSubmit={async (e) => {
                                e.preventDefault();
                                setAddError('');
                                await perform(
                                    existingClient
                                        ? 'Connecting to device…'
                                        : 'Preparing installer…',
                                    async () => {
                                        try {
                                            if (!existingClient) {
                                                setInstallation(
                                                    await json<{
                                                        command: string;
                                                        expires_at: string;
                                                    }>(
                                                        createInstallation.url(),
                                                        'POST',
                                                        {
                                                            ...addForm,
                                                            installer_profile:
                                                                installerProfile,
                                                            storage_size_gib:
                                                                storageSize ===
                                                                ''
                                                                    ? null
                                                                    : Number(
                                                                          storageSize,
                                                                      ),
                                                        },
                                                    ),
                                                );
                                                setCopyMessage('');
                                                return;
                                            }
                                            const result = await json<{
                                                device: string;
                                            }>(
                                                addDevice.url(),
                                                'POST',
                                                addForm,
                                            );
                                            setAddOpen(false);
                                            setAddForm({
                                                host: '',
                                                port: 22,
                                                user: 'pi',
                                                name: '',
                                            });
                                            setSelected(result.device);
                                            notify(`Added ${result.device}.`);
                                        } catch (failure) {
                                            setAddError(
                                                failure instanceof Error
                                                    ? failure.message
                                                    : 'Connection failed. Retry.',
                                            );
                                        }
                                    },
                                );
                            }}
                        >
                            <h2 className="uc-label uc-muted">
                                {existingClient
                                    ? 'Connect by address'
                                    : 'Install new client'}
                            </h2>
                            <label className="uc-data">
                                <input
                                    type="checkbox"
                                    checked={existingClient}
                                    onChange={(event) => {
                                        setExistingClient(event.target.checked);
                                        if (!event.target.checked) {
                                            setAddForm((old) => ({
                                                ...old,
                                                port: 22,
                                            }));
                                        }
                                        setAddError('');
                                        if (event.target.checked) void scan();
                                    }}
                                />{' '}
                                Client is already installed
                            </label>
                            {!existingClient && (
                                <div className="uc-stack">
                                    <MultiSelect
                                        label="Device profile"
                                        multiple={false}
                                        values={[installerProfile]}
                                        options={cloud.server.installer_profiles.map(
                                            (profile) => [
                                                profile.id,
                                                profile.name,
                                            ],
                                        )}
                                        onChange={([value]) =>
                                            setInstallerProfile(value)
                                        }
                                    />
                                    <p className="uc-input-hint" role="status">
                                        {selectedInstallerProfile?.description}
                                    </p>
                                </div>
                            )}
                            <div className="uc-two-fields">
                                <Field label="Hostname or IP">
                                    <div className="uc-field">
                                        <input
                                            required
                                            value={addForm.host}
                                            placeholder="pi-garage.local"
                                            onChange={(e) =>
                                                setAddForm((old) => ({
                                                    ...old,
                                                    host: e.target.value,
                                                }))
                                            }
                                        />
                                    </div>
                                </Field>
                                <Field label="Device name">
                                    <div className="uc-field">
                                        <input
                                            value={addForm.name}
                                            placeholder="Optional"
                                            onChange={(e) =>
                                                setAddForm((old) => ({
                                                    ...old,
                                                    name: e.target.value,
                                                }))
                                            }
                                        />
                                    </div>
                                </Field>
                                <Field label="SSH port">
                                    <div className="uc-field">
                                        <input
                                            type="number"
                                            min={1}
                                            max={65535}
                                            required
                                            value={addForm.port}
                                            disabled={!existingClient}
                                            onChange={(e) =>
                                                setAddForm((old) => ({
                                                    ...old,
                                                    port: Number(
                                                        e.target.value,
                                                    ),
                                                }))
                                            }
                                        />
                                    </div>
                                </Field>
                                <Field label="Username">
                                    <div className="uc-field">
                                        <input
                                            required
                                            value={addForm.user}
                                            onChange={(e) =>
                                                setAddForm((old) => ({
                                                    ...old,
                                                    user: e.target.value,
                                                }))
                                            }
                                        />
                                    </div>
                                </Field>
                            </div>
                            {!existingClient && (
                                <Field
                                    label="USB storage size (GiB, optional)"
                                    hint="Leave blank to choose on the Pi. The installer checks free space and reserves room for snapshots and the operating system."
                                >
                                    <div className="uc-field">
                                        <input
                                            type="number"
                                            min={1}
                                            max={65536}
                                            step={1}
                                            value={storageSize}
                                            placeholder="Choose during installation"
                                            onChange={(event) =>
                                                setStorageSize(
                                                    event.target.value,
                                                )
                                            }
                                        />
                                    </div>
                                </Field>
                            )}
                            <p className="uc-input-hint">
                                {existingClient
                                    ? 'Use this for a configured client with SSH access and a trusted host key already on the server.'
                                    : 'Enter the Pi’s address and the username chosen in Raspberry Pi Imager. Use SSH port 22. The installer configures USB storage, SSH access, and health reporting. Keep the USB data cable disconnected until setup finishes.'}
                            </p>
                            {installation && (
                                <section
                                    className="uc-stack"
                                    aria-label="Installation command"
                                >
                                    <p className="uc-data">
                                        Run this command in the Pi’s terminal,
                                        then follow its reboot instructions.
                                    </p>
                                    <code className="uc-data uc-break">
                                        {installation.command}
                                    </code>
                                    <p className="uc-input-hint">
                                        Private setup command · expires{' '}
                                        {date(installation.expires_at)}. It
                                        registers one Pi; rerunning it preserves
                                        recordings.
                                    </p>
                                    <Button
                                        onClick={() =>
                                            void navigator.clipboard
                                                .writeText(installation.command)
                                                .then(() =>
                                                    setCopyMessage(
                                                        'Installation command copied.',
                                                    ),
                                                )
                                                .catch(() =>
                                                    setCopyMessage(
                                                        'Select and copy the command above.',
                                                    ),
                                                )
                                        }
                                    >
                                        Copy installation command
                                    </Button>
                                    <p className="uc-data" role="status">
                                        {copyMessage ||
                                            'The device appears in your fleet when the installer registers it.'}
                                    </p>
                                </section>
                            )}

                            {addError && (
                                <p className="uc-data uc-break" role="alert">
                                    {addError}
                                </p>
                            )}
                            <div className="uc-confirm-actions">
                                <Button
                                    variant="ghost"
                                    onClick={() => setAddOpen(false)}
                                >
                                    Done
                                </Button>
                                <Button
                                    type="submit"
                                    variant="primary"
                                    disabled={!!working}
                                >
                                    <PlugZap size={16} />
                                    {working
                                        ? 'Preparing…'
                                        : existingClient
                                          ? 'Connect & add'
                                          : installation
                                            ? 'Generate another command'
                                            : 'Generate installation command'}
                                </Button>
                            </div>
                        </form>
                    </DialogContent>
                </Dialog>
            </div>
        </MultiSelectTheme.Provider>
    );
}
