import fs from "node:fs";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {r1} from "./stats.mjs";

export const SYNC_BOX_PX = 48;
export const SYNC_FLASH_MS = 200;

// Evaluated in the top document right before t0: a magenta square for ~200 ms, with host mark lines on show and hide.
export const syncFlashJs = (prefix) => `new Promise((resolve) => requestAnimationFrame(() => {
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;left:0;top:0;width:${SYNC_BOX_PX}px;height:${SYNC_BOX_PX}px;background:#ff00ff;z-index:2147483647;pointer-events:none";
    const log = (mark) => { const perfNow = performance.now(), line = {mark, frame: "top", perfNow, epochMs: performance.timeOrigin + perfNow, variant: window.__abVariant ?? null, source: "recorder"};
        console.info(${JSON.stringify(prefix)} + " " + JSON.stringify(line)); return line.epochMs; };
    document.documentElement.appendChild(box);
    const on = log("syncFlashOn");
    setTimeout(() => requestAnimationFrame(() => { box.remove(); resolve({on, off: log("syncFlashOff"), boxPx: ${SYNC_BOX_PX}}); }), ${SYNC_FLASH_MS});
}))`;

// One ffmpeg pass over the candidate frames: the mean color of a 6 x 6 patch inside the flash square, per frame.
function magentaFlags(files, ffmpeg) {
    if (!files.length) return [];
    const list = path.join(path.dirname(files[0]), "sync-candidates.txt");
    fs.writeFileSync(list, files.map(f => `file '${f.replace(/\\/g, "/")}'`).join("\n"));
    try {
        const px = execFileSync(ffmpeg, ["-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", "crop=6:6:6:6,scale=1:1",
            "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], {maxBuffer: 1 << 22});
        return files.map((_, i) => px[i * 3] > 170 && px[i * 3 + 1] < 100 && px[i * 3 + 2] > 170);
    } finally { fs.rmSync(list, {force: true}); }
}

/** Frame time minus the host's syncFlashOn / syncFlashOff epochMs: the frames-vs-marks alignment error, in ms. frames: [{ts, file}]. */
export function measureSync(frames, flash, ffmpeg = "ffmpeg") {
    if (!flash || flash.error) return {ok: false, reason: flash ? flash.error : "no sync flash"};
    const cand = frames.filter(f => f.ts >= flash.on - 150 && f.ts <= flash.off + 500).sort((a, b) => a.ts - b.ts);
    const flags = magentaFlags(cand.map(f => f.file), ffmpeg);
    const lit = cand.map((f, i) => ({ts: f.ts, on: flags[i]}));
    const firstOn = lit.findIndex(f => f.on);
    if (firstOn < 0) return {ok: false, reason: `no magenta frame among ${lit.length} frames around the flash`, framesChecked: lit.length};
    const firstOff = lit.findIndex((f, i) => i > firstOn && !f.on);
    return {ok: firstOff > 0, onErrorMs: r1(lit[firstOn].ts - flash.on), offErrorMs: firstOff > 0 ? r1(lit[firstOff].ts - flash.off) : null,
        litFrames: firstOff > 0 ? firstOff - firstOn : null, framesChecked: lit.length, litBeforeMark: lit[firstOn].ts < flash.on};
}
