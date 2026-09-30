import fs from "node:fs";
import path from "node:path";
import {abSchedule, abVerdict, buildReport, PHASES, VARIANTS} from "./ab.mjs";
import {scenarioPlan} from "./scenario.mjs";
import {Recorder, runVisible, FatalRunError, sleep} from "./recorder.mjs";
import {launchChrome} from "./chrome.mjs";
import {browserWsUrl} from "./cdp.mjs";
import {waitForAc} from "./guards.mjs";
import {mockRun, writeMockFrames} from "./mock.mjs";
import {resolveSync} from "./sync.mjs";
import {buildRunTimeline} from "./timeline.mjs";
import {renderAbVideo} from "./render.mjs";
import {findFonts} from "./media.mjs";
import {authMode, authReason} from "./auth.mjs";

const J = (x) => JSON.stringify(x, null, 2);

export function defaultRoot(base = "ab-results", suffix = "") {
    const day = new Date().toISOString().slice(0, 10);
    const stem = path.resolve(base, `${day}${suffix}`);
    for (let i = 1; ; i++) { const p = i === 1 ? stem : `${stem}-${i}`; if (!fs.existsSync(p)) return p; }
}

async function openRecorder({config, chrome, ffmpeg, log, settleMs, timeoutMs, syncFlash, authChallenges}) {
    let browser = null;
    const wsUrl = chrome.port ? (await browserWsUrl(chrome.port)).wsUrl : (browser = await launchChrome({executable: chrome.executable, headless: chrome.headless !== false,
        width: config.viewport.width, height: config.viewport.height + 100})).wsUrl;
    const rec = new Recorder({prefix: config.prefix, viewport: config.viewport, ffmpeg, log, syncFlash: !!syncFlash, authChallenges, ...(config.syncMarker ? {syncMarker: config.syncMarker} : {}),
        ...(settleMs != null ? {settleMs} : {}), ...(timeoutMs != null ? {timeoutMs} : {})});
    await rec.connect(wsUrl);
    log(`browser: ${rec.browserVersion}${browser ? ` (launched ${chrome.headless === false ? "headed" : "headless"}, port ${browser.port})` : ` (attached, port ${chrome.port})`}`);
    return {rec, browser, close: async () => { await rec.close({closeBrowser: !!browser}).catch(() => {}); if (browser) await browser.close(); }};
}

const syncText = (s) => (s && s.ok ? ` sync=+${s.lagMs}ms${s.method === "flash" ? " (flash)" : ""}` : " sync=MISSING");

/** Runs a full A/B set (alternating runs, variant and sync checks, videos, report); chrome.port attaches, otherwise a Chrome is launched. */
export async function runSet(opts) {
    const {config, cold = 5, hot = 5, coldWarmup = 1, hotPrime = 1, only = null, mock = false, videos = true, videoMedian = false,
        speed = 0.5, fps = 30, chrome = {}, allowBattery = false, settleMs, timeoutMs, syncFlash = false, maxWidth, maxHeight,
        ffmpeg = "ffmpeg", ffprobe = "ffprobe", mockOptions = {}, quiet = false} = opts;
    const authChallenges = authMode(opts.authChallenges);
    for (const [n, v] of Object.entries({cold, hot, coldWarmup, hotPrime})) if (!Number.isInteger(v) || v < 0) throw new Error(`${n} must be an integer >= 0`);
    if (cold + hot < 1) throw new Error("nothing to run: cold and hot are both 0");
    const scenarios = only ? config.scenarios.filter(s => only.includes(s.name)) : config.scenarios;
    if (only) for (const n of only) if (!scenarios.some(s => s.name === n)) throw new Error(`unknown scenario "${n}" (known: ${config.scenarios.map(s => s.name).join(", ")})`);
    const root = path.resolve(opts.root || defaultRoot("ab-results", mock ? "-mock" : ""));
    fs.mkdirSync(root, {recursive: true});
    const LOG = path.join(root, "run.log"), STOP = path.join(root, "STOP");
    fs.rmSync(STOP, {force: true});
    const log = (...a) => { const s = a.join(" "); if (!quiet) console.log(s); fs.appendFileSync(LOG, s + "\n"); if (opts.log) opts.log(s); };
    const fonts = videos ? findFonts(opts.fonts || {}) : null;
    const schedule = abSchedule({scenarios: scenarios.map(s => s.name), cold, hot, coldWarmup, hotPrime});
    const definitions = `cold = HTTP cache disabled and cleared, DNS host cache + socket pools flushed right before the start action (after ${coldWarmup} discarded A+B warm-up pair(s)). ` +
        `hot = same browser profile, HTTP cache, DNS and connections kept, after ${hotPrime} discarded A+B priming pair(s). ` +
        "Both: fresh tab per run, target-origin storage cleared before and after every run.";
    fs.writeFileSync(path.join(root, "plan.json"), J({mode: "ab", mock, cold, hot, coldWarmup, hotPrime, prefix: config.prefix, viewport: config.viewport, syncFlash, authChallenges, definitions,
        scenarios: scenarios.map(scenarioPlan), schedule}));
    const progressFile = path.join(root, "progress.json");
    const progress = {root, mock, startedAt: new Date().toISOString(), total: schedule.length, done: 0, current: null, elapsedMs: 0, etaMs: null,
        rejected: [], failed: [], state: "running"};
    const saveProgress = () => { fs.writeFileSync(progressFile + ".tmp", J(progress)); fs.renameSync(progressFile + ".tmp", progressFile); };

    log(`# ab-bench ${progress.startedAt} ${mock ? "MOCK " : ""}scenarios=${scenarios.map(s => s.name).join(",")} cold=${cold} (+${coldWarmup} warm-up pairs) hot=${hot} (+${hotPrime} priming pairs) root=${root}`);
    const session = mock ? null : await openRecorder({config, chrome, ffmpeg, log, settleMs, timeoutMs, syncFlash, authChallenges});
    log(definitions);
    log(`HTTP auth challenges: ${authChallenges === "cancel" ? "cancelled (the run is rejected, no browser dialog)" : "left to the browser (--auth-challenges ignore)"}`);
    for (const s of scenarios) log(`scenario ${s.name}: ${s.start.type} ${s.start.type === "click" ? s.start.selector : s.url}; variant via ${s.strategy.describe}; sync by the ${s.sync}`);

    const t0 = Date.now();
    let abortReason = null;
    // An HTTP auth challenge left to the browser (--auth-challenges ignore) may leave its sign-in dialog open; a cold run's
    // cache clear and socket flush would close it under whoever is answering it, so the set stops before the next cold run.
    let authPending = null;
    const noteAuth = (challenges) => { const open = (challenges || []).filter(c => c.handled === "none"); if (open.length) authPending = authReason(open); };
    saveProgress();
    try {
        for (const item of schedule) {
            if (fs.existsSync(STOP)) { log("STOP file found: stopping"); progress.state = "stopped"; break; }
            const scenario = scenarios.find(s => s.name === item.scenario);
            const outDir = path.join(root, item.variant, item.phase, item.scenario);
            fs.mkdirSync(outDir, {recursive: true});
            progress.current = item; saveProgress();
            const tag = `${item.scenario} ${item.phase} ${item.variant.toUpperCase()} ${item.label}`;
            if (item.phase === "cold" && authPending) {
                abortReason = `${tag} not run: an HTTP auth dialog may be open (${authPending}). A cold run clears the HTTP cache and flushes sockets, which would close it: ` +
                    "answer or close the dialog, then rerun";
                break;
            }
            try {
                let s;
                if (mock) s = mockOne({scenario, item, outDir, frames: videos, keepFrames: videos && item.measured, ordinal: progress.done, mockOptions, ffmpeg, fonts, syncFlash});
                else {
                    if (!allowBattery) await waitForAc(item.label, log);
                    s = await runVisible(session.rec, {scenario, variant: item.variant, phase: item.phase, label: item.label, outDir, keepFrames: videos && item.measured}, log);
                }
                const {v, ab} = abVerdict(s, item, scenario.strategy.expected(item.variant));
                s.ab = ab;
                noteAuth(s.authChallenges);
                fs.writeFileSync(path.join(outDir, `${item.label}.summary.json`), J(s));
                log(`  ${tag}: visible=${s.visibleMs ?? "—"} (${s.state})${syncText(s.sync)} ${ab.valid ? "ok" : `REJECTED (${ab.reason})`}`);
                if (!ab.valid) progress.rejected.push({...item, reason: ab.reason});
                if (v.missing) { abortReason = `${tag}: ${v.reason}`; break; }
            } catch (e) {
                log(`  ${tag} FAILED: ${e.message}`);
                noteAuth(e.authChallenges);
                progress.failed.push({...item, error: e.message});
                if (session && session.rec.cdp.closed) { abortReason = "the browser connection closed"; break; }
                if (!(e instanceof FatalRunError)) await sleep(500);
            }
            progress.done++;
            progress.elapsedMs = Date.now() - t0;
            progress.etaMs = Math.round(progress.elapsedMs / progress.done) * (progress.total - progress.done);
            saveProgress();
        }
    } finally {
        if (session) await session.close();
    }
    if (abortReason) { log(`ABORTED: ${abortReason}`); progress.state = "aborted"; progress.abortReason = abortReason; }

    const made = [];
    if (videos && !abortReason) {
        progress.current = {scenario: "videos", phase: "", variant: "", label: "rendering"}; saveProgress();
        for (const phase of PHASES) for (const s of scenarios) for (const mode of videoMedian ? ["all", "median"] : ["all"]) {
            if (!fs.existsSync(path.join(root, "a", phase, s.name)) || !fs.existsSync(path.join(root, "b", phase, s.name))) continue;
            try {
                const v = renderAbVideo({root, phase, scenario: s.name, mode, speed, fps, ffmpeg, ffprobe, fonts, maxWidth, maxHeight, scenarioNames: scenarios.map(x => x.name)});
                made.push({phase, scenario: s.name, kind: mode === "all" ? "all runs" : "median runs", file: v.out, poster: v.poster, note: `(${v.size}, tiles ${v.tile}, grid ${v.grid} per side)`});
                log(`video ${path.relative(root, v.out)}: ${mode}, ${v.tiles.length} tiles ${v.tile} (${v.grid} per side), ${v.size}, ${v.frames} frames`);
            } catch (e) { log(`video ${phase}/${s.name} ${mode} failed: ${(e.stderr || e.message).toString().slice(0, 400)}`); }
        }
    }
    const report = buildReport(root, scenarios.map(scenarioPlan), {title: `${mock ? "MOCK DATA. " : ""}${path.basename(root)}, ${new Date().toISOString()}`,
        definitions, videos: made, failed: progress.failed});
    const reportFile = path.join(root, "report.md");
    fs.writeFileSync(reportFile, report.md + (abortReason ? `\n**Aborted:** ${abortReason}\n` : ""));
    fs.writeFileSync(path.join(root, "report.json"), J({rows: report.rows, sync: report.sync, videos: made, rejected: progress.rejected, failed: progress.failed,
        state: progress.state === "running" ? "done" : progress.state, abortReason}));
    if (progress.state === "running") progress.state = "done";
    progress.current = null; progress.finishedAt = new Date().toISOString(); progress.reportFile = reportFile;
    saveProgress();
    log(`wrote ${reportFile}`);
    return {root, state: progress.state, abortReason, rows: report.rows, sync: report.sync, videos: made, rejected: progress.rejected, failed: progress.failed, reportFile};
}

/** Diagnostics: exactly one run of one variant (optionally after one discarded priming run for hot), its video and a printed timeline. */
export async function runSingle(opts) {
    const {config, scenario: name, variant = "b", phase = "cold", prime = false, mock = false, videos = true, speed = 0.5, fps = 30, chrome = {},
        allowBattery = false, settleMs, timeoutMs, syncFlash = false, maxWidth, maxHeight, ffmpeg = "ffmpeg", ffprobe = "ffprobe", mockOptions = {}, quiet = false} = opts;
    const authChallenges = authMode(opts.authChallenges);
    if (!VARIANTS.includes(variant)) throw new Error(`--variant must be a or b, got "${variant}"`);
    if (!PHASES.includes(phase)) throw new Error(`phase must be cold or hot, got "${phase}"`);
    if (prime && phase !== "hot") throw new Error("--prime only applies to a hot single run (--hot)");
    if (!name) throw new Error(`name the scenario to run (known: ${config.scenarios.map(s => s.name).join(", ")})`);
    const scenario = config.scenarios.find(s => s.name === name);
    if (!scenario) throw new Error(`unknown scenario "${name}" (known: ${config.scenarios.map(s => s.name).join(", ")})`);
    const root = path.resolve(opts.root || defaultRoot("ab-results", `-single-${name}-${variant}-${phase}${mock ? "-mock" : ""}`));
    const outDir = path.join(root, variant, phase, name);
    fs.mkdirSync(outDir, {recursive: true});
    const lines = [];
    const log = (...a) => { const s = a.join(" "); lines.push(s); if (!quiet) console.log(s); fs.appendFileSync(path.join(root, "run.log"), s + "\n"); };
    const fonts = videos ? findFonts(opts.fonts || {}) : null;
    fs.writeFileSync(path.join(root, "plan.json"), J({mode: "single", mock, variant, phase, prime, prefix: config.prefix, viewport: config.viewport, syncFlash, scenarios: [scenarioPlan(scenario)]}));
    log(`# ab-bench single run ${new Date().toISOString()} ${mock ? "MOCK " : ""}${name} ${phase} ${variant.toUpperCase()} = ${scenario.labels[variant]}${prime ? " after 1 priming run" : ""} root=${root}`);
    const session = mock ? null : await openRecorder({config, chrome, ffmpeg, log, settleMs, timeoutMs, syncFlash, authChallenges});
    const items = [...(prime ? [{scenario: name, phase, variant, measured: false, label: "warmup-1"}] : []), {scenario: name, phase, variant, measured: true, label: "run-1"}];
    let summary = null;
    try {
        for (const item of items) {
            let s;
            if (mock) s = mockOne({scenario, item, outDir, frames: videos, keepFrames: videos && item.measured, ordinal: 0, mockOptions, ffmpeg, fonts, syncFlash});
            else {
                if (!allowBattery) await waitForAc(item.label, log);
                s = await runVisible(session.rec, {scenario, variant, phase, label: item.label, outDir, keepFrames: item.measured}, log);
            }
            s.ab = abVerdict(s, item, scenario.strategy.expected(variant)).ab;
            fs.writeFileSync(path.join(outDir, `${item.label}.summary.json`), J(s));
            if (item.measured) summary = s;
            else log(`  priming run: visible=${s.visibleMs ?? "—"}${syncText(s.sync)}`);
        }
    } finally {
        if (session) await session.close();
    }
    const timeline = JSON.parse(fs.readFileSync(path.join(outDir, "run-1.timeline.json"), "utf8"));
    for (const l of formatTimeline(timeline, summary)) log(l);
    let video = null;
    if (videos) {
        try {
            video = renderAbVideo({root, phase, scenario: name, mode: "single", single: {variant, run: "run-1"}, speed, fps, ffmpeg, ffprobe, fonts, maxWidth, maxHeight});
            log(`video ${video.out} (${video.size})`);
        } catch (e) { log(`video failed: ${(e.stderr || e.message).toString().slice(0, 400)}`); }
    }
    return {root, summary, timeline, video, lines};
}

/** A readable timeline: header lines (variant check, sync) and one row per mark with its ms after the sync line. */
export function formatTimeline(timeline, summary) {
    const ab = summary.ab || {}, s = summary.sync || {};
    const out = [
        `t0: ${summary.t0Source}`,
        `variant: expected ${summary.variantReport.expected}, page reported ${[...new Set([...summary.variantReport.globals, ...summary.variantReport.marks])].join(",") || "nothing"} -> ${ab.variantOk ? "ok" : `REJECTED (${ab.variantReason})`}`,
        `sync: ${s.ok ? `lag +${s.lagMs} ms by ${s.method}${s.offLagMs != null ? `, removal +${s.offLagMs} ms` : ""}${s.pressToFrameMs != null ? `, drawn ${s.pressToFrameMs} ms after the sync line` : ""}` : `MISSING (${s.reason})`}`,
        `visible: ${summary.visibleMs != null ? `${summary.visibleMs} ms` : `not reached (${summary.state})`}`,
        "",
        `${"ms".padStart(9)}  ${"mark".padEnd(22)} ${"frame".padEnd(7)} ${"source".padEnd(9)} detail`,
    ];
    const core = new Set(["mark", "frame", "perfNow", "epochMs", "variant", "source", "relMs"]);
    for (const m of timeline.marks) {
        const detail = Object.fromEntries(Object.entries(m).filter(([k]) => !core.has(k)));
        const d = Object.keys(detail).length ? JSON.stringify(detail) : "";
        out.push(`${m.relMs.toFixed(1).padStart(9)}  ${m.mark.padEnd(22)} ${String(m.frame).padEnd(7)} ${(m.source || "page").padEnd(9)} ${d.length > 90 ? d.slice(0, 87) + "..." : d}`);
    }
    return out;
}

function mockOne({scenario, item, outDir, frames, keepFrames, ordinal, mockOptions, ffmpeg, fonts, syncFlash}) {
    const key = `${item.scenario}/${item.phase}/${item.variant}/${item.label}`;
    const expected = scenario.strategy.expected(item.variant);
    const reported = mockOptions.missing === key ? null : mockOptions.mismatch === key ? scenario.strategy.expected(item.variant === "a" ? "b" : "a") : expected;
    const run = mockRun({scenario, variant: item.variant, phase: item.phase, label: item.label, runOrdinal: ordinal, reported, lagMs: mockOptions.lagMs ?? 12,
        sync: mockOptions.noSync !== key, flash: syncFlash});
    run.summary.variantReport.expected = expected;
    // mockOptions.authChallenge = {key, handled: "cancelled" | "none"}: that run met an HTTP auth challenge.
    const ac = mockOptions.authChallenge;
    run.summary.authChallenges = ac && ac.key === key ? [{origin: new URL(scenario.url).origin, scheme: "basic", realm: "mock", url: scenario.url, frame: "top", handled: ac.handled || "cancelled"}] : [];
    const prefix = path.join(outDir, item.label);
    if (frames) {
        const written = writeMockFrames({dir: `${prefix}.frames`, run, ffmpeg, fonts});
        run.summary.sync = resolveSync({marks: run.marks, frames: written, flash: run.flash, ffmpeg});
        if (!keepFrames) fs.rmSync(`${prefix}.frames`, {recursive: true, force: true});
    } else {
        const line = run.marks.find(m => m.mark === "sync");
        run.summary.sync = line ? {ok: true, method: "mock", lagMs: run.lagMs, epochMs: line.epochMs, marker: line.marker}
            : {ok: false, reason: "no sync line: the page never logged a `sync` mark in the top document"};
    }
    fs.writeFileSync(`${prefix}.timeline.json`, JSON.stringify(buildRunTimeline({summary: run.summary, marks: run.marks}), null, 1));
    fs.writeFileSync(`${prefix}.console.json`, "[]");
    return run.summary;
}
