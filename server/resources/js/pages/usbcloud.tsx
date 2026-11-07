import { Head, router, useHttp, usePoll } from '@inertiajs/react';
import {
    Check,
    ChevronDown,
    ChevronRight,
    CloudDownload,
    Download,
    Folder,
    HardDrive,
    Menu,
    PlugZap,
    RefreshCw,
    Search,
    Server,
    Settings2,
    SlidersHorizontal,
    Terminal,
    Unplug,
    X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import {
    file as downloadFile,
    download,
    operate,
    settings as saveSettings,
} from '@/actions/App/Http/Controllers/UsbCloudController';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from '@/components/ui/dialog';
import '../../css/usbcloud.css';

type Theme = 'phosphor' | 'paper';
type DeviceAction = 'refresh' | 'pull' | 'mount' | 'unmount';
type PendingOperation = { action: DeviceAction; device?: string };
type LogPaneState = { id: string; source: string };
type LogRowState = { id: string; panes: LogPaneState[] };
type Screen = 'devices' | 'files' | 'log' | 'settings';
type Status = 'online' | 'syncing' | 'offline' | 'fault';
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
    filesystem: {
        type: string | null;
        mount: string;
        used_bytes: number;
        total_bytes: number;
        free_bytes: number;
    } | null;
    pending: number | null;
    last_sync: string | null;
    scanned_at: string | null;
    checked_at: string;
    last_file: string | null;
};
type StoredFile = {
    id: string;
    device: string;
    name: string;
    bytes: number;
    sha256: string;
    modified_at: string | null;
    saved_at: string | null;
    state: 'pending' | 'pulled';
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
        url: string;
        storage_root: string;
        scheduler_last_seen: string | null;
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
function Meter({ device }: { device: Device }) {
    const fs = device.filesystem;
    const used = fs ? Math.ceil((fs.used_bytes / fs.total_bytes) * 24) : 0;
    return (
        <div className="uc-meter">
            <div className="uc-meter-head">
                <span className="uc-label uc-muted">Storage</span>
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
function LogPane({ entries, title }: { entries: LogEntry[]; title: string }) {
    const [follow, setFollow] = useState(true);
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
    }, [follow, last?.at, last?.message, entries.length]);
    return (
        <section className="uc-log">
            <header className="uc-log-head">
                <span className="uc-label">{title}</span>
                <div className="uc-inline">
                    <span className="uc-label uc-log-count">
                        {entries.length} entries
                    </span>
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

export default function UsbCloudPage({ cloud }: { cloud: Cloud }) {
    const [screen, setScreen] = useState<Screen>('devices');
    const [tab, setTab] = useState('all');
    const [fileTab, setFileTab] = useState('pending');
    const [selected, setSelected] = useState(cloud.devices[0]?.id ?? '');
    const [query, setQuery] = useState('');
    const [deviceFilter, setDeviceFilter] = useState('');
    const [showFind, setShowFind] = useState(false);
    const [showFilter, setShowFilter] = useState(false);
    const [pendingOnly, setPendingOnly] = useState(false);
    const [mobileNav, setMobileNav] = useState(false);
    const [operations, setOperations] = useState<
        Record<string, PendingOperation>
    >({});
    const pendingOperations = useRef(new Set<string>());
    const busy = Object.values(operations).some(
        (operation) => operation.action !== 'refresh',
    );
    const working = Object.keys(operations).length > 0;
    const refreshing = (device?: string) =>
        Object.values(operations).some(
            (operation) =>
                operation.action === 'refresh' &&
                (!device || !operation.device || operation.device === device),
        );
    const deviceBusy = (device: string) =>
        Object.values(operations).some(
            (operation) =>
                operation.action !== 'refresh' &&
                (!operation.device || operation.device === device),
        );
    const [message, setMessage] = useState('');
    const [error, setError] = useState(false);
    const [activity, setActivity] = useState('');
    const [unmount, setUnmount] = useState<Device | null>(null);
    const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
    const [preview, setPreview] = useState<StoredFile | null>(null);
    const [logRows, setLogRows] = useState<LogRowState[]>([
        { id: 'row-0', panes: [{ id: 'pane-0', source: 'server' }] },
    ]);
    const nextLogId = useRef(1);
    const unmountTrigger = useRef<HTMLButtonElement>(null);
    const previewTrigger = useRef<HTMLButtonElement>(null);
    function createPane(source: string): LogPaneState {
        return { id: `pane-${nextLogId.current++}`, source };
    }
    function createRow(...sources: string[]): LogRowState {
        return {
            id: `row-${nextLogId.current++}`,
            panes: sources.map(createPane),
        };
    }

    const search = useRef<HTMLInputElement>(null);
    const notice = useRef<HTMLDivElement>(null);
    const settings = useHttp<CloudSettings, { settings: CloudSettings }>(
        cloud.settings,
    );
    const logDeviceKey =
        screen === 'log'
            ? [
                  ...new Set(
                      logRows
                          .flatMap((row) =>
                              row.panes.map((pane) => pane.source),
                          )
                          .filter((source) => source !== 'server'),
                  ),
              ]
                  .sort()
                  .join(',')
            : '';
    const logDevices = () => (logDeviceKey ? logDeviceKey.split(',') : []);
    usePoll(5000, () => ({
        only: ['cloud'],
        data: { log_devices: logDevices() },
    }));
    useEffect(() => {
        if (screen === 'log')
            router.reload({
                only: ['cloud'],
                data: {
                    log_devices: logDeviceKey ? logDeviceKey.split(',') : [],
                },
            });
    }, [screen, logDeviceKey]);
    const active =
        cloud.devices.find((device) => device.id === selected) ??
        cloud.devices[0];
    const pending = cloud.files.filter(
        (file) => file.state === 'pending',
    ).length;
    const unscanned = cloud.devices.filter(
        (device) => device.pending == null,
    ).length;
    const statusCount = (status: Status) =>
        cloud.devices.filter((device) => device.status === status).length;
    const visible = cloud.devices.filter(
        (device) =>
            (tab === 'all' || device.status === tab) &&
            (!pendingOnly || (device.pending ?? 0) > 0) &&
            `${device.id} ${device.name} ${device.address}`
                .toLowerCase()
                .includes(query.toLowerCase()),
    );
    const files = cloud.files.filter(
        (file) =>
            (fileTab === 'all' || file.state === fileTab) &&
            (!deviceFilter || file.device === deviceFilter) &&
            `${file.name} ${file.device}`
                .toLowerCase()
                .includes(query.toLowerCase()),
    );
    const downloadable = selectedFiles.filter((id) =>
        cloud.files.some((file) => file.id === id && file.state === 'pulled'),
    );
    const theme = settings.data.theme;
    const navigate = (next: Screen) => {
        setScreen(next);
        setQuery('');
        setMobileNav(false);
        setMessage('');
    };

    async function run(action: DeviceAction, device?: string) {
        const key = `${action === 'refresh' ? 'refresh' : 'write'}:${device ?? '*'}`;
        if (
            pendingOperations.current.has(key) ||
            (action === 'refresh'
                ? refreshing(device)
                : device
                  ? deviceBusy(device)
                  : busy)
        )
            return;
        pendingOperations.current.add(key);
        setOperations((previous) => ({
            ...previous,
            [key]: { action, device },
        }));
        setError(false);
        setMessage('');
        setActivity(`${device ?? 'Fleet'}: ${action} started…`);
        let failures = false;
        let results = 0;
        try {
            const csrf = document.cookie
                .split('; ')
                .find((cookie) => cookie.startsWith('XSRF-TOKEN='))
                ?.slice(11);
            const response = await fetch(operate.url(), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    'X-XSRF-TOKEN': decodeURIComponent(csrf ?? ''),
                },
                body: JSON.stringify({ action, device }),
            });
            if (!response.ok)
                throw new Error(
                    (await response.json()).message ??
                        'Device request failed. Retry.',
                );
            const reader = response.body?.getReader();
            if (!reader)
                throw new Error(
                    'The operation stream is unavailable. Refresh and retry.',
                );
            const decoder = new TextDecoder();
            let remaining = '';
            const receive = (line: string) => {
                if (!line.trim()) return;
                const event = JSON.parse(line) as {
                    type: string;
                    message: string;
                    success?: boolean;
                };
                setActivity(event.message);
                if (event.type === 'result') {
                    results++;
                    failures ||= !event.success;
                    setMessage((previous) =>
                        previous
                            ? `${previous} ${event.message}`
                            : event.message,
                    );
                }
            };
            while (true) {
                const chunk = await reader.read();
                remaining += decoder.decode(chunk.value, {
                    stream: !chunk.done,
                });
                const lines = remaining.split('\n');
                remaining = lines.pop() ?? '';
                lines.forEach(receive);
                if (chunk.done) break;
            }
            receive(remaining);
            if (!results)
                throw new Error(
                    'Connection ended before a result arrived. Refresh to check the device before retrying.',
                );
            setError(failures);
        } catch (failure) {
            setError(true);
            setMessage(
                failure instanceof Error
                    ? failure.message
                    : 'Device operation failed. Retry.',
            );
        } finally {
            pendingOperations.current.delete(key);
            setOperations((previous) => {
                const next = { ...previous };
                delete next[key];
                return next;
            });
            if (!pendingOperations.current.size) setActivity('');
            router.reload({
                only: ['cloud'],
                data: { log_devices: logDevices() },
            });
            notice.current?.focus();
        }
    }
    function changeLog(rowId: string, paneId: string, source: string | null) {
        setLogRows((rows) =>
            rows
                .map((row) =>
                    row.id !== rowId
                        ? row
                        : {
                              ...row,
                              panes:
                                  source === null
                                      ? row.panes.filter(
                                            (pane) => pane.id !== paneId,
                                        )
                                      : row.panes.map((pane) =>
                                            pane.id === paneId
                                                ? { ...pane, source }
                                                : pane,
                                        ),
                          },
                )
                .filter((row) => row.panes.length),
        );
    }
    function exportLogs() {
        const sources = new Set(
            logRows.flatMap((row) => row.panes.map((pane) => pane.source)),
        );
        const entries = [...sources]
            .flatMap((source) =>
                source === 'server'
                    ? cloud.logs.server
                    : (cloud.logs.devices[source] ?? []),
            )
            .sort((a, b) => a.at.localeCompare(b.at));
        const url = URL.createObjectURL(
            new Blob(
                [
                    entries
                        .map(
                            (entry) =>
                                `${entry.at} ${entry.level.toUpperCase()} ${entry.source} [${entry.origin}] ${entry.device ? `[${entry.device}] ` : ''}${entry.message}`,
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
    async function submitSettings(event: React.SubmitEvent<HTMLFormElement>) {
        event.preventDefault();
        setMessage('');
        setError(false);
        try {
            const response = await settings.put(saveSettings.url());
            settings.setDefaults(response.settings);
            setMessage('Settings saved.');
            router.reload({ only: ['cloud'] });
        } catch {
            setError(true);
            setMessage(
                'Settings could not be saved. Check the fields and retry.',
            );
        }
    }
    const title = {
        devices: 'Fleet overview',
        files: 'Files',
        log: 'Logs',
        settings: 'Settings',
    }[screen];
    return (
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
                    <span className="uc-sidenav-version">v0.2.1</span>
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
                        ],
                    },
                    {
                        label: 'Server',
                        items: [
                            {
                                id: 'log' as const,
                                label: 'Log',
                                icon: Terminal,
                            },
                            {
                                id: 'settings' as const,
                                label: 'Settings',
                                icon: Settings2,
                            },
                        ],
                    },
                ].map((group) => (
                    <div className="uc-sidenav-section" key={group.label}>
                        <div className="uc-sidenav-label uc-label">
                            {group.label}
                        </div>
                        <ul className="uc-sidenav-list">
                            {group.items.map((item) => (
                                <li key={item.id}>
                                    <button
                                        type="button"
                                        className={`uc-sidenav-item ${screen === item.id ? 'uc-sidenav-item-active' : ''}`}
                                        aria-current={
                                            screen === item.id
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
                                        {'count' in item && (
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
                            {screen === 'devices' || screen === 'files'
                                ? 'Fleet'
                                : 'Server'}
                        </div>
                        <h1 className="uc-title uc-toolbar-title">{title}</h1>
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
                        {screen === 'devices' && (
                            <>
                                <Button
                                    variant="ghost"
                                    aria-expanded={showFind}
                                    onClick={() => {
                                        setShowFind(!showFind);
                                        requestAnimationFrame(() =>
                                            search.current?.focus(),
                                        );
                                    }}
                                >
                                    <Search size={16} />
                                    Find
                                </Button>
                                <Button
                                    aria-expanded={showFilter}
                                    onClick={() => setShowFilter(!showFilter)}
                                >
                                    <SlidersHorizontal size={16} />
                                    Filter
                                </Button>
                                <Button
                                    disabled={refreshing()}
                                    aria-label="Refresh all devices"
                                    onClick={() => void run('refresh')}
                                >
                                    <RefreshCw
                                        size={16}
                                        className={
                                            refreshing() ? 'uc-spinning' : ''
                                        }
                                    />
                                    {refreshing() ? 'Refreshing…' : 'Refresh'}
                                </Button>
                                <Button
                                    variant="primary"
                                    disabled={busy}
                                    onClick={() => void run('pull')}
                                >
                                    <CloudDownload size={16} />
                                    {busy ? 'Working…' : 'Pull new files'}
                                </Button>
                            </>
                        )}
                        {screen === 'files' && (
                            <>
                                <div className="uc-field uc-file-search">
                                    <span className="uc-field-prefix">/</span>
                                    <input
                                        aria-label="Filter files"
                                        value={query}
                                        placeholder="Filter by name or device"
                                        onChange={(event) =>
                                            setQuery(event.target.value)
                                        }
                                    />
                                </div>
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
                                    disabled={busy}
                                    onClick={() =>
                                        void run(
                                            'pull',
                                            deviceFilter || undefined,
                                        )
                                    }
                                >
                                    <CloudDownload size={16} />
                                    Pull pending
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
                                        setLogRows((rows) => [
                                            ...rows,
                                            createRow('server'),
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
                                    router.reload({
                                        only: ['cloud'],
                                        onSuccess: (page) =>
                                            settings.setData(
                                                (page.props.cloud as Cloud)
                                                    .settings,
                                            ),
                                    });
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
                                label: status === 'fault' ? 'Faults' : status,
                                count: statusCount(status),
                            })),
                        ]}
                    />
                )}
                {screen === 'files' && (
                    <Tabs
                        label="File state"
                        value={fileTab}
                        onChange={setFileTab}
                        items={[
                            { id: 'pending', label: 'Pending', count: pending },
                            {
                                id: 'pulled',
                                label: 'Pulled',
                                count: cloud.files.length - pending,
                            },
                            {
                                id: 'all',
                                label: 'All',
                                count: cloud.files.length,
                            },
                        ]}
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
                            {activity}
                        </>
                    ) : (
                        <>
                            {error ? <X size={16} /> : <Check size={16} />}
                            {message}
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
                {screen === 'devices' && (
                    <div className="uc-page">
                        {(showFind || showFilter) && (
                            <div className="uc-filter-row">
                                {showFind && (
                                    <div className="uc-field">
                                        <Search size={16} />
                                        <input
                                            ref={search}
                                            aria-label="Find a device"
                                            placeholder="ID, name, or address"
                                            value={query}
                                            onChange={(event) =>
                                                setQuery(event.target.value)
                                            }
                                        />
                                    </div>
                                )}
                                {showFilter && (
                                    <label className="uc-inline uc-data">
                                        <input
                                            type="checkbox"
                                            checked={pendingOnly}
                                            onChange={(event) =>
                                                setPendingOnly(
                                                    event.target.checked,
                                                )
                                            }
                                        />
                                        With pending files
                                    </label>
                                )}
                                {(query || pendingOnly || tab !== 'all') && (
                                    <Button
                                        small
                                        variant="ghost"
                                        onClick={() => {
                                            setQuery('');
                                            setPendingOnly(false);
                                            setTab('all');
                                        }}
                                    >
                                        Clear filters
                                    </Button>
                                )}
                            </div>
                        )}
                        <div className="uc-stats">
                            {[
                                [
                                    'Devices',
                                    cloud.devices.length,
                                    `${statusCount('online')} online · ${statusCount('offline')} offline`,
                                ],
                                [
                                    'Syncing',
                                    statusCount('syncing'),
                                    `${cloud.devices.filter((d) => d.operation === 'pull').length} pulls in progress`,
                                ],
                                [
                                    'Pending files',
                                    unscanned
                                        ? pending
                                            ? `${pending}+`
                                            : '—'
                                        : pending,
                                    unscanned
                                        ? `${unscanned} ${unscanned === 1 ? 'device needs' : 'devices need'} a pull`
                                        : `across ${cloud.devices.filter((d) => (d.pending ?? 0) > 0).length} devices`,
                                ],
                                [
                                    'Faults',
                                    statusCount('fault'),
                                    cloud.devices.find(
                                        (d) => d.status === 'fault',
                                    )?.id ?? '0 faults',
                                ],
                            ].map(([label, value, line]) => (
                                <div className="uc-stat" key={label}>
                                    <div className="uc-label uc-muted">
                                        {label}
                                    </div>
                                    <div
                                        className={`uc-stat-value ${label === 'Syncing' ? 'uc-accent' : ''}`}
                                    >
                                        <span
                                            className={
                                                label === 'Faults' &&
                                                Number(value) > 0
                                                    ? 'uc-inverse'
                                                    : ''
                                            }
                                        >
                                            {value}
                                        </span>
                                    </div>
                                    <div className="uc-data uc-muted">
                                        {line}
                                    </div>
                                </div>
                            ))}
                        </div>
                        <div className="uc-fleet-layout">
                            <div className="uc-table-wrap">
                                <table className="uc-table uc-data">
                                    <caption className="uc-label">
                                        {visible.length} of{' '}
                                        {cloud.devices.length} devices
                                    </caption>
                                    <thead>
                                        <tr>
                                            <th
                                                scope="col"
                                                className="uc-label"
                                            >
                                                Device
                                            </th>
                                            <th
                                                scope="col"
                                                className="uc-label"
                                            >
                                                Name
                                            </th>
                                            <th
                                                scope="col"
                                                className="uc-label"
                                            >
                                                Status
                                            </th>
                                            <th
                                                scope="col"
                                                className="uc-label uc-right"
                                            >
                                                Used
                                            </th>
                                            <th
                                                scope="col"
                                                className="uc-label uc-right"
                                            >
                                                Pending
                                            </th>
                                            <th
                                                scope="col"
                                                className="uc-label"
                                            >
                                                Mount
                                            </th>
                                            <th
                                                scope="col"
                                                className="uc-label uc-right"
                                            >
                                                Last sync
                                            </th>
                                            <th scope="col">
                                                <span className="uc-sr-only">
                                                    Actions
                                                </span>
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {visible.map((device) => (
                                            <tr
                                                key={device.id}
                                                className={`uc-tr-selectable ${active?.id === device.id ? 'uc-tr-selected' : ''}`}
                                                onClick={() =>
                                                    setSelected(device.id)
                                                }
                                            >
                                                <td className="uc-key">
                                                    <button
                                                        className="uc-row-select"
                                                        type="button"
                                                        aria-pressed={
                                                            active?.id ===
                                                            device.id
                                                        }
                                                        onClick={() =>
                                                            setSelected(
                                                                device.id,
                                                            )
                                                        }
                                                    >
                                                        {device.id}
                                                    </button>
                                                </td>
                                                <td>{device.name}</td>
                                                <td>
                                                    <Badge
                                                        status={device.status}
                                                    />
                                                </td>
                                                <td className="uc-right">
                                                    {bytes(
                                                        device.filesystem
                                                            ?.used_bytes,
                                                    )}
                                                </td>
                                                <td className="uc-right">
                                                    {device.pending ?? '—'}
                                                </td>
                                                <td className="uc-muted">
                                                    {device.filesystem?.mount ??
                                                        '—'}
                                                </td>
                                                <td
                                                    className="uc-right uc-muted"
                                                    title={date(
                                                        device.last_sync,
                                                    )}
                                                >
                                                    {ago(device.last_sync)}
                                                </td>
                                                <td>
                                                    <Button
                                                        small
                                                        variant="ghost"
                                                        disabled={refreshing(
                                                            device.id,
                                                        )}
                                                        aria-label={`Refresh ${device.id}`}
                                                        onClick={(event) => {
                                                            event.stopPropagation();
                                                            void run(
                                                                'refresh',
                                                                device.id,
                                                            );
                                                        }}
                                                    >
                                                        <RefreshCw size={14} />
                                                        Refresh
                                                    </Button>
                                                </td>
                                            </tr>
                                        ))}
                                        {!visible.length && (
                                            <tr>
                                                <td
                                                    colSpan={8}
                                                    className="uc-table-empty"
                                                >
                                                    0 devices match. Clear the
                                                    filters to see your devices.
                                                </td>
                                            </tr>
                                        )}
                                    </tbody>
                                </table>
                            </div>
                            {active && (
                                <aside className="uc-details">
                                    <section className="uc-card uc-card-selected">
                                        <div className="uc-card-head">
                                            <div>
                                                <div className="uc-card-id uc-data">
                                                    <HardDrive size={16} />
                                                    <span className="uc-card-id-text">
                                                        {active.id}
                                                    </span>
                                                </div>
                                                <h2 className="uc-heading uc-card-name">
                                                    {active.name}
                                                </h2>
                                            </div>
                                            <Badge status={active.status} />
                                        </div>
                                        <Meter device={active} />
                                        <dl className="uc-card-meta uc-data">
                                            <div>
                                                <dt className="uc-label">
                                                    Last sync
                                                </dt>
                                                <dd
                                                    title={date(
                                                        active.last_sync,
                                                    )}
                                                >
                                                    {ago(active.last_sync)}
                                                </dd>
                                            </div>
                                            <div>
                                                <dt className="uc-label">
                                                    Pending
                                                </dt>
                                                <dd>
                                                    {active.pending == null
                                                        ? 'Not scanned'
                                                        : `${active.pending} files`}
                                                </dd>
                                            </div>
                                        </dl>
                                        <div className="uc-card-actions">
                                            <Button
                                                small
                                                variant="ghost"
                                                disabled={refreshing(active.id)}
                                                onClick={() =>
                                                    void run(
                                                        'refresh',
                                                        active.id,
                                                    )
                                                }
                                            >
                                                <RefreshCw size={14} />
                                                Refresh
                                            </Button>
                                            <Button
                                                small
                                                variant="ghost"
                                                disabled={
                                                    deviceBusy(active.id) ||
                                                    !!active.operation ||
                                                    active.gadget_loaded ===
                                                        false
                                                }
                                                onClick={() =>
                                                    void run('pull', active.id)
                                                }
                                            >
                                                <CloudDownload size={14} />
                                                Pull
                                            </Button>
                                            <Button
                                                buttonRef={unmountTrigger}
                                                small
                                                disabled={
                                                    deviceBusy(active.id) ||
                                                    !!active.operation ||
                                                    active.gadget_loaded == null
                                                }
                                                onClick={() =>
                                                    active.gadget_loaded
                                                        ? setUnmount(active)
                                                        : void run(
                                                              'mount',
                                                              active.id,
                                                          )
                                                }
                                            >
                                                {active.gadget_loaded ? (
                                                    <Unplug size={14} />
                                                ) : (
                                                    <PlugZap size={14} />
                                                )}
                                                {active.gadget_loaded
                                                    ? 'Unmount'
                                                    : 'Mount'}
                                            </Button>
                                        </div>
                                    </section>
                                    {active.error && (
                                        <div
                                            className="uc-device-error uc-data"
                                            role="note"
                                        >
                                            <strong>
                                                {active.status === 'offline'
                                                    ? 'Device unavailable'
                                                    : 'Device needs attention'}
                                            </strong>
                                            <span>{active.error}</span>
                                            <span className="uc-muted">
                                                Check the device and connection,
                                                then Refresh.
                                            </span>
                                        </div>
                                    )}
                                    <section className="uc-detail-card">
                                        <h2 className="uc-label uc-muted">
                                            Details
                                        </h2>
                                        <dl className="uc-detail-list uc-data">
                                            {[
                                                [
                                                    'Mount',
                                                    active.filesystem?.mount ??
                                                        '—',
                                                ],
                                                ['Address', active.address],
                                                [
                                                    'Firmware',
                                                    active.firmware ?? '—',
                                                ],
                                                [
                                                    'Uptime',
                                                    uptime(
                                                        active.uptime_seconds,
                                                    ),
                                                ],
                                                [
                                                    'Filesystem',
                                                    active.filesystem?.type ??
                                                        '—',
                                                ],
                                                [
                                                    'Free',
                                                    bytes(
                                                        active.filesystem
                                                            ?.free_bytes,
                                                    ),
                                                ],
                                                [
                                                    'USB state',
                                                    active.usb_state ||
                                                        'Unknown',
                                                ],
                                                [
                                                    'Last file',
                                                    active.last_file ?? '—',
                                                ],
                                            ].map(([label, value]) => (
                                                <div key={label}>
                                                    <dt className="uc-label uc-muted">
                                                        {label}
                                                    </dt>
                                                    <dd title={value}>
                                                        {value}
                                                    </dd>
                                                </div>
                                            ))}
                                        </dl>
                                        <div className="uc-detail-footer uc-card-actions">
                                            <Button
                                                small
                                                variant="ghost"
                                                onClick={() => {
                                                    navigate('log');
                                                    setLogRows([
                                                        createRow(
                                                            active.id,
                                                            'server',
                                                        ),
                                                    ]);
                                                }}
                                            >
                                                <Terminal size={14} />
                                                Show log
                                            </Button>
                                            <Button
                                                small
                                                onClick={() => {
                                                    navigate('files');
                                                    setDeviceFilter(active.id);
                                                    setFileTab('all');
                                                }}
                                            >
                                                <Folder size={14} />
                                                Show files
                                            </Button>
                                        </div>
                                    </section>
                                    <p className="uc-data uc-muted uc-freshness">
                                        Status checked {ago(active.checked_at)}.
                                        <br />
                                        Inventory:{' '}
                                        {active.scanned_at
                                            ? ago(active.scanned_at)
                                            : 'not scanned'}
                                        .{' '}
                                        {active.scanned_at &&
                                            'Values reflect that snapshot.'}
                                    </p>
                                </aside>
                            )}
                        </div>
                    </div>
                )}
                {screen === 'files' && (
                    <div className="uc-page">
                        <div className="uc-filter-row">
                            <label className="uc-inline uc-data">
                                Device
                                <select
                                    className="uc-native-select"
                                    value={deviceFilter}
                                    onChange={(event) =>
                                        setDeviceFilter(event.target.value)
                                    }
                                >
                                    <option value="">All devices</option>
                                    {cloud.devices.map((device) => (
                                        <option
                                            key={device.id}
                                            value={device.id}
                                        >
                                            {device.id}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            {selectedFiles.length > 0 && (
                                <Button
                                    small
                                    variant="ghost"
                                    onClick={() => setSelectedFiles([])}
                                >
                                    Clear selection
                                </Button>
                            )}
                            <span className="uc-data uc-muted">
                                Archived copies are retained after source
                                deletion.
                            </span>
                        </div>
                        <div className="uc-table-wrap">
                            <table className="uc-table uc-data">
                                <caption className="uc-label">
                                    {files.length} files
                                    {unscanned
                                        ? ` · ${unscanned} devices not scanned`
                                        : ''}
                                </caption>
                                <thead>
                                    <tr>
                                        <th>
                                            <input
                                                type="checkbox"
                                                aria-label="Select all downloadable files"
                                                checked={
                                                    files.some(
                                                        (file) =>
                                                            file.state ===
                                                            'pulled',
                                                    ) &&
                                                    files
                                                        .filter(
                                                            (file) =>
                                                                file.state ===
                                                                'pulled',
                                                        )
                                                        .every((file) =>
                                                            selectedFiles.includes(
                                                                file.id,
                                                            ),
                                                        )
                                                }
                                                onChange={(event) =>
                                                    setSelectedFiles(
                                                        event.target.checked
                                                            ? files
                                                                  .filter(
                                                                      (file) =>
                                                                          file.state ===
                                                                          'pulled',
                                                                  )
                                                                  .slice(0, 100)
                                                                  .map(
                                                                      (file) =>
                                                                          file.id,
                                                                  )
                                                            : [],
                                                    )
                                                }
                                            />
                                        </th>
                                        {[
                                            'File',
                                            'Device',
                                            'Size',
                                            'Modified',
                                            'State',
                                            'Source',
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
                                    {files.map((file) => (
                                        <tr
                                            key={file.id}
                                            className={
                                                preview?.id === file.id
                                                    ? 'uc-tr-selected'
                                                    : ''
                                            }
                                        >
                                            <td>
                                                <input
                                                    type="checkbox"
                                                    aria-label={`Select ${file.name}`}
                                                    title={
                                                        file.state === 'pending'
                                                            ? 'Pull this file before downloading'
                                                            : 'Select for download'
                                                    }
                                                    disabled={
                                                        file.state ===
                                                            'pending' ||
                                                        (!selectedFiles.includes(
                                                            file.id,
                                                        ) &&
                                                            selectedFiles.length >=
                                                                100)
                                                    }
                                                    checked={selectedFiles.includes(
                                                        file.id,
                                                    )}
                                                    onChange={(event) =>
                                                        setSelectedFiles(
                                                            (previous) =>
                                                                event.target
                                                                    .checked
                                                                    ? [
                                                                          ...previous,
                                                                          file.id,
                                                                      ]
                                                                    : previous.filter(
                                                                          (
                                                                              id,
                                                                          ) =>
                                                                              id !==
                                                                              file.id,
                                                                      ),
                                                        )
                                                    }
                                                />
                                            </td>
                                            <td>
                                                <button
                                                    className="uc-row-select uc-file-name"
                                                    type="button"
                                                    onClick={(event) => {
                                                        previewTrigger.current =
                                                            event.currentTarget;
                                                        setPreview(file);
                                                    }}
                                                >
                                                    {file.name}
                                                </button>
                                            </td>
                                            <td>{file.device}</td>
                                            <td className="uc-right">
                                                {bytes(file.bytes)}
                                            </td>
                                            <td className="uc-right uc-muted">
                                                {date(file.modified_at)}
                                            </td>
                                            <td>
                                                <span
                                                    className={`uc-label ${file.state === 'pulled' ? 'uc-accent' : ''}`}
                                                >
                                                    {file.state}
                                                </span>
                                            </td>
                                            <td className="uc-muted">
                                                {file.on_device
                                                    ? 'On USB'
                                                    : 'Archive only'}
                                            </td>
                                        </tr>
                                    ))}
                                    {!files.length && (
                                        <tr>
                                            <td
                                                colSpan={7}
                                                className="uc-table-empty"
                                            >
                                                0 files match.{' '}
                                                {fileTab === 'pending' &&
                                                !unscanned
                                                    ? 'Your scanned files are already saved.'
                                                    : 'Pull from a device or adjust the filters.'}
                                            </td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                        {preview && (
                            <Dialog
                                open={preview !== null}
                                onOpenChange={(open) => {
                                    if (!open) setPreview(null);
                                }}
                            >
                                <DialogContent
                                    className="usbcloud uc-confirm uc-file-preview"
                                    data-theme={theme}
                                    onCloseAutoFocus={(event) => {
                                        event.preventDefault();
                                        previewTrigger.current?.focus();
                                    }}
                                >
                                    <DialogTitle className="uc-heading">
                                        {preview.name}
                                    </DialogTitle>
                                    <DialogDescription className="uc-data">
                                        {preview.device} ·{' '}
                                        {bytes(preview.bytes)} · {preview.state}
                                    </DialogDescription>
                                    {preview.state === 'pulled' &&
                                        /\.(mp4|webm)$/i.test(preview.name) && (
                                            <video
                                                controls
                                                preload="metadata"
                                                src={downloadFile.url(
                                                    preview.id,
                                                    {
                                                        query: {
                                                            preview: true,
                                                        },
                                                    },
                                                )}
                                            >
                                                <track kind="captions" />
                                            </video>
                                        )}
                                    <details className="uc-data">
                                        <summary>SHA-256</summary>
                                        <code>{preview.sha256}</code>
                                    </details>
                                    {preview.state === 'pulled' ? (
                                        <a
                                            className="uc-btn"
                                            href={downloadFile.url(preview.id)}
                                        >
                                            <Download size={16} />
                                            Download file
                                        </a>
                                    ) : (
                                        <Button
                                            disabled={busy}
                                            onClick={() =>
                                                void run('pull', preview.device)
                                            }
                                        >
                                            <CloudDownload size={16} />
                                            Pull from {preview.device}
                                        </Button>
                                    )}
                                </DialogContent>
                            </Dialog>
                        )}
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
                            <div className="uc-log-row" key={row.id}>
                                {row.panes.map(({ id: paneId, source }) => (
                                    <div
                                        className="uc-log-column"
                                        key={paneId}
                                        data-log-pane={paneId}
                                    >
                                        <div className="uc-inline">
                                            <label className="uc-log-source-select">
                                                <span className="uc-sr-only">
                                                    Log source
                                                </span>
                                                <select
                                                    className="uc-native-select"
                                                    value={source}
                                                    onChange={(event) =>
                                                        changeLog(
                                                            row.id,
                                                            paneId,
                                                            event.target.value,
                                                        )
                                                    }
                                                >
                                                    <option value="server">
                                                        {
                                                            cloud.settings
                                                                .server_name
                                                        }{' '}
                                                        · server
                                                    </option>
                                                    {cloud.devices.map(
                                                        (device) => (
                                                            <option
                                                                key={device.id}
                                                                value={
                                                                    device.id
                                                                }
                                                            >
                                                                {device.id} ·{' '}
                                                                {device.name}
                                                            </option>
                                                        ),
                                                    )}
                                                </select>
                                            </label>
                                            <Button
                                                variant="ghost"
                                                aria-label="Close this log"
                                                onClick={() =>
                                                    changeLog(
                                                        row.id,
                                                        paneId,
                                                        null,
                                                    )
                                                }
                                            >
                                                <X size={16} />
                                                Close
                                            </Button>
                                        </div>
                                        {source !== 'server' &&
                                            cloud.logs.errors[source] && (
                                                <p
                                                    className="uc-data uc-device-error"
                                                    role="alert"
                                                >
                                                    Log stream unavailable:{' '}
                                                    {cloud.logs.errors[source]}{' '}
                                                    Retrying automatically.
                                                </p>
                                            )}
                                        <LogPane
                                            title={
                                                source === 'server'
                                                    ? `${cloud.settings.server_name} · server`
                                                    : source
                                            }
                                            entries={
                                                source === 'server'
                                                    ? cloud.logs.server
                                                    : (cloud.logs.devices[
                                                          source
                                                      ] ?? [])
                                            }
                                        />
                                    </div>
                                ))}
                                <Button
                                    variant="ghost"
                                    className="uc-add-log"
                                    onClick={() =>
                                        setLogRows((rows) =>
                                            rows.map((r) =>
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
                                    setLogRows((rows) => [
                                        ...rows,
                                        createRow('server'),
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
                        onSubmit={(event) => void submitSettings(event)}
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
                                        value={settings.data.server_name}
                                        maxLength={64}
                                        onChange={(event) =>
                                            settings.setData(
                                                'server_name',
                                                event.target.value,
                                            )
                                        }
                                        required
                                    />
                                </div>
                            </Field>
                            <Field
                                label="Listen address"
                                hint="Managed by the web server and APP_URL."
                            >
                                <div className="uc-field">
                                    <input value={cloud.server.url} readOnly />
                                </div>
                            </Field>
                            <Field
                                label="Storage root"
                                hint="Configured on the server. Content is stored once per SHA-256."
                            >
                                <div className="uc-field">
                                    <span className="uc-field-prefix">
                                        &gt;
                                    </span>
                                    <input
                                        value={cloud.server.storage_root}
                                        readOnly
                                    />
                                </div>
                            </Field>
                        </section>
                        <section>
                            <h2 className="uc-heading">Sync</h2>
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
                                        value={settings.data.pull_interval}
                                        onChange={(event) =>
                                            settings.setData(
                                                'pull_interval',
                                                Number(event.target.value),
                                            )
                                        }
                                        required
                                    />
                                </div>
                            </Field>
                            <label className="uc-inline uc-data">
                                <input
                                    type="checkbox"
                                    checked={settings.data.auto_pull}
                                    onChange={(event) =>
                                        settings.setData(
                                            'auto_pull',
                                            event.target.checked,
                                        )
                                    }
                                />
                                Automatically pull new files
                            </label>
                            <p className="uc-input-hint">
                                {cloud.server.scheduler_last_seen
                                    ? `Scheduler online · checked ${ago(cloud.server.scheduler_last_seen)}.`
                                    : 'Scheduler offline. Automatic pulls will start when the server scheduler is running.'}
                            </p>
                            <Field
                                label="Conflict policy"
                                hint="Changed content is saved as another version; existing copies are retained."
                            >
                                <div className="uc-field">
                                    <input
                                        readOnly
                                        value="Keep all versions (SHA-256)"
                                    />
                                </div>
                            </Field>
                            <Field label="Theme" error={settings.errors.theme}>
                                <select
                                    className="uc-native-select"
                                    value={theme}
                                    onChange={(event) =>
                                        settings.setData(
                                            'theme',
                                            event.target.value as Theme,
                                        )
                                    }
                                >
                                    <option value="phosphor">Phosphor</option>
                                    <option value="paper">Paper</option>
                                </select>
                            </Field>
                        </section>
                        <div className="uc-settings-actions">
                            <Button
                                disabled={settings.processing}
                                onClick={() => {
                                    settings.setData(cloud.settings);
                                    settings.clearErrors();
                                }}
                            >
                                Discard
                            </Button>
                            <Button
                                variant="primary"
                                type="submit"
                                disabled={settings.processing}
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
                open={unmount !== null}
                onOpenChange={(open) => {
                    if (!open) setUnmount(null);
                }}
            >
                <DialogContent
                    className="usbcloud uc-confirm"
                    data-theme={theme}
                    onCloseAutoFocus={(event) => {
                        event.preventDefault();
                        unmountTrigger.current?.focus();
                    }}
                >
                    <DialogTitle className="uc-heading">
                        Unmount {unmount?.id}?
                    </DialogTitle>
                    <DialogDescription className="uc-data">
                        This disconnects the USB disk from its host. Wait until
                        recording or writing has finished. Archived files stay
                        on the server. Use Mount to reconnect it.
                    </DialogDescription>
                    <div className="uc-dialog-actions">
                        <Button onClick={() => setUnmount(null)}>Cancel</Button>
                        <Button
                            variant="inverse"
                            onClick={() => {
                                const id = unmount?.id;
                                setUnmount(null);
                                if (id) void run('unmount', id);
                            }}
                        >
                            <Unplug size={16} />
                            Unmount USB disk
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}
