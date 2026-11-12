import assert from 'node:assert/strict';
import test from 'node:test';
import {deviceHealth} from '../../resources/js/lib/device-health.ts';

test('missing readings stay unavailable instead of reporting a healthy device', () => {
    for (const metrics of [
        null,
        {},
        { cpu_temperature_c: null },
        { cpu_count: 4 },
    ]) {
        const health = deviceHealth(metrics, false);

        assert.equal(health.label, 'Awaiting metrics');
        assert.equal(health.hasMetrics, false);
        assert.equal(health.loadPercent, null);
    }
});

test('zero readings are valid healthy metrics', () => {
    const health = deviceHealth(
        { load_1m: 0, cpu_count: 4, throttled_flags: 0 },
        false,
    );

    assert.equal(health.label, 'Healthy');
    assert.equal(health.loadPercent, 0);
    assert.deepEqual(health.currentFlags, []);
});

test('load is compared with the reported core count and unknown cores have no meter', () => {
    assert.equal(
        deviceHealth({ load_1m: 2, cpu_count: 4 }, false).loadPercent,
        50,
    );
    for (const cpu_count of [null, 0]) {
        const health = deviceHealth({ load_1m: 2, cpu_count }, false);

        assert.equal(health.loadPercent, null);
        assert.equal(health.loadHigh, false);
    }
});

test('health warnings begin at the design thresholds', () => {
    const readings = [
        {
            normal: { cpu_temperature_c: 69.9 },
            high: { cpu_temperature_c: 70 },
            field: 'temperatureHigh',
            reason: 'running hot',
        },
        {
            normal: { load_1m: 3.2, cpu_count: 4 },
            high: { load_1m: 3.21, cpu_count: 4 },
            field: 'loadHigh',
            reason: 'CPU busy',
        },
        {
            normal: { memory_used_percent: 85 },
            high: { memory_used_percent: 85.1 },
            field: 'memoryHigh',
            reason: 'memory high',
        },
        {
            normal: { root_used_percent: 85 },
            high: { root_used_percent: 85.1 },
            field: 'diskHigh',
            reason: 'system disk nearly full',
        },
    ];

    for (const { normal, high, field, reason } of readings) {
        assert.equal(deviceHealth(normal, false)[field], false);
        const health = deviceHealth(high, false);

        assert.equal(health[field], true);
        assert.equal(health.label, 'Attention');
        assert.equal(health.summary, `Attention · ${reason}`);
    }
});

test('historical throttling flags do not appear as currently active warnings', () => {
    const health = deviceHealth({ throttled_flags: 0x50000 }, false);

    assert.equal(health.label, 'Healthy');
    assert.deepEqual(health.currentFlags, []);
    assert.deepEqual(health.pastFlags, ['under-voltage', 'throttled']);
});

test('current throttling is decoded independently from historical flags', () => {
    const health = deviceHealth({ throttled_flags: 0xa0005 }, false);

    assert.equal(health.label, 'Attention');
    assert.deepEqual(health.currentFlags, ['under-voltage', 'throttled']);
    assert.deepEqual(health.pastFlags, ['frequency capped', 'soft temp limit']);
});

test('offline readings are marked stale instead of raising live health alarms', () => {
    const health = deviceHealth(
        { cpu_temperature_c: 82, throttled_flags: 5 },
        true,
    );

    assert.equal(health.label, 'Offline · stale');
    assert.equal(health.summary, 'Offline · metrics may be stale');
    assert.equal(health.stale, true);
    assert.equal(health.attention, false);
});

test('server health warnings remain visible when no tile explains them', () => {
    const health = deviceHealth(null, false, ['Device requires attention']);

    assert.equal(health.summary, 'Attention · Device requires attention');
});
