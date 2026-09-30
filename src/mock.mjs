import fs from "node:fs";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {findFonts, filterPath} from "./media.mjs";
import {SYNC_BOX_PX} from "./sync.mjs";

export const MOCK_T0_EPOCH = 1_790_000_000_000;
export const MOCK_FPS = 60;
export const MOCK_W = 480;
export const MOCK_H = 640;
export const MOCK_FLASH = {on: -1000, off: -800};
const PRE_ROLL_MS = -1300;
const DEFAULT_MARKS = ["appStart", "dataRequested", "dataReceived", "firstRender"];

/** Deterministic fake run in the recorder's formats: B is ~28% faster; marks spread over the load in config order. */
export function mockRun({scenario, variant, phase, label, runOrdinal = 0, reported, lagMs = 12}) {
    let seed = [...`${scenario.name}|${variant}|${phase}|${label}`].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const names = scenario.marks && scenario.marks.length ? scenario.marks.map(m => m.name) : DEFAULT_MARKS;
    const base = (phase === "cold" ? 1800 : 1100) + (scenario.name.length % 7) * 40;
    const visible = Math.round(base * (variant === "b" ? 0.72 : 1) + rnd() * 160);
    const t0Epoch = MOCK_T0_EPOCH + runOrdinal * 60_000;
    const value = reported === undefined ? variant : reported;
    let at = 40;
    const page = names.map((mark, i) => {
        at = Math.max(at + 5, Math.round(visible * (i + 1) / (names.length + 1.3) + rnd() * 30));
        return {mark, frame: "top", perfNow: at + 400, epochMs: t0Epoch + at, variant: value};
    });
    const rec = (mark, rel) => ({mark, frame: "top", source: "recorder", perfNow: rel + 400, epochMs: t0Epoch + rel, variant: value});
    const marks = [rec("syncFlashOn", MOCK_FLASH.on), rec("syncFlashOff", MOCK_FLASH.off), rec("startAction", 0), ...page, rec("visible", visible)]
        .map(m => (value == null ? {...m, variant: null} : m));
    const summary = {scenario: scenario.name, label, variant, phase, state: "visible", visibleMs: visible, mock: true, t0Epoch, t0Source: "mock start action",
        variantReport: {globals: value == null ? [] : [value], marks: value == null ? [] : [value]}, cropRect: null};
    const painted = page.length ? page[page.length - 1].epochMs - t0Epoch : Math.round(visible * 0.8);
    return {summary, marks, flash: {on: t0Epoch + MOCK_FLASH.on, off: t0Epoch + MOCK_FLASH.off}, timings: {painted, visible}, lagMs};
}

/** Synthetic 60 fps screencast frames for a mock run, written to `dir` with index.json; each frame's ts = content time + lagMs. */
export function writeMockFrames({dir, run, ffmpeg = "ffmpeg", fonts}) {
    const {summary, timings, lagMs} = run, t0 = summary.t0Epoch;
    const font = (fonts || findFonts()).bold;
    fs.rmSync(dir, {recursive: true, force: true}); fs.mkdirSync(dir, {recursive: true});
    const endRel = timings.visible + 1500, durS = (endRel - PRE_ROLL_MS) / 1000;
    const at = (rel) => ((rel - PRE_ROLL_MS) / 1000).toFixed(4);
    const b = summary.variant === "b";
    const vf = [
        `drawbox=x=0:y=0:w=${MOCK_W}:h=56:color=0x2a2f3d:t=fill`,
        `drawbox=x=24:y=90:w=432:h=110:color=0x3a3f4d:t=fill:enable='lt(t\\,${at(timings.visible)})'`,
        `drawbox=x=24:y=220:w=432:h=110:color=0x3a3f4d:t=fill:enable='lt(t\\,${at(timings.visible)})'`,
        `drawbox=x=24:y=90:w=432:h=110:color=${b ? "0x2e7d32" : "0x1565c0"}:t=fill:enable='gte(t\\,${at(timings.painted)})'`,
        `drawbox=x=24:y=220:w=432:h=110:color=${b ? "0x43a047" : "0x1e88e5"}:t=fill:enable='gte(t\\,${at(timings.visible)})'`,
        `drawbox=x=24:y=350:w=432:h=110:color=0xffb300:t=fill:enable='gte(t\\,${at(timings.visible)})'`,
        `drawbox=x=0:y=0:w=${SYNC_BOX_PX}:h=${SYNC_BOX_PX}:color=0xff00ff:t=fill:enable='between(t\\,${at(MOCK_FLASH.on)}\\,${at(MOCK_FLASH.off) - 0.0001})'`,
        `drawtext=fontfile='${filterPath(font)}':text='MOCK ${summary.variant.toUpperCase()}':x=60:y=16:fontsize=24:fontcolor=white`,
    ].join(",");
    execFileSync(ffmpeg, ["-y", "-v", "error", "-f", "lavfi", "-i", `color=c=0x14161d:s=${MOCK_W}x${MOCK_H}:r=${MOCK_FPS}:d=${durS}`, "-vf", vf,
        "-q:v", "5", "-start_number", "0", path.join(dir, "f%05d.jpg")]);
    const files = fs.readdirSync(dir).filter(f => /^f\d+\.jpg$/.test(f)).sort();
    const frames = files.map((f, i) => ({ts: t0 + PRE_ROLL_MS + i * 1000 / MOCK_FPS + lagMs, file: f}));
    fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(frames));
    return frames.map(f => ({ts: f.ts, file: path.join(dir, f.file)}));
}
