import fs from "node:fs";
import path from "node:path";
import {median, stats, r1} from "./stats.mjs";

export const VARIANTS = ["a", "b"];
export const PHASES = ["cold", "hot"];
export const INTERNAL_MARKS = new Set(["start", "startAction", "navigationStart", "syncFlashOn", "syncFlashOff", "variantSet", "hidden", "visible"]);

/** Per scenario: cold warm-up pairs, cold pairs, hot priming pairs, hot pairs; every pair is A then B so drift hits both. */
export function abSchedule({scenarios, cold, hot, coldWarmup = 1, hotPrime = 1}) {
    const out = [];
    for (const scenario of scenarios) {
        const add = (phase, pairs, measured) => {
            for (let i = 1; i <= pairs; i++) for (const variant of VARIANTS)
                out.push({scenario, phase, variant, measured, label: measured ? `run-${i}` : `warmup-${i}`});
        };
        if (cold > 0) { add("cold", coldWarmup, false); add("cold", cold, true); }
        if (hot > 0) { add("hot", hotPrime, false); add("hot", hot, true); }
    }
    return out;
}

/** {ok, missing?, reason?}: every value the page reported (window.__abVariant in any frame, `variant` on any mark line) equals `expected`. */
export function checkVariant(summary, expected) {
    const seen = summary.variantReport || {globals: [], marks: []};
    const values = [...seen.globals, ...seen.marks].filter(v => v != null);
    if (!values.length) return {ok: false, missing: true, reason: "the page reported no variant (no ABMark.setVariant call and no variant on any mark line)"};
    const distinct = [...new Set(values)];
    if (distinct.some(v => v !== expected)) return {ok: false, reason: `the page reported ${distinct.join(",")} but the run asked for ${expected}`};
    return {ok: true};
}

export const isValid = (r) => !r.ab || r.ab.variantOk;

export function readRuns(root, variant, phase, scenario) {
    const dir = path.join(root, variant, phase, scenario);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => /^run-\d+\.summary\.json$/.test(f))
        .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
        .map(f => ({...JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")), _run: f.replace(".summary.json", "")}));
}

export function readTimelines(root, variant, phase, scenario) {
    return readRuns(root, variant, phase, scenario).filter(isValid).map(r => {
        const file = path.join(root, variant, phase, scenario, `${r._run}.timeline.json`);
        return fs.existsSync(file) ? {...JSON.parse(fs.readFileSync(file, "utf8")), _run: r._run} : null;
    }).filter(Boolean);
}

/** The run whose visible ms is closest to the median of the variant's valid runs (ties: the earlier run). */
export function medianRun(runs) {
    const ok = runs.filter(r => r.visibleMs != null && isValid(r));
    if (!ok.length) return null;
    const md = median(ok.map(r => r.visibleMs));
    return ok.reduce((best, r) => (Math.abs(r.visibleMs - md) < Math.abs(best.visibleMs - md) ? r : best), ok[0]);
}

/** Mark names seen in a scenario's timelines (first occurrence at or after t0), in median order. */
export function discoverMarks(root, phase, scenario) {
    const at = new Map();
    for (const v of VARIANTS) for (const t of readTimelines(root, v, phase, scenario))
        for (const [k, rel] of Object.entries(t.first)) if (!INTERNAL_MARKS.has(k) && rel >= 0) (at.get(k) || at.set(k, []).get(k)).push(rel);
    return [...at].sort((a, b) => median(a[1]) - median(b[1])).map(([k]) => k);
}

export function markMedians(root, phase, scenario, markNames = discoverMarks(root, phase, scenario)) {
    const tl = Object.fromEntries(VARIANTS.map(v => [v, readTimelines(root, v, phase, scenario)]));
    return markNames.map(mark => {
        const a = stats(tl.a.map(t => t.first[mark]).filter(x => typeof x === "number" && x >= 0));
        const b = stats(tl.b.map(t => t.first[mark]).filter(x => typeof x === "number" && x >= 0));
        return a || b ? {mark, a, b, delta: a && b ? b.median - a.median : null} : null;
    }).filter(Boolean);
}

export function syncSummary(root, scenarios) {
    const syncs = [];
    for (const v of VARIANTS) for (const p of PHASES) for (const s of scenarios) for (const r of readRuns(root, v, p, s)) if (r.sync) syncs.push(r.sync);
    if (!syncs.length) return null;
    const ok = syncs.filter(x => x.ok), on = ok.map(x => x.onErrorMs), off = ok.map(x => x.offErrorMs);
    return ok.length ? {n: ok.length, failed: syncs.length - ok.length, onMedian: r1(median(on)), onMin: Math.min(...on), onMax: Math.max(...on),
        offMedian: r1(median(off)), offMin: Math.min(...off), offMax: Math.max(...off)} : {n: 0, failed: syncs.length};
}

export function compareScenario(root, phase, scenario, markNames) {
    const all = Object.fromEntries(VARIANTS.map(v => [v, readRuns(root, v, phase, scenario)]));
    if (!all.a.length && !all.b.length) return null;
    const valid = Object.fromEntries(VARIANTS.map(v => [v, all[v].filter(isValid)]));
    const vis = Object.fromEntries(VARIANTS.map(v => [v, stats(valid[v].map(r => r.visibleMs).filter(x => typeof x === "number"))]));
    const delta = vis.a && vis.b ? vis.b.median - vis.a.median : null;
    const counts = Object.fromEntries(VARIANTS.map(v => [v, {runs: all[v].length, valid: valid[v].length, rejected: all[v].length - valid[v].length,
        notVisible: valid[v].filter(r => r.visibleMs == null).length}]));
    const rejected = VARIANTS.flatMap(v => all[v].filter(r => !isValid(r)).map(r => ({variant: v, run: r._run, reason: r.ab.variantReason})));
    return {phase, scenario, visible: {a: vis.a, b: vis.b, delta, deltaPct: delta != null && vis.a.median ? delta / vis.a.median * 100 : null},
        counts, rejected, marks: markMedians(root, phase, scenario, markNames)};
}

const f0 = (x) => (x == null ? "—" : String(Math.round(x)));
const sgn = (x) => (x == null ? "—" : `${x > 0 ? "+" : ""}${Math.round(x)}`);
const pct = (x) => (x == null ? "—" : `${x > 0 ? "+" : ""}${x.toFixed(1)}%`);
const q = (s) => (s ? `${f0(s.median)} [${f0(s.p25)}–${f0(s.p75)}]` : "—");

/** {rows, md, sync}: A vs B per phase and scenario, ms after the start action; scenarios: [{name, label?, labels?, marks?}]. */
export function buildReport(root, scenarios, meta = {}) {
    const rows = [];
    for (const phase of PHASES) for (const s of scenarios) {
        const names = s.marks && s.marks.length ? s.marks.map(m => m.name) : undefined;
        const r = compareScenario(root, phase, s.name, names);
        if (r) rows.push({...r, label: s.label || s.name, labels: s.labels || {a: "A", b: "B"}});
    }
    let md = `# A/B page-load report\n\n${meta.title || path.basename(root)}\n\n` +
        "All times are ms after t0 (the start action), median [p25–p75] over measured runs. Warm-up and priming runs are discarded; " +
        "runs whose page reported the wrong variant are excluded (rejected). Δ = B − A, negative = B faster.\n";
    if (meta.definitions) md += `\n${meta.definitions}\n`;
    md += "\n## Headline: visible\n\n| phase | scenario | n A/B | A | IQR A | B | IQR B | Δ median | Δ % | not visible A/B | rejected |\n" +
        "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|\n";
    for (const r of rows) {
        const v = r.visible, c = r.counts;
        md += `| ${r.phase} | ${r.scenario} | ${v.a?.n ?? 0}/${v.b?.n ?? 0} | ${q(v.a)} | ${f0(v.a?.iqr)} | ${q(v.b)} | ${f0(v.b?.iqr)} | ${sgn(v.delta)} | ${pct(v.deltaPct)} | ` +
            `${c.a.notVisible}/${c.b.notVisible} | ${c.a.rejected + c.b.rejected} |\n`;
    }
    for (const r of rows) {
        md += `\n## ${r.phase}: ${r.label}\n\nA = ${r.labels.a}; B = ${r.labels.b}.\n\n`;
        if (r.marks.length) {
            md += "| mark | A median (n) | B median (n) | Δ median |\n|---|---:|---:|---:|\n";
            for (const m of r.marks) md += `| ${m.mark} | ${m.a ? `${f0(m.a.median)} (${m.a.n})` : "—"} | ${m.b ? `${f0(m.b.median)} (${m.b.n})` : "—"} | ${sgn(m.delta)} |\n`;
            const v = r.visible;
            md += `| **visible** | ${v.a ? `${f0(v.a.median)} (${v.a.n})` : "—"} | ${v.b ? `${f0(v.b.median)} (${v.b.n})` : "—"} | ${sgn(v.delta)} |\n`;
        } else md += "No page marks were recorded.\n";
        if (r.rejected.length) md += `\nRejected: ${r.rejected.map(x => `${x.variant.toUpperCase()} ${x.run} (${x.reason})`).join("; ")}\n`;
    }
    if (meta.failed && meta.failed.length) {
        md += `\n## Failed runs\n\n`;
        for (const f of meta.failed) md += `- ${f.scenario} ${f.phase} ${f.variant.toUpperCase()} ${f.label}: ${f.error}\n`;
    }
    const sync = syncSummary(root, scenarios.map(s => s.name));
    if (sync) {
        md += `\n## Frame / mark alignment (sync flash)\n\n`;
        md += sync.n ? `Screencast frame time minus the page's own mark, over ${sync.n} runs: flash on median ${sync.onMedian} ms [${sync.onMin}–${sync.onMax}], ` +
            `flash off median ${sync.offMedian} ms [${sync.offMin}–${sync.offMax}]${sync.failed ? `; ${sync.failed} run(s) without a usable flash` : ""}. ` +
            "Positive = the frame showing a change arrives after the page marked it (rAF, paint, compositor). Videos shift frames by the minimum.\n"
            : `No usable flash in ${sync.failed} run(s).\n`;
    }
    if (meta.videos && meta.videos.length) {
        md += `\n## Videos\n\n`;
        for (const v of meta.videos) { const rel = path.relative(root, v.file).replace(/\\/g, "/"); md += `- ${v.phase} ${v.scenario} (${v.kind}): [${rel}](${rel})${v.note ? ` ${v.note}` : ""}\n`; }
    }
    return {rows, md, sync};
}
