import fs from "node:fs";
import path from "node:path";
import {abSchedule, checkVariant, buildReport, PHASES} from "./ab.mjs";
import {scenarioPlan} from "./scenario.mjs";
import {Recorder, runVisible, FatalRunError, sleep} from "./recorder.mjs";
import {launchChrome} from "./chrome.mjs";
import {browserWsUrl} from "./cdp.mjs";
import {waitForAc} from "./guards.mjs";
import {mockRun, writeMockFrames} from "./mock.mjs";
import {measureSync} from "./sync.mjs";
import {buildRunTimeline} from "./timeline.mjs";
import {renderAbVideo} from "./render.mjs";
import {findFonts} from "./media.mjs";

const J = (x) => JSON.stringify(x, null, 2);

export function defaultRoot(base = "ab-results", suffix = "") {
    const day = new Date().toISOString().slice(0, 10);
    const stem = path.resolve(base, `${day}${suffix}`);
    for (let i = 1; ; i++) { const p = i === 1 ? stem : `${stem}-${i}`; if (!fs.existsSync(p)) return p; }
}

/** Runs a full A/B set (alternating runs, variant check, videos, report); chrome.port attaches, otherwise a Chrome is launched. */
export async function runSet(opts) {
    const {config, cold = 5, hot = 5, coldWarmup = 1, hotPrime = 1, only = null, mock = false, videos = true, videoGrid = false,
        speed = 0.5, fps = 30, chrome = {}, allowBattery = false, settleMs, timeoutMs, ffmpeg = "ffmpeg", ffprobe = "ffprobe", mockOptions = {}, quiet = false} = opts;
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
    fs.writeFileSync(path.join(root, "plan.json"), J({mock, cold, hot, coldWarmup, hotPrime, prefix: config.prefix, viewport: config.viewport, definitions,
        scenarios: scenarios.map(scenarioPlan), schedule}));
    const progressFile = path.join(root, "progress.json");
    const progress = {root, mock, startedAt: new Date().toISOString(), total: schedule.length, done: 0, current: null, elapsedMs: 0, etaMs: null,
        rejected: [], failed: [], state: "running"};
    const saveProgress = () => { fs.writeFileSync(progressFile + ".tmp", J(progress)); fs.renameSync(progressFile + ".tmp", progressFile); };

    let rec = null, browser = null;
    if (!mock) {
        const wsUrl = chrome.port ? (await browserWsUrl(chrome.port)).wsUrl : (browser = await launchChrome({executable: chrome.executable, headless: chrome.headless !== false,
            width: config.viewport.width, height: config.viewport.height + 100})).wsUrl;
        rec = new Recorder({prefix: config.prefix, viewport: config.viewport, ffmpeg, log, ...(settleMs != null ? {settleMs} : {}), ...(timeoutMs != null ? {timeoutMs} : {})});
        await rec.connect(wsUrl);
    }
    log(`# ab-bench ${progress.startedAt} ${mock ? "MOCK " : ""}scenarios=${scenarios.map(s => s.name).join(",")} cold=${cold} (+${coldWarmup} warm-up pairs) hot=${hot} (+${hotPrime} priming pairs) root=${root}`);
    if (rec) log(`browser: ${rec.browserVersion}${browser ? ` (launched ${chrome.headless === false ? "headed" : "headless"}, port ${browser.port})` : ` (attached, port ${chrome.port})`}`);
    log(definitions);
    for (const s of scenarios) log(`scenario ${s.name}: ${s.start.type} ${s.start.type === "click" ? s.start.selector : s.url}; variant via ${s.strategy.describe}`);

    const t0 = Date.now();
    let abortReason = null;
    saveProgress();
    try {
        for (const item of schedule) {
            if (fs.existsSync(STOP)) { log("STOP file found: stopping"); progress.state = "stopped"; break; }
            const scenario = scenarios.find(s => s.name === item.scenario);
            const outDir = path.join(root, item.variant, item.phase, item.scenario);
            fs.mkdirSync(outDir, {recursive: true});
            progress.current = item; saveProgress();
            const tag = `${item.scenario} ${item.phase} ${item.variant.toUpperCase()} ${item.label}`;
            const keepFrames = videos && item.measured;
            try {
                let s;
                if (mock) s = mockOne({scenario, item, outDir, keepFrames: videos, ordinal: progress.done, mockOptions, ffmpeg, fonts});
                else {
                    if (!allowBattery) await waitForAc(item.label, log);
                    s = await runVisible(rec, {scenario, variant: item.variant, phase: item.phase, label: item.label, outDir, keepFrames}, log);
                }
                const check = checkVariant(s, scenario.strategy.expected(item.variant));
                s.ab = {variant: item.variant, phase: item.phase, measured: item.measured, variantOk: check.ok, variantReason: check.reason || null};
                fs.writeFileSync(path.join(outDir, `${item.label}.summary.json`), J(s));
                const sy = s.sync && s.sync.ok ? ` sync=+${s.sync.onErrorMs}ms` : s.sync ? " sync=FAILED" : "";
                log(`  ${tag}: visible=${s.visibleMs ?? "—"} (${s.state})${sy} variant=${check.ok ? "ok" : `REJECTED (${check.reason})`}`);
                if (!check.ok) progress.rejected.push({...item, reason: check.reason});
                if (check.missing) { abortReason = `${tag}: ${check.reason}`; break; }
            } catch (e) {
                log(`  ${tag} FAILED: ${e.message}`);
                progress.failed.push({...item, error: e.message});
                if (rec && rec.cdp.closed) { abortReason = "the browser connection closed"; break; }
                if (!(e instanceof FatalRunError)) await sleep(500);
            }
            progress.done++;
            progress.elapsedMs = Date.now() - t0;
            progress.etaMs = Math.round(progress.elapsedMs / progress.done) * (progress.total - progress.done);
            saveProgress();
        }
    } finally {
        if (rec) await rec.close({closeBrowser: !!browser}).catch(() => {});
        if (browser) await browser.close();
    }
    if (abortReason) { log(`ABORTED: ${abortReason}`); progress.state = "aborted"; progress.abortReason = abortReason; }

    const made = [];
    if (videos && !abortReason) {
        progress.current = {scenario: "videos", phase: "", variant: "", label: "rendering"}; saveProgress();
        for (const phase of PHASES) for (const s of scenarios) for (const grid of videoGrid ? [false, true] : [false]) {
            if (!fs.existsSync(path.join(root, "a", phase, s.name)) || !fs.existsSync(path.join(root, "b", phase, s.name))) continue;
            try {
                const v = renderAbVideo({root, phase, scenario: s.name, grid, speed, fps, ffmpeg, ffprobe, fonts, scenarioNames: scenarios.map(x => x.name)});
                made.push({phase, scenario: s.name, kind: grid ? "all runs" : "median runs", file: v.out, poster: v.poster, frameShiftMs: v.frameShiftMs,
                    note: `(${v.tiles.map(t => `${t.variant.toUpperCase()} ${t.run}`).join(", ")})`});
                log(`video ${path.relative(root, v.out)}: ${v.tiles.map(t => `${t.variant.toUpperCase()} ${t.run} visible ${Math.round(t.visible)}`).join(" | ")}, ${v.size}, ${v.frames} frames, shift -${v.frameShiftMs} ms`);
            } catch (e) { log(`video ${phase}/${s.name}${grid ? " grid" : ""} failed: ${(e.stderr || e.message).toString().slice(0, 400)}`); }
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

function mockOne({scenario, item, outDir, keepFrames, ordinal, mockOptions, ffmpeg, fonts}) {
    const key = `${item.scenario}/${item.phase}/${item.variant}/${item.label}`;
    const expected = scenario.strategy.expected(item.variant);
    const reported = mockOptions.missing === key ? null : mockOptions.mismatch === key ? scenario.strategy.expected(item.variant === "a" ? "b" : "a") : expected;
    const run = mockRun({scenario, variant: item.variant, phase: item.phase, label: item.label, runOrdinal: ordinal, reported, lagMs: mockOptions.lagMs ?? 12});
    run.summary.variantReport.expected = expected;
    const prefix = path.join(outDir, item.label);
    if (keepFrames) {
        const frames = writeMockFrames({dir: `${prefix}.frames`, run, ffmpeg, fonts});
        run.summary.sync = measureSync(frames, run.flash, ffmpeg);
        if (!item.measured) fs.rmSync(`${prefix}.frames`, {recursive: true, force: true});
    }
    fs.writeFileSync(`${prefix}.timeline.json`, JSON.stringify(buildRunTimeline({summary: run.summary, marks: run.marks}), null, 1));
    return run.summary;
}
