import fs from "node:fs";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {r1} from "./stats.mjs";

export const SYNC_BOX_PX = 48;
export const SYNC_FLASH_MS = 200;
export const DEFAULT_MARKER = {size: 8, color: "#ff00ff", ms: 100, corner: "top-left"};

// Optional pre-run flash, evaluated in the top document before the start action (--sync-flash).
export const syncFlashJs = (prefix) => `new Promise((resolve) => requestAnimationFrame(() => {
    const box = document.createElement("div");
    box.setAttribute("data-ab-sync-marker", "");
    box.style.cssText = "position:fixed;left:0;top:0;width:${SYNC_BOX_PX}px;height:${SYNC_BOX_PX}px;background:#ff00ff;z-index:2147483647;pointer-events:none";
    const log = (mark) => { const perfNow = performance.now(), line = {mark, frame: "top", perfNow, epochMs: performance.timeOrigin + perfNow, variant: window.__abVariant ?? null, source: "recorder"};
        console.info(${JSON.stringify(prefix)} + " " + JSON.stringify(line)); return line.epochMs; };
    document.documentElement.appendChild(box);
    const on = log("syncFlashOn");
    setTimeout(() => requestAnimationFrame(() => { box.remove(); resolve({on, off: log("syncFlashOff"), boxPx: ${SYNC_BOX_PX}}); }), ${SYNC_FLASH_MS});
}))`;

export const FLASH_REGION = {x: 0, y: 0, size: SYNC_BOX_PX, color: "#ff00ff"};

export function hexRgb(color) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(color || ""));
    if (!m) throw new Error(`sync marker color must be #rrggbb, got ${color}`);
    const n = parseInt(m[1], 16);
    return [n >> 16, (n >> 8) & 255, n & 255];
}

// One ffmpeg pass over the candidate frames: per frame, is the mean color of a patch in the middle of the region close to `color`?
function litFlags(files, ffmpeg, region) {
    if (!files.length) return [];
    const k = region.scale || 1, size = Math.max(2, Math.floor(region.size * k));
    const patch = Math.max(2, Math.min(6, size - 4)), off = Math.floor((size - patch) / 2);
    const x = Math.max(0, Math.round(region.x * k) + off), y = Math.max(0, Math.round(region.y * k) + off);
    const [tr, tg, tb] = hexRgb(region.color);
    const list = path.join(path.dirname(files[0]), "sync-candidates.txt");
    fs.writeFileSync(list, files.map(f => `file '${f.replace(/\\/g, "/")}'`).join("\n"));
    try {
        const px = execFileSync(ffmpeg, ["-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", `crop=${patch}:${patch}:${x}:${y},scale=1:1`,
            "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], {maxBuffer: 1 << 22});
        return files.map((_, i) => Math.abs(px[i * 3] - tr) < 80 && Math.abs(px[i * 3 + 1] - tg) < 80 && Math.abs(px[i * 3 + 2] - tb) < 80);
    } finally { fs.rmSync(list, {force: true}); }
}

/** Frame time minus page time for a marker shown at `on` and removed at `off` (epoch ms), found in `region` (CSS px). */
export function measureSync(frames, anchor, ffmpeg = "ffmpeg", region = FLASH_REGION) {
    if (!anchor || anchor.error) return {ok: false, reason: anchor ? anchor.error : "no sync anchor"};
    const until = anchor.off != null ? anchor.off + 500 : anchor.on + 1500;
    const cand = frames.filter(f => f.ts >= anchor.on - 150 && f.ts <= until).sort((a, b) => a.ts - b.ts);
    const flags = litFlags(cand.map(f => f.file), ffmpeg, region);
    const lit = cand.map((f, i) => ({ts: f.ts, on: flags[i]}));
    const firstOn = lit.findIndex(f => f.on);
    if (firstOn < 0) return {ok: false, reason: `the sync marker is in none of the ${lit.length} frames around the sync line`, framesChecked: lit.length};
    const firstOff = lit.findIndex((f, i) => i > firstOn && !f.on);
    return {ok: true, onErrorMs: r1(lit[firstOn].ts - anchor.on), offErrorMs: firstOff > 0 && anchor.off != null ? r1(lit[firstOff].ts - anchor.off) : null,
        litFrames: firstOff > 0 ? firstOff - firstOn : null, framesChecked: lit.length, litBeforeMark: lit[firstOn].ts < anchor.on};
}

/** summary.sync for a run: the `sync` line (t0) and its marker measured in the frames, with the optional flash as a fallback. */
export function resolveSync({marks, frames, flash = null, ffmpeg = "ffmpeg"}) {
    const line = marks.find(m => m.mark === "sync" && m.syncTop !== false);
    const flashSync = flash ? measureSync(frames, flash, ffmpeg, FLASH_REGION) : null;
    if (!line) return {ok: false, reason: "no sync line: the page never logged a `sync` mark in the top document (click starts: the recorder's press listener; navigation starts: call ABMark.sync())", flash: flashSync};
    const frameLine = marks.find(m => m.mark === "syncFrame" && m.epochMs >= line.epochMs - 0.5);
    const endLine = marks.find(m => m.mark === "syncEnd" && m.epochMs >= line.epochMs);
    const marker = line.marker || {x: 0, y: 0, size: DEFAULT_MARKER.size, color: DEFAULT_MARKER.color};
    const anchorMs = frameLine ? frameLine.epochMs : line.epochMs;
    const m = measureSync(frames, {on: anchorMs, off: endLine ? endLine.epochMs : null}, ffmpeg, marker);
    const base = {epochMs: line.epochMs, anchor: frameLine ? "syncFrame" : "sync", pressToFrameMs: r1(anchorMs - line.epochMs), marker, flash: flashSync};
    if (m.ok) return {ok: true, method: "marker", lagMs: m.onErrorMs, offLagMs: m.offErrorMs, litFrames: m.litFrames, framesChecked: m.framesChecked, litBeforeMark: m.litBeforeMark, ...base};
    if (flashSync && flashSync.ok) return {ok: true, method: "flash", lagMs: flashSync.onErrorMs, offLagMs: flashSync.offErrorMs, markerReason: m.reason, ...base};
    return {ok: false, reason: m.reason, framesChecked: m.framesChecked, ...base};
}
