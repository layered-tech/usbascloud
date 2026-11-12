import assert from 'node:assert/strict';
import test from 'node:test';
import {dismissTransferRuns, parseTransferDismissals, visibleTransferDevices,} from '../../resources/js/lib/transfer-dismissals.ts';

const device = (id, token, state = 'completed', details = {}) => ({
    id,
    transfer: { token, state, ...details },
});

test('a dismissed run stays hidden after reload, reordering, and terminal updates', () => {
    const devices = [device('A', 'run-a'), device('B', 'run-b')];
    const dismissed = dismissTransferRuns(devices, {});
    const restored = parseTransferDismissals(JSON.stringify(dismissed));

    assert.deepEqual(
        visibleTransferDevices(
            [
                device('B', 'run-b', 'failed', { total_bytes: 42 }),
                device('A', 'run-a', 'completed', { stage: 'Done' }),
            ],
            restored,
        ),
        [],
    );
});

test('a new run appears even with the same state and byte count', () => {
    const dismissed = dismissTransferRuns([device('A', 'old')], {});
    const next = device('A', 'new');

    assert.deepEqual(visibleTransferDevices([next], dismissed), [next]);
});

test('new device activity does not bring back another device’s dismissed result', () => {
    const dismissed = dismissTransferRuns([device('A', 'run-a')], {});
    const next = device('B', 'run-b', 'running');

    assert.deepEqual(
        visibleTransferDevices([device('A', 'run-a'), next], dismissed),
        [next],
    );
    assert.deepEqual(visibleTransferDevices([], dismissed), []);
    assert.deepEqual(
        visibleTransferDevices([device('A', 'run-a')], dismissed),
        [],
    );
});

test('active and paused runs remain visible and cannot be dismissed', () => {
    for (const state of [
        'queued',
        'running',
        'pausing',
        'cancelling',
        'paused',
    ]) {
        const current = device('A', 'run-a', state);
        assert.deepEqual(visibleTransferDevices([current], { A: 'run-a' }), [
            current,
        ]);
        assert.deepEqual(dismissTransferRuns([current], {}), {});
    }
});

test('older transfers use their start time and missing progress is ignored', () => {
    const legacy = device('A', undefined, 'failed', {
        started_at: '2026-11-11T10:00:00Z',
    });
    const dismissed = dismissTransferRuns([legacy], {});

    assert.deepEqual(
        visibleTransferDevices(
            [legacy, { id: 'B', transfer: null }],
            dismissed,
        ),
        [],
    );
    assert.deepEqual(
        visibleTransferDevices(
            [
                device('A', undefined, 'completed', {
                    started_at: '2026-11-11T11:00:00Z',
                }),
            ],
            dismissed,
        ).map((entry) => entry.id),
        ['A'],
    );
});

test('unavailable or invalid saved dismissals fall back to an empty record', () => {
    for (const value of [null, 'bad json', 'null', '[]', '42', '"text"']) {
        assert.deepEqual(parseTransferDismissals(value), {});
    }
    assert.deepEqual(parseTransferDismissals('{"A":"run-a","B":42}'), {
        A: 'run-a',
    });
});
