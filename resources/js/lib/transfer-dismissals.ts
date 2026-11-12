type TransferRun = {
    token?: string;
    started_at?: string;
    state: string;
};

type TransferDevice = { id: string; transfer: TransferRun | null };
export type TransferDismissals = Record<string, string>;
export const transferDismissalsKey = 'usbcloud.dismissed-transfers';

const isFinished = (transfer: TransferRun) =>
    ['completed', 'failed', 'cancelled'].includes(transfer.state);

const runId = (transfer: TransferRun) =>
    transfer.token ?? transfer.started_at ?? 'legacy';

export function visibleTransferDevices<T extends TransferDevice>(
    devices: T[],
    dismissed: TransferDismissals,
): T[] {
    return devices.filter(
        ({ id, transfer }) =>
            transfer &&
            (!isFinished(transfer) || dismissed[id] !== runId(transfer)),
    );
}

export function dismissTransferRuns(
    devices: TransferDevice[],
    dismissed: TransferDismissals,
): TransferDismissals {
    return {
        ...dismissed,
        ...Object.fromEntries(
            devices.flatMap(({ id, transfer }) =>
                transfer && isFinished(transfer) ? [[id, runId(transfer)]] : [],
            ),
        ),
    };
}

export function parseTransferDismissals(
    value: string | null,
): TransferDismissals {
    try {
        const parsed: unknown = JSON.parse(value ?? '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {};
        }
        return Object.fromEntries(
            Object.entries(parsed).filter(
                ([, token]) => typeof token === 'string',
            ),
        );
    } catch {
        return {};
    }
}
