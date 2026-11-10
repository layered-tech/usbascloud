import { Head, router } from '@inertiajs/react';
import {
    ArrowDownToLine,
    CheckCircle2,
    HardDrive,
    RefreshCw,
    Usb,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
    file as clipFile,
    retrieve,
    refresh as refreshStatus,
} from '@/actions/App/Http/Controllers/ClientConsoleController';
import { Button } from '@/components/ui/button';

type PiStatus = {
    online: boolean;
    error: string | null;
    state: {
        gadget_loaded: boolean;
        usb_state: Record<string, string>;
        snapshot: unknown;
        storage: { report: { lv: { lv_size: string }[] }[] };
    } | null;
};
type Clip = {
    id: number;
    name: string;
    bytes: number;
    sha256: string;
    video: boolean;
};
type Run = {
    id: string;
    at: string;
    success: boolean;
    already_saved?: number;
    files: Clip[];
    log: string[];
    error: string | null;
    after?: PiStatus;
};
type Props = { host: string; status: PiStatus; runs: Run[] };
const bytes = (value: number) =>
    new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(
        value / 1024 / 1024,
    ) + ' MB';

export default function ClientConsole({ host, status: initialStatus, runs }: Props) {
    const [status, setStatus] = useState(initialStatus);
    const [processing, setProcessing] = useState(false);
    const [output, setOutput] = useState('');
    const [error, setError] = useState<string | null>(null);
    const consoleRef = useRef<HTMLPreElement>(null);
    useEffect(() => {
        if (consoleRef.current)
            consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }, [output]);
    async function runAction(action: 'retrieve' | 'refresh') {
        if (action === 'retrieve') setProcessing(true);
        else setRefreshing(true);
        setError(null);
        setOutput('');
        if (action === 'retrieve') setSelected(null);
        try {
            const csrf = document.cookie
                .split('; ')
                .find((cookie) => cookie.startsWith('XSRF-TOKEN='))
                ?.slice(11);
            const response = await fetch(
                action === 'retrieve' ? retrieve.url() : refreshStatus.url(),
                {
                    method: 'POST',
                    headers: {
                        Accept: 'application/json',
                        'X-Requested-With': 'XMLHttpRequest',
                        'X-XSRF-TOKEN': decodeURIComponent(csrf ?? ''),
                    },
                },
            );
            if (!response.ok) {
                const failure = await response.json();
                throw new Error(failure.message ?? 'Retrieval request failed.');
            }
            const reader = response.body?.getReader();
            if (!reader)
                throw new Error('Streaming is unavailable. Please retry.');
            const decoder = new TextDecoder();
            let pending = '';
            let receivedResult = false;
            function readLine(line: string) {
                if (!line.trim()) return;
                const event = JSON.parse(line) as {
                    type: string;
                    data: string | Run | PiStatus;
                };
                if (event.type === 'output' && typeof event.data === 'string') {
                    const output = event.data;
                    setOutput((previous) => previous + output);
                }
                if (event.type === 'error' && typeof event.data === 'string')
                    throw new Error(event.data);
                if (event.type === 'status') {
                    receivedResult = true;
                    const nextStatus = event.data as PiStatus;
                    setStatus(nextStatus);
                    if (!nextStatus.online) setError(nextStatus.error);
                }
                if (event.type === 'result') {
                    receivedResult = true;
                    const run = event.data as Run;
                    if (run.after) setStatus(run.after);
                    if (!run.success)
                        setError(run.error ?? 'Retrieval failed.');
                }
            }
            while (true) {
                const chunk = await reader.read();
                pending += decoder.decode(chunk.value, { stream: !chunk.done });
                const lines = pending.split('\n');
                pending = lines.pop() ?? '';
                lines.forEach(readLine);
                if (chunk.done) break;
            }
            readLine(pending);
            if (!receivedResult)
                throw new Error(
                    'The connection ended before a result arrived. Refresh to check the saved result before retrying.',
                );
        } catch (failure) {
            setError(
                failure instanceof Error
                    ? failure.message
                    : 'Retrieval failed. Please retry.',
            );
        } finally {
            setProcessing(false);
            setRefreshing(false);
            router.reload({ only: ['runs'] });
        }
    }
    const [refreshing, setRefreshing] = useState(false);
    const [selected, setSelected] = useState<string | null>(null);
    const active = runs.find((run) => run.id === selected) ?? runs[0];
    const usb =
        Object.values(status.state?.usb_state ?? {}).join(', ') || 'Unknown';
    return (
        <>
            <Head title="USBCloud Client" />
            <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-8 px-5 py-8 sm:px-8 sm:py-12">
                <header className="flex flex-wrap items-start justify-between gap-5 border-b pb-6">
                    <div className="flex flex-col gap-2">
                        <p className="text-sm font-medium text-muted-foreground">
                            USBCloud / Client console
                        </p>
                        <h1 className="text-3xl font-semibold tracking-tight">
                            USBCloud Client
                        </h1>
                        <p className="max-w-xl text-sm leading-6 text-muted-foreground">
                            Retrieve files from a read-only snapshot while Blink
                            keeps its USB drive connected.
                        </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Button
                            variant="outline"
                            onClick={() => void runAction('refresh')}
                            disabled={refreshing || processing}
                        >
                            <RefreshCw
                                className={
                                    refreshing ? 'motion-safe:animate-spin' : ''
                                }
                            />
                            {refreshing ? 'Checking…' : 'Refresh status'}
                        </Button>
                        <Button
                            onClick={() => void runAction('retrieve')}
                            disabled={processing || refreshing}
                        >
                            <ArrowDownToLine />
                            {processing
                                ? 'Retrieving snapshot…'
                                : 'Retrieve snapshot'}
                        </Button>
                    </div>
                </header>
                <section
                    aria-label="Pi status"
                    className="grid gap-5 rounded-xl border bg-card p-5 sm:grid-cols-3"
                >
                    <div className="flex flex-col gap-2">
                        <span className="flex items-center gap-2 text-sm text-muted-foreground">
                            <HardDrive className="size-4" />
                            Wi-Fi connection
                        </span>
                        <strong className="font-medium">
                            {status.online ? 'Online' : 'Unavailable'}
                        </strong>
                        <span className="font-mono text-xs text-muted-foreground">
                            pi@{host}
                        </span>
                    </div>
                    <div className="flex flex-col gap-2">
                        <span className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Usb className="size-4" />
                            USB connection
                        </span>
                        <strong className="font-medium capitalize">
                            {usb}
                        </strong>
                        <span className="text-xs text-muted-foreground">
                            {status.state?.gadget_loaded
                                ? 'Mass-storage gadget loaded'
                                : 'Gadget status unavailable'}
                        </span>
                    </div>
                    <div className="flex flex-col gap-2">
                        <span className="text-sm text-muted-foreground">
                            Snapshot
                        </span>
                        <strong className="font-medium">
                            {status.state?.snapshot
                                ? 'Open'
                                : status.online
                                  ? 'Closed'
                                  : 'Unknown'}
                        </strong>
                        <span className="text-xs text-muted-foreground">
                            {status.state?.storage.report[0]?.lv[0]?.lv_size ??
                                '—'}{' '}
                            USB disk
                        </span>
                    </div>
                </section>
                {(status.error || error) && (
                    <div
                        role="alert"
                        className="rounded-lg border border-destructive/40 p-4 text-sm break-words text-destructive"
                    >
                        {error ?? status.error}
                        <p className="mt-2 text-foreground">
                            Check the Pi connection and SSH key access, then
                            retry.
                        </p>
                    </div>
                )}
                {processing && (
                    <p
                        role="status"
                        className="rounded-lg bg-muted p-4 text-sm"
                    >
                        Opening snapshot → copying files → closing snapshot.
                        Keep the Pi and this server online.
                    </p>
                )}
                {(processing || refreshing || output) && (
                    <section
                        className="flex flex-col gap-3"
                        aria-label="Live CLI output"
                    >
                        <h2 className="text-base font-semibold">
                            Live CLI output
                        </h2>
                        <pre
                            ref={consoleRef}
                            tabIndex={0}
                            aria-label="Command output"
                            className="max-h-80 overflow-auto rounded-xl border bg-muted p-4 font-mono text-xs leading-5 break-all whitespace-pre-wrap"
                        >
                            {output || 'Connecting…'}
                        </pre>
                    </section>
                )}
                <div className="grid items-start gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
                    <section
                        className="flex flex-col gap-3"
                        aria-label="Retrieval history"
                    >
                        <h2 className="text-base font-semibold">
                            Retrievals{' '}
                            <span className="font-normal text-muted-foreground">
                                ({runs.length})
                            </span>
                        </h2>
                        {runs.length === 0 ? (
                            <p className="text-sm leading-6 text-muted-foreground">
                                No retrievals yet. Retrieve a snapshot to
                                inspect the files on the Pi.
                            </p>
                        ) : (
                            <div className="flex flex-col gap-2">
                                {runs.map((run) => (
                                    <button
                                        type="button"
                                        key={run.id}
                                        onClick={() => setSelected(run.id)}
                                        aria-pressed={active?.id === run.id}
                                        className={`flex flex-col gap-1 rounded-lg border p-3 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring ${active?.id === run.id ? 'border-foreground/30 bg-muted' : ''}`}
                                    >
                                        <span className="font-medium">
                                            {new Date(run.at).toLocaleString()}
                                        </span>
                                        <span
                                            className={
                                                run.success
                                                    ? 'text-muted-foreground'
                                                    : 'text-destructive'
                                            }
                                        >
                                            {run.success
                                                ? `${run.files.length} new · ${run.already_saved ?? 0} already saved`
                                                : 'Retrieval failed'}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        )}
                    </section>
                    <section
                        className="flex min-w-0 flex-col gap-5"
                        aria-label="Retrieval results"
                    >
                        {!active ? (
                            <div className="flex min-h-64 flex-col items-center justify-center gap-3 rounded-xl border border-dashed p-8 text-center">
                                <HardDrive className="size-7 text-muted-foreground" />
                                <h2 className="font-medium">
                                    Ready for a snapshot
                                </h2>
                                <p className="max-w-sm text-sm leading-6 text-muted-foreground">
                                    Files will be saved on this server. Videos
                                    can be played and downloaded here.
                                </p>
                            </div>
                        ) : (
                            <>
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                    <h2 className="text-lg font-semibold">
                                        {active.success
                                            ? 'New files'
                                            : 'Retrieval result'}
                                    </h2>
                                    <span className="text-sm text-muted-foreground">
                                        {bytes(
                                            active.files.reduce(
                                                (sum, clip) => sum + clip.bytes,
                                                0,
                                            ),
                                        )}{' '}
                                        total
                                    </span>
                                </div>
                                {active.error && (
                                    <div
                                        role="alert"
                                        className="rounded-lg border border-destructive/40 p-4 text-sm break-words text-destructive"
                                    >
                                        {active.error}
                                        <p className="mt-2 text-foreground">
                                            Use Retrieve snapshot to try again.
                                            This result is saved.
                                        </p>
                                    </div>
                                )}
                                <div className="rounded-lg border bg-muted/30 p-4">
                                    <ol className="flex flex-col gap-2 text-sm">
                                        {active.log.map((line, i) => (
                                            <li
                                                key={i}
                                                className="flex items-start gap-2"
                                            >
                                                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                                                {line}
                                            </li>
                                        ))}
                                    </ol>
                                </div>
                                {active.success &&
                                    active.files.length === 0 && (
                                        <p className="rounded-lg border p-5 text-sm text-muted-foreground">
                                            No new files in this snapshot. Files
                                            already saved are skipped using
                                            their SHA-256 checksum.
                                        </p>
                                    )}
                                <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
                                    {[...active.files]
                                        .sort((a, b) =>
                                            b.name.localeCompare(
                                                a.name,
                                                undefined,
                                                { numeric: true },
                                            ),
                                        )
                                        .map((clip) => (
                                            <article
                                                key={clip.id}
                                                className="overflow-hidden rounded-xl border bg-card"
                                            >
                                                {clip.video && (
                                                    <video
                                                        controls
                                                        preload="metadata"
                                                        className="aspect-video w-full bg-black"
                                                        src={clipFile.url({
                                                            run: active.id,
                                                            file: String(
                                                                clip.id,
                                                            ),
                                                        })}
                                                    >
                                                        <track kind="captions" />
                                                        Your browser does not
                                                        support video playback.
                                                    </video>
                                                )}
                                                <div className="flex flex-col gap-3 p-4">
                                                    <div className="flex flex-wrap items-start justify-between gap-3">
                                                        <div className="min-w-0">
                                                            <h3 className="text-sm font-medium break-all">
                                                                {clip.name}
                                                            </h3>
                                                            <p className="mt-1 text-xs text-muted-foreground">
                                                                {bytes(
                                                                    clip.bytes,
                                                                )}
                                                            </p>
                                                        </div>
                                                        <Button
                                                            asChild
                                                            size="sm"
                                                            variant="outline"
                                                        >
                                                            <a
                                                                href={clipFile.url(
                                                                    {
                                                                        run: active.id,
                                                                        file: String(
                                                                            clip.id,
                                                                        ),
                                                                    },
                                                                )}
                                                                download
                                                            >
                                                                <ArrowDownToLine />
                                                                Download
                                                            </a>
                                                        </Button>
                                                    </div>
                                                    <details className="text-xs text-muted-foreground">
                                                        <summary className="cursor-pointer">
                                                            SHA-256
                                                        </summary>
                                                        <code className="mt-2 block break-all">
                                                            {clip.sha256}
                                                        </code>
                                                    </details>
                                                </div>
                                            </article>
                                        ))}
                                </div>
                                <p className="text-xs leading-5 text-muted-foreground">
                                    These are copies from one point-in-time
                                    snapshot. Retrieval does not delete files
                                    from the Pi or prove that a recording has
                                    finished writing.
                                </p>
                            </>
                        )}
                    </section>
                </div>
            </main>
        </>
    );
}
