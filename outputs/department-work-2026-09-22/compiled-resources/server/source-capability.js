function latestSource(sources, predicate) {
    const candidates = sources.filter(predicate);
    if (!candidates.length)
        return null;
    return candidates.slice().sort((a, b) => (b.observedAt ?? -1) - (a.observedAt ?? -1))[0] ?? null;
}
function temporalHealth(source, now) {
    if (!source || source.observedAt == null || source.staleAt == null)
        return { health: "missing", source };
    if (!Number.isFinite(source.observedAt) || !Number.isFinite(source.staleAt) || source.observedAt > now || source.staleAt <= now) {
        return { health: "stale", source };
    }
    return { health: "current", source };
}
export function currentPmsSourceHealth(desk, now = Date.now()) {
    const result = temporalHealth(latestSource(desk.sources, (source) => source.kind === "csv"), now);
    if (result.health === "current" && result.source?.coverage !== "complete") {
        return { health: "incomplete", source: result.source };
    }
    return result;
}
export function currentBankSourceHealth(desk, now = Date.now()) {
    return temporalHealth(latestSource(desk.sources, (source) => source.stableKey.startsWith("bank:")), now);
}
