import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {execFileSync} from "node:child_process";
import {readRuns, medianRun, isValid, syncSummary, discoverMarks} from "./ab.mjs";
import {stats} from "./stats.mjs";
import {findFonts, filterPath, filterScriptArgs} from "./media.mjs";

const BG = "0x0e1016", FREEZE_LAG_MS = 150, TILE_W = 520, MAX_TILE_H = 860;
const HEADER_H = 128, COLHEAD_H = 52, BAR_H = 84, LABEL_ROWS = 3, LABEL_CHAR_PX = 8, GAP = 12, POST_MS = 800;
const TICK_COLORS = ["0x4fc3f7", "0xffb74d", "0xffe082", "0xef9a9a", "0xce93d8", "0x80cbc4", "0xb0bec5", "0xf48fb1"];
const VISIBLE_COLOR = "0x66bb6a";
const SIDE_COLORS = {a: "0xb0b6c3", b: "0x66bb6a"};

const even = (x) => Math.max(2, Math.round(x / 2) * 2);

/** Scenario metadata the runner stored in plan.json (labels, marks), or defaults. */
export function readPlan(root) {
    const file = path.join(root, "plan.json");
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

export const scenarioMeta = (root, scenario) => (readPlan(root).scenarios || []).find(s => s.name === scenario) || {name: scenario};

function loadTile(root, variant, phase, scenario, run, shiftMs) {
    const base = path.join(root, variant, phase, scenario, run._run);
    const index = path.join(`${base}.frames`, "index.json");
    if (!fs.existsSync(index)) throw new Error(`${base}: no frames (record with videos on)`);
    const t0 = run.t0Epoch;
    const frames = JSON.parse(fs.readFileSync(index, "utf8")).map(f => ({rel: f.ts - t0 - shiftMs, file: path.join(`${base}.frames`, f.file)})).sort((a, b) => a.rel - b.rel);
    const timeline = fs.existsSync(`${base}.timeline.json`) ? JSON.parse(fs.readFileSync(`${base}.timeline.json`, "utf8")) : {first: {}};
    return {variant, run: run._run, visible: run.visibleMs ?? null, rect: run.cropRect || null, frames, first: {...timeline.first, visible: run.visibleMs ?? undefined}};
}

// The crop rectangle in screencast pixels (CSS rect x image width / viewport width), even-aligned and clamped.
function cropOf(tile, imgW, imgH) {
    const r = tile.rect;
    if (!r || !r.vw) return {x: 0, y: 0, w: Math.floor(imgW / 2) * 2, h: Math.floor(imgH / 2) * 2};
    const k = imgW / r.vw, x = Math.max(0, Math.floor(r.x * k / 2) * 2), y = Math.max(0, Math.floor(r.y * k / 2) * 2);
    return {x, y, w: Math.min(even(r.w * k), Math.floor((imgW - x) / 2) * 2), h: Math.min(even(r.h * k), Math.floor((imgH - y) / 2) * 2)};
}

/** Side-by-side A vs B video: output frame n shows, per tile, the last frame at or before n / fps * speed s after that tile's t0. */
export function renderAbVideo({root, phase, scenario, grid = false, speed = 0.5, fps = 30, out, ffmpeg = "ffmpeg", ffprobe = "ffprobe", fonts, maxMb = 14.5, scenarioNames}) {
    const meta = scenarioMeta(root, scenario);
    const labels = {a: "A", b: "B", ...(meta.labels || {})};
    const sides = [{variant: "a", head: `A  ·  ${labels.a}`}, {variant: "b", head: `B  ·  ${labels.b}`}];
    const font = fonts || findFonts();
    const FONT = filterPath(font.bold), FONT_REG = filterPath(font.regular);
    // Frame times move onto the page clock by the set's smallest measured flash lag: never more than the true lag, so a frame placed at or after a mark really shows it.
    const sync = syncSummary(root, scenarioNames || [...new Set([...(readPlan(root).scenarios || []).map(s => s.name), scenario])]);
    const shiftMs = sync && sync.n ? Math.max(0, Math.min(sync.onMin, sync.offMin)) : 0;
    const syncNote = sync && sync.n ? `frame/mark lag +${sync.onMedian} ms median over ${sync.n} runs` : "no sync flash measured";
    const runs = Object.fromEntries(sides.map(s => [s.variant, readRuns(root, s.variant, phase, scenario).filter(isValid)]));
    const picks = Object.fromEntries(sides.map(s => [s.variant, grid ? runs[s.variant].filter(r => r.visibleMs != null) : [medianRun(runs[s.variant])].filter(Boolean)]));
    if (!picks.a.length || !picks.b.length) throw new Error(`${phase}/${scenario}: needs at least one visible run per variant`);
    const columns = sides.map(s => picks[s.variant].map(r => loadTile(root, s.variant, phase, scenario, r, shiftMs)));
    const all = columns.flat();
    if (all.some(t => !t.frames.length)) throw new Error(`${phase}/${scenario}: a picked run has no screencast frames`);
    const vis = Object.fromEntries(sides.map(s => [s.variant, stats(runs[s.variant].map(r => r.visibleMs).filter(x => typeof x === "number"))]));
    const tickDefs = (meta.marks && meta.marks.length ? meta.marks : discoverMarks(root, phase, scenario).map(name => ({name})))
        .map((m, i) => ({k: m.name, label: m.label || m.name, color: m.color || TICK_COLORS[i % TICK_COLORS.length]}))
        .concat([{k: "visible", label: "visible", color: VISIBLE_COLOR}]);
    out = out || path.join(root, "videos", `${phase}-${scenario}${grid ? "-grid" : ""}.mp4`);
    fs.mkdirSync(path.dirname(out), {recursive: true});
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "abv-"));
    try {
        const [imgW, imgH] = execFileSync(ffprobe, ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", all[0].frames[0].file]).toString().trim().split(",").map(Number);
        const crop0 = cropOf(all[0], imgW, imgH);
        let TW = TILE_W, TH = even(crop0.h * TILE_W / crop0.w);
        if (TH > MAX_TILE_H) { TH = MAX_TILE_H; TW = even(crop0.w * MAX_TILE_H / crop0.h); }
        const ROWS = Math.max(...columns.map(c => c.length)), CELL_H = TH + BAR_H + GAP;
        const W = GAP + 2 * (TW + GAP), H = HEADER_H + COLHEAD_H + ROWS * CELL_H;
        const slowest = Math.max(...all.map(t => t.visible ?? 0));
        const END_MS = slowest + POST_MS, FRAMES = Math.ceil(END_MS / speed / 1000 * fps);
        const msAt = (n) => n * 1000 / fps * speed, secOf = (ms) => (ms / speed / 1000).toFixed(4);
        const MX = 10, BAR_W = TW - 2 * MX, xOf = (ms) => MX + Math.round(Math.min(1, Math.max(0, ms / END_MS)) * BAR_W);
        let textN = 0;
        const textFile = (s, expand = false) => { const f = path.join(tmp, `text${textN++}.txt`); fs.writeFileSync(f, expand ? s : s.replace(/[\\%]/g, (c) => `\\${c}`)); return filterPath(f); };
        const placeholder = path.join(tmp, "placeholder.jpg");
        execFileSync(ffmpeg, ["-y", "-v", "error", "-f", "lavfi", "-i", `color=c=${BG}:s=${imgW}x${imgH}`, "-frames:v", "1", placeholder]);

        // Frame sequences: frame n = the last frame at or before msAt(n); from visible on, the freeze frame.
        const planHash = crypto.createHash("sha256");
        all.forEach((t, k) => {
            t.dir = path.join(tmp, `t${k}`); fs.mkdirSync(t.dir);
            t.freeze = t.visible == null ? null : (t.frames.find(f => f.rel >= t.visible && f.rel <= t.visible + FREEZE_LAG_MS) || [...t.frames].reverse().find(f => f.rel <= t.visible + FREEZE_LAG_MS) || null);
            let j = -1;
            for (let n = 0; n < FRAMES; n++) {
                const at = msAt(n);
                let src;
                if (t.freeze && at >= t.visible) src = t.freeze.file;
                else { while (j + 1 < t.frames.length && t.frames[j + 1].rel <= at + 1e-9) j++; src = j >= 0 ? t.frames[j].file : placeholder; }
                planHash.update(`${k}:${n}:${src === placeholder ? "-" : path.basename(src)}\n`);
                const dst = path.join(t.dir, `s${String(n).padStart(5, "0")}.jpg`);
                try { fs.linkSync(src, dst); } catch { fs.copyFileSync(src, dst); }
            }
        });

        const chains = all.map((t, k) => {
            const c = cropOf(t, imgW, imgH);
            const v = t.visible ?? END_MS;
            let g = `[${k}:v]crop=${c.w}:${c.h}:${c.x}:${c.y},scale=${TW}:${TH},setsar=1,format=yuv420p,pad=${TW}:${TH + BAR_H}:0:0:color=${BG}`;
            g += `,drawtext=fontfile='${FONT}':textfile='${textFile(`%{eif:min(t*${speed * 1000},${Math.round(v)}):d} ms`, true)}':x=10:y=10:fontsize=34:fontcolor=white:box=1:boxcolor=black@0.75:boxborderw=8`;
            g += `,drawtext=fontfile='${FONT_REG}':textfile='${textFile(`${t.run}  ·  visible ${t.visible != null ? Math.round(t.visible) + " ms" : "MISS"}`)}':x=10:y=${TH - 40}:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.75:boxborderw=6`;
            if (t.visible != null) {
                g += `,drawbox=x=0:y=0:w=${TW}:h=${TH}:color=0xffd600:t=6:enable='gte(t\\,${secOf(t.visible)})'`;
                g += `,drawtext=fontfile='${FONT}':textfile='${textFile(`VISIBLE ${Math.round(t.visible)} ms`)}':x=(w-tw)/2:y=${Math.round(TH * 0.42)}:fontsize=40:fontcolor=black:box=1:boxcolor=0xffd600@0.95:boxborderw=12:enable='gte(t\\,${secOf(t.visible)})'`;
            }
            g += `,drawbox=x=${MX}:y=${TH + 12}:w=${BAR_W}:h=4:color=0x5a5f6e:t=fill`;
            const ticks = tickDefs.map(d => ({...d, t: t.first[d.k]})).filter(d => typeof d.t === "number" && d.t >= 0).sort((a, b) => a.t - b.t);
            // Labels go in the first of LABEL_ROWS rows where they do not overlap the previous label (estimated width).
            const rowEnd = new Array(LABEL_ROWS).fill(-Infinity);
            ticks.forEach((d) => {
                g += `,drawbox=x=${xOf(d.t) - 2}:y=${TH + 4}:w=4:h=20:color=${d.color}:t=fill`;
                const text = `${d.label} ${Math.round(d.t)}`, width = text.length * LABEL_CHAR_PX;
                const lx = Math.min(TW - width - 2, Math.max(2, xOf(d.t) - Math.round(width / 2)));
                const row = Math.max(0, rowEnd.findIndex(end => end + 6 <= lx));
                rowEnd[row] = lx + width;
                g += `,drawtext=fontfile='${FONT_REG}':textfile='${textFile(text)}':x=${lx}:y=${TH + 26 + row * 18}:fontsize=15:fontcolor=${d.color}`;
            });
            g += `,drawtext=fontfile='${FONT}':text='|':fontsize=28:fontcolor=white:y=${TH}:x='${MX}+min(t*${speed * 1000}/${END_MS}\\,1)*${BAR_W}-tw/2'`;
            return g + `[t${k}]`;
        });
        const layout = columns.flatMap((col, c) => col.map((_, r) => `${GAP + c * (TW + GAP)}_${r * CELL_H}`)).join("|");
        let g = `${chains.join(";")};${all.map((_, k) => `[t${k}]`).join("")}xstack=inputs=${all.length}:layout=${layout}:fill=${BG},pad=${W}:${H}:0:${HEADER_H + COLHEAD_H}:color=${BG}`;
        const d = vis.a && vis.b ? vis.b.median - vis.a.median : null;
        const headline = `${meta.label || scenario}  ·  ${phase}  ·  ${grid ? `all runs (${picks.a.length} A / ${picks.b.length} B)` : `median runs: A ${columns[0][0].run}, B ${columns[1][0].run}`}`;
        const delta = d != null ? `visible median ${Math.round(vis.a.median)} → ${Math.round(vis.b.median)} ms  ·  Δ ${d > 0 ? "+" : ""}${Math.round(d)} ms (${d > 0 ? "+" : ""}${(d / vis.a.median * 100).toFixed(1)}%)  ·  n ${vis.a.n}/${vis.b.n}` : "";
        // Header lines shrink to fit the video width (average glyph width estimated at 0.56 em).
        const fit = (text, size) => Math.max(10, Math.min(size, Math.floor((W - 2 * GAP) / (Math.max(1, text.length) * 0.56))));
        g += `,drawtext=fontfile='${FONT}':textfile='${textFile(headline)}':x=(w-tw)/2:y=14:fontsize=${fit(headline, 34)}:fontcolor=white`;
        g += `,drawtext=fontfile='${FONT}':textfile='${textFile(delta || " ")}':x=(w-tw)/2:y=58:fontsize=${fit(delta, 28)}:fontcolor=${d != null && d < 0 ? "0x66bb6a" : "0xef9a9a"}`;
        const info = `${speed}× speed  ·  timers: real ms since each side's start action  ·  frames shifted -${shiftMs} ms (min sync lag)  ·  ${syncNote}`;
        g += `,drawtext=fontfile='${FONT_REG}':textfile='${textFile(info)}':x=(w-tw)/2:y=98:fontsize=${fit(info, 18)}:fontcolor=0xaab0bf`;
        sides.forEach((s, c) => { g += `,drawtext=fontfile='${FONT}':textfile='${textFile(s.head)}':x=${GAP + c * (TW + GAP)}+(${TW}-tw)/2:y=${HEADER_H + 10}:fontsize=26:fontcolor=${SIDE_COLORS[s.variant]}`; });
        g += `,format=yuv420p[v]`;
        const gFile = path.join(tmp, "graph.txt"); fs.writeFileSync(gFile, g);
        const encode = (crf) => execFileSync(ffmpeg, ["-y", "-v", "error", ...all.flatMap(t => ["-framerate", String(fps), "-i", path.join(t.dir, "s%05d.jpg")]),
            ...filterScriptArgs(ffmpeg, gFile), "-map", "[v]", "-r", String(fps), "-c:v", "libx264", "-preset", "medium", "-crf", String(crf), "-x264-params", "threads=4",
            "-pix_fmt", "yuv420p", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-movflags", "+faststart", "-an", out], {maxBuffer: 64 << 20, stdio: "pipe"});
        let crf = 22; encode(crf);
        while (fs.statSync(out).size > maxMb * 1024 * 1024 && crf < 36) { crf += 3; encode(crf); }
        const bVisible = columns[1].map(t => t.visible).filter(x => x != null);
        const posterAt = bVisible.length ? Math.min(...bVisible) : slowest;
        const poster = out.replace(/\.mp4$/, ".jpg");
        execFileSync(ffmpeg, ["-y", "-v", "error", "-i", out, "-vf", `select=eq(n\\,${Math.min(FRAMES - 1, Math.ceil(posterAt / speed / 1000 * fps))})`, "-frames:v", "1", "-q:v", "3",
            "-fflags", "+bitexact", "-flags:v", "+bitexact", poster]);
        return {out, poster, frameShiftMs: shiftMs, size: `${W}x${H}`, tile: `${TW}x${TH}`, fps, speed, realMs: END_MS, frames: FRAMES, crf, phase, scenario, grid,
            planSha256: planHash.digest("hex"), tiles: all.map(t => ({variant: t.variant, run: t.run, visible: t.visible, freezeFrameRelMs: t.freeze ? Math.round(t.freeze.rel) : null}))};
    } finally { fs.rmSync(tmp, {recursive: true, force: true}); }
}
