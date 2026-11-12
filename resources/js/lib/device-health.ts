export type DeviceMetrics = {
    cpu_temperature_c?: number | null;
    load_1m?: number | null;
    cpu_count?: number | null;
    memory_used_percent?: number | null;
    root_used_percent?: number | null;
    root_free_bytes?: number | null;
    throttled_flags?: number | null;
};

export function deviceHealth(
    metrics: DeviceMetrics | null,
    offline: boolean,
    warnings: string[] = [],
) {
    const flags = metrics?.throttled_flags;
    const flagNames = [
        'under-voltage',
        'frequency capped',
        'throttled',
        'soft temp limit',
    ];
    const currentFlags = flagNames.filter((_, index) =>
        flags == null ? false : !!(flags & (1 << index)),
    );
    const pastFlags = flagNames.filter((_, index) =>
        flags == null ? false : !!(flags & (1 << (index + 16))),
    );
    const cpuCount = metrics?.cpu_count ?? 0;
    const loadPercent =
        metrics?.load_1m != null && cpuCount > 0
            ? (metrics.load_1m / cpuCount) * 100
            : null;
    const temperatureHigh = (metrics?.cpu_temperature_c ?? 0) >= 70;
    const loadHigh = loadPercent != null && loadPercent > 80;
    const memoryHigh = (metrics?.memory_used_percent ?? 0) > 85;
    const diskHigh = (metrics?.root_used_percent ?? 0) > 85;
    const reason = currentFlags.length
        ? currentFlags[0]
        : temperatureHigh
          ? 'running hot'
          : loadHigh
            ? 'CPU busy'
            : memoryHigh
              ? 'memory high'
              : diskHigh
                ? 'system disk nearly full'
                : warnings[0];
    const hasMetrics =
        metrics != null &&
        [
            metrics.cpu_temperature_c,
            metrics.load_1m,
            metrics.memory_used_percent,
            metrics.root_used_percent,
            metrics.throttled_flags,
        ].some((value) => value != null);
    const attention = !offline && !!reason;
    const label = offline
        ? 'Offline · stale'
        : attention
          ? 'Attention'
          : hasMetrics
            ? 'Healthy'
            : 'Awaiting metrics';

    return {
        label,
        summary: offline
            ? 'Offline · metrics may be stale'
            : attention
              ? `Attention · ${reason}`
              : label,
        stale: offline,
        attention,
        hasMetrics,
        loadPercent,
        temperatureHigh,
        loadHigh,
        memoryHigh,
        diskHigh,
        currentFlags,
        pastFlags,
    };
}
