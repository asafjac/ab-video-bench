import {r1} from "./stats.mjs";

/** Per-run timeline: every mark line as ms relative to t0 (the `sync` line), in order, plus first occurrences. */
export function buildRunTimeline({summary, marks}) {
    const t0 = summary.t0Epoch;
    const all = marks.map(({consoleTs: _consoleTs, ...m}) => ({...m, relMs: r1(m.epochMs - t0)})).sort((a, b) => a.relMs - b.relMs);
    const first = {};
    for (const m of all) if (first[m.mark] === undefined) first[m.mark] = m.relMs;
    if (summary.visibleMs != null) first.visible = summary.visibleMs;
    else delete first.visible;
    const reported = all.find(m => m.variant != null);
    return {scenario: summary.scenario, label: summary.label, variant: summary.variant, phase: summary.phase, t0Epoch: t0, t0Source: summary.t0Source,
        unit: "ms relative to t0 (the sync line)", reportedVariant: reported ? reported.variant : null, visibleMs: summary.visibleMs ?? null,
        sync: summary.sync ?? null, first, marks: all};
}
