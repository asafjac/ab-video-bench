import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {execFileSync} from "node:child_process";
import {readRuns, medianRun, isValid, syncSummary, discoverMarks, VARIANTS} from "./ab.mjs";
import {stats} from "./stats.mjs";
import {findFonts, filterPath, filterScriptArgs} from "./media.mjs";

export const MODES = ["all", "median", "single"];
export const DEFAULT_MAX = {width: 1920, height: 1080};
const BG = "0x0e1016", FREEZE_LAG_MS = 150, REF_TILE_W = 520, MIN_TILE_W = 80;
const HEADER_H = 128, COLHEAD_H = 52, LABEL_ROWS = 3, GAP = 12, SIDE_GAP = 36, POST_MS = 800;
const TICK_COLORS = ["0x4fc3f7", "0xffb74d", "0xffe082", "0xef9a9a", "0xce93d8", "0x80cbc4", "0xb0bec5", "0xf48fb1"];
const VISIBLE_COLOR = "0x66bb6a", MEDIAN_COLOR = "0x4dd0e1";
const SIDE_COLORS = {a: "0xb0b6c3", b: "0x66bb6a"};
const HIDDEN_TICKS = new Set(["sync", "syncFrame", "syncEnd", "syncFlashOn", "syncFlashOff", "hidden", "visible"]);

const even = (x) => Math.max(2, Math.round(x / 2) * 2);
const floorEven = (x) => Math.max(2, Math.floor(x / 2) * 2);

export function readPlan(root) {
    const file = path.join(root, "plan.json");
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

export const scenarioMeta = (root, scenario) => (readPlan(root).scenarios || []).find(s => s.name === scenario) || {name: scenario};

function loadTile(root, variant, phase, scenario, run, median) {
    const base = path.join(root, variant, phase, scenario, run._run);
    const index = path.join(`${base}.frames`, "index.json");
    if (!fs.existsSync(index)) throw new Error(`${base}: no frames (record with videos on)`);
    const t0 = run.t0Epoch, shiftMs = run.sync && run.sync.ok ? run.sync.lagMs : 0;
    const frames = JSON.parse(fs.readFileSync(index, "utf8")).map(f => ({rel: f.ts - t0 - shiftMs, file: path.join(`${base}.frames`, f.file)})).sort((a, b) => a.rel - b.rel);
    const timeline = fs.existsSync(`${base}.timeline.json`) ? JSON.parse(fs.readFileSync(`${base}.timeline.json`, "utf8")) : {first: {}};
    return {variant, run: run._run, visible: run.visibleMs ?? null, rect: run.cropRect || null, marker: run.sync && run.sync.marker, shiftMs, median,
        valid: isValid(run), frames, first: {...timeline.first, visible: run.visibleMs ?? undefined}};
}

// The crop rectangle in screencast pixels (CSS rect x image width / viewport width), even-aligned and clamped.
function cropOf(tile, imgW, imgH) {
    const r = tile.rect;
    if (!r || !r.vw) return {x: 0, y: 0, w: floorEven(imgW), h: floorEven(imgH)};
    const k = imgW / r.vw, x = Math.max(0, Math.floor(r.x * k / 2) * 2), y = Math.max(0, Math.floor(r.y * k / 2) * 2);
    return {x, y, w: Math.min(even(r.w * k), Math.floor((imgW - x) / 2) * 2), h: Math.min(even(r.h * k), Math.floor((imgH - y) / 2) * 2)};
}

/** Overlay sizes for a tile width: everything scales from a 520 px reference tile, with readable minimums. */
function overlay(TW) {
    const s = Math.min(2, Math.max(0.35, TW / REF_TILE_W));
    const tickFont = Math.max(10, Math.round(15 * s));
    return {s, timerFont: Math.max(11, Math.round(34 * s)), labelFont: Math.max(11, Math.round(22 * s)), visFont: Math.max(11, Math.round(40 * s)),
        tickFont, charPx: tickFont * 0.53, barH: Math.round(26 * s) + LABEL_ROWS * (tickFont + 3) + 6, margin: Math.max(2, Math.round(3 * s)), pad: Math.max(4, Math.round(10 * s))};
}

/** Tile width and grid for `sides` blocks of `n` tiles each, the largest that fits maxW x maxH (ties: fewer columns). */
export function chooseLayout({sides, n, aspect, nativeW, maxW, maxH}) {
    let best = null;
    for (let cols = 1; cols <= n; cols++) {
        const rows = Math.ceil(n / cols);
        const geom = (TW) => {
            const o = overlay(TW), TH = even(TW * aspect), cellW = TW + 2 * o.margin, cellH = TH + o.barH + 2 * o.margin;
            const blockW = cols * cellW + (cols - 1) * GAP;
            return {TW, TH, cols, rows, o, cellW, cellH, blockW, W: even(2 * GAP + sides * blockW + (sides - 1) * SIDE_GAP), H: even(HEADER_H + COLHEAD_H + rows * cellH + (rows - 1) * GAP + GAP)};
        };
        let TW = floorEven(Math.min(nativeW, (maxW - 2 * GAP - (sides - 1) * SIDE_GAP) / (sides * cols)));
        while (TW > MIN_TILE_W && (geom(TW).W > maxW || geom(TW).H > maxH)) TW -= 2;
        const g = geom(Math.max(MIN_TILE_W, TW));
        if (g.W <= maxW && g.H <= maxH && (!best || g.TW > best.TW)) best = g;
    }
    if (!best) throw new Error(`${sides * n} tiles do not fit ${maxW}x${maxH} at ${MIN_TILE_W} px each: raise --max-width / --max-height`);
    return best;
}

function pickTiles({root, phase, scenario, mode, single}) {
    const runs = Object.fromEntries(VARIANTS.map(v => [v, readRuns(root, v, phase, scenario)]));
    const valid = Object.fromEntries(VARIANTS.map(v => [v, runs[v].filter(isValid)]));
    const medians = Object.fromEntries(VARIANTS.map(v => [v, medianRun(valid[v])]));
    if (mode === "single") {
        if (!single || !VARIANTS.includes(single.variant)) throw new Error(`single mode needs a variant a or b, got ${single && single.variant}`);
        const r = runs[single.variant].find(x => x._run === single.run);
        if (!r) throw new Error(`${phase}/${scenario}: variant ${single.variant} has no ${single.run} (available: ${runs[single.variant].map(x => x._run).join(", ") || "none"})`);
        return {runs, valid, sides: [[{variant: single.variant, run: r}]]};
    }
    if (mode === "median") {
        if (!medians.a || !medians.b) throw new Error(`${phase}/${scenario}: needs at least one valid visible run per variant`);
        return {runs, valid, sides: VARIANTS.map(v => [{variant: v, run: medians[v]}])};
    }
    if (!valid.a.length || !valid.b.length) throw new Error(`${phase}/${scenario}: needs at least one valid run per variant`);
    return {runs, valid, sides: VARIANTS.map(v => valid[v].map(r => ({variant: v, run: r, median: medians[v] && medians[v]._run === r._run})))};
}

/** Renders one scenario and phase: "all" runs (A grid left, B grid right), the "median" pair, or a "single" run; t = 0 at each sync line. */
export function renderAbVideo({root, phase, scenario, mode = "all", single = null, speed = 0.5, fps = 30, out, ffmpeg = "ffmpeg", ffprobe = "ffprobe", fonts,
    maxMb = 14.5, maxWidth = DEFAULT_MAX.width, maxHeight = DEFAULT_MAX.height, scenarioNames}) {
    if (!MODES.includes(mode)) throw new Error(`mode must be one of ${MODES.join(", ")}`);
    const meta = scenarioMeta(root, scenario);
    const labels = {a: "A", b: "B", ...(meta.labels || {})};
    const font = fonts || findFonts();
    const FONT = filterPath(font.bold), FONT_REG = filterPath(font.regular);
    const sync = syncSummary(root, scenarioNames || [...new Set([...(readPlan(root).scenarios || []).map(s => s.name), scenario])]);
    const picked = pickTiles({root, phase, scenario, mode, single});
    const columns = picked.sides.map(side => side.map(p => loadTile(root, p.variant, phase, scenario, p.run, !!p.median)));
    const all = columns.flat();
    if (all.some(t => !t.frames.length)) throw new Error(`${phase}/${scenario}: a picked run has no screencast frames`);
    const vis = Object.fromEntries(VARIANTS.map(v => [v, stats(picked.valid[v].map(r => r.visibleMs).filter(x => typeof x === "number"))]));
    const configured = meta.marks && meta.marks.length ? meta.marks : discoverMarks(root, phase, scenario).map(name => ({name}));
    const everyMark = mode === "single" ? Object.keys(all[0].first).filter(k => !HIDDEN_TICKS.has(k) && all[0].first[k] >= 0)
        .filter(k => !configured.some(m => m.name === k)).map(name => ({name})) : [];
    const tickDefs = [...configured, ...everyMark].map((m, i) => ({k: m.name, label: m.label || m.name, color: m.color || TICK_COLORS[i % TICK_COLORS.length]}))
        .concat([{k: "visible", label: "visible", color: VISIBLE_COLOR}]);
    const suffix = mode === "all" ? "" : mode === "median" ? "-median" : `-${all[0].variant}-${all[0].run}`;
    out = out || path.join(root, "videos", `${phase}-${scenario}${suffix}.mp4`);
    fs.mkdirSync(path.dirname(out), {recursive: true});
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "abv-"));
    try {
        const [imgW, imgH] = execFileSync(ffprobe, ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", all[0].frames[0].file]).toString().trim().split(",").map(Number);
        const crop0 = cropOf(all[0], imgW, imgH);
        const L = chooseLayout({sides: columns.length, n: Math.max(...columns.map(c => c.length)), aspect: crop0.h / crop0.w, nativeW: crop0.w, maxW: maxWidth, maxH: maxHeight});
        const {TW, TH, o, cellW, cellH, blockW, W, H} = L;
        const visibles = all.map(t => t.visible).filter(x => x != null);
        const END_MS = (visibles.length ? Math.max(...visibles) : Math.min(8000, Math.max(...all.map(t => t.frames[t.frames.length - 1].rel)))) + POST_MS;
        const FRAMES = Math.ceil(END_MS / speed / 1000 * fps);
        const msAt = (n) => n * 1000 / fps * speed, secOf = (ms) => (ms / speed / 1000).toFixed(4);
        const MX = o.pad, BAR_W = TW - 2 * MX, xOf = (ms) => MX + Math.round(Math.min(1, Math.max(0, ms / END_MS)) * BAR_W);
        let textN = 0;
        const textFile = (s, expand = false) => { const f = path.join(tmp, `text${textN++}.txt`); fs.writeFileSync(f, expand ? s : s.replace(/[\\%]/g, (c) => `\\${c}`)); return filterPath(f); };
        const placeholder = path.join(tmp, "placeholder.jpg");
        execFileSync(ffmpeg, ["-y", "-v", "error", "-f", "lavfi", "-i", `color=c=${BG}:s=${imgW}x${imgH}`, "-frames:v", "1", placeholder]);

        // Frame sequences: frame n = the last frame at or before msAt(n) on the run's aligned clock; from visible on, the freeze frame.
        const planHash = crypto.createHash("sha256");
        planHash.update(`${mode}|${W}x${H}|${TW}x${TH}|${FRAMES}\n`);
        all.forEach((t, k) => {
            t.dir = path.join(tmp, `t${k}`); fs.mkdirSync(t.dir);
            t.freeze = t.visible == null ? null : (t.frames.find(f => f.rel >= t.visible && f.rel <= t.visible + FREEZE_LAG_MS) || [...t.frames].reverse().find(f => f.rel <= t.visible + FREEZE_LAG_MS) || null);
            let j = -1;
            for (let n = 0; n < FRAMES; n++) {
                const at = msAt(n);
                let src;
                if (t.freeze && at >= t.visible) src = t.freeze.file;
                else { while (j + 1 < t.frames.length && t.frames[j + 1].rel <= at + 1e-9) j++; src = j >= 0 ? t.frames[j].file : placeholder; }
                planHash.update(`${k}:${n}:${src === placeholder ? "-" : `${t.variant}/${t.run}/${path.basename(src)}`}\n`);
                const dst = path.join(t.dir, `s${String(n).padStart(5, "0")}.jpg`);
                try { fs.linkSync(src, dst); } catch { fs.copyFileSync(src, dst); }
            }
        });

        const chains = all.map((t, k) => {
            const c = cropOf(t, imgW, imgH);
            const v = t.visible ?? END_MS;
            let g = `[${k}:v]`;
            // The sync marker is masked in every frame, before the crop, so it never shows in the video.
            if (t.marker) {
                const kx = imgW / (t.marker.vw || imgW), x = Math.max(0, Math.floor(t.marker.x * kx) - 2), y = Math.max(0, Math.floor(t.marker.y * kx) - 2);
                g += `drawbox=x=${x}:y=${y}:w=${Math.ceil(t.marker.size * kx) + 4}:h=${Math.ceil(t.marker.size * kx) + 4}:color=${BG}:t=fill,`;
            }
            g += `crop=${c.w}:${c.h}:${c.x}:${c.y},scale=${TW}:${TH},setsar=1,format=yuv420p,pad=${TW}:${TH + o.barH}:0:0:color=${BG}`;
            g += `,drawtext=fontfile='${FONT}':textfile='${textFile(`%{eif:min(t*${speed * 1000},${Math.round(v)}):d} ms`, true)}':x=${o.pad}:y=${o.pad}:fontsize=${o.timerFont}:fontcolor=white:box=1:boxcolor=black@0.75:boxborderw=${Math.max(3, Math.round(8 * o.s))}`;
            const label = `${t.run}  ·  ${t.visible != null ? `${Math.round(t.visible)} ms` : "not visible"}${t.median ? "  ·  median" : ""}${t.valid ? "" : "  ·  REJECTED"}`;
            g += `,drawtext=fontfile='${FONT_REG}':textfile='${textFile(label)}':x=${o.pad}:y=${TH - o.labelFont - 2 * o.pad}:fontsize=${o.labelFont}:fontcolor=white:box=1:boxcolor=black@0.75:boxborderw=${Math.max(2, Math.round(6 * o.s))}`;
            if (t.visible != null) {
                g += `,drawbox=x=0:y=0:w=${TW}:h=${TH}:color=0xffd600:t=${Math.max(2, Math.round(6 * o.s))}:enable='gte(t\\,${secOf(t.visible)})'`;
                g += `,drawtext=fontfile='${FONT}':textfile='${textFile(`VISIBLE ${Math.round(t.visible)} ms`)}':x=(w-tw)/2:y=${Math.round(TH * 0.42)}:fontsize=${o.visFont}:fontcolor=black:box=1:boxcolor=0xffd600@0.95:boxborderw=${Math.max(3, Math.round(12 * o.s))}:enable='gte(t\\,${secOf(t.visible)})'`;
            }
            const barY = TH + Math.round(12 * o.s);
            g += `,drawbox=x=${MX}:y=${barY}:w=${BAR_W}:h=${Math.max(2, Math.round(4 * o.s))}:color=0x5a5f6e:t=fill`;
            const ticks = tickDefs.map(d => ({...d, t: t.first[d.k]})).filter(d => typeof d.t === "number" && d.t >= 0).sort((a, b) => a.t - b.t);
            // Labels go in the first of LABEL_ROWS rows where they do not overlap the previous label (estimated width).
            const rowEnd = new Array(LABEL_ROWS).fill(-Infinity);
            ticks.forEach((d) => {
                g += `,drawbox=x=${xOf(d.t) - 2}:y=${TH + Math.round(4 * o.s)}:w=${Math.max(2, Math.round(4 * o.s))}:h=${Math.round(20 * o.s)}:color=${d.color}:t=fill`;
                const text = `${d.label} ${Math.round(d.t)}`, width = Math.round(text.length * o.charPx);
                const lx = Math.min(TW - width - 2, Math.max(2, xOf(d.t) - Math.round(width / 2)));
                const row = Math.max(0, rowEnd.findIndex(end => end + 6 <= lx));
                rowEnd[row] = lx + width;
                g += `,drawtext=fontfile='${FONT_REG}':textfile='${textFile(text)}':x=${lx}:y=${TH + Math.round(26 * o.s) + row * (o.tickFont + 3)}:fontsize=${o.tickFont}:fontcolor=${d.color}`;
            });
            g += `,drawtext=fontfile='${FONT}':text='|':fontsize=${Math.max(10, Math.round(28 * o.s))}:fontcolor=white:y=${TH}:x='${MX}+min(t*${speed * 1000}/${END_MS}\\,1)*${BAR_W}-tw/2'`;
            g += `,pad=${cellW}:${cellH}:${o.margin}:${o.margin}:color=${BG}`;
            if (t.median && mode === "all") g += `,drawbox=x=0:y=0:w=${cellW}:h=${cellH}:color=${MEDIAN_COLOR}:t=${o.margin}`;
            return g + `[t${k}]`;
        });
        const layout = columns.flatMap((col, c) => col.map((_, i) =>
            `${GAP + c * (blockW + SIDE_GAP) + (i % L.cols) * (cellW + GAP)}_${Math.floor(i / L.cols) * (cellH + GAP)}`)).join("|");
        let g = all.length > 1
            ? `${chains.join(";")};${all.map((_, k) => `[t${k}]`).join("")}xstack=inputs=${all.length}:layout=${layout}:fill=${BG},pad=${W}:${H}:0:${HEADER_H + COLHEAD_H}:color=${BG}`
            : `${chains[0].replace(/\[t0\]$/, "")},pad=${W}:${H}:${GAP}:${HEADER_H + COLHEAD_H}:color=${BG}`;
        const d = vis.a && vis.b ? vis.b.median - vis.a.median : null;
        const deltaLine = d != null ? `median A ${Math.round(vis.a.median)} ms → B ${Math.round(vis.b.median)} ms  ·  Δ ${d > 0 ? "+" : ""}${Math.round(d)} ms (${d > 0 ? "+" : ""}${(d / vis.a.median * 100).toFixed(1)}%)` : "";
        const lagText = sync && sync.n && sync.lag ? `sync lag median +${sync.lag.median} ms [${sync.lag.min}–${sync.lag.max}] over ${sync.n} runs` : "no sync measured";
        let headline, second;
        if (mode === "single") {
            const t = all[0], r = picked.runs[t.variant].find(x => x._run === t.run);
            headline = `${meta.label || scenario}  ·  ${phase}  ·  ${t.variant.toUpperCase()} ${t.run}  ·  ${labels[t.variant]}`;
            second = `visible ${t.visible != null ? `${Math.round(t.visible)} ms` : "not reached"}  ·  variant ${r.ab && r.ab.variantOk === false ? "REJECTED" : "ok"}  ·  ` +
                `sync ${r.sync && r.sync.ok ? `lag +${r.sync.lagMs} ms (${r.sync.method})` : "missing"}`;
        } else {
            headline = `${meta.label || scenario}  ·  ${phase}  ·  ${mode === "all" ? `all runs  ·  n A ${columns[0].length} / B ${columns[1].length}` : `median runs: A ${columns[0][0].run}, B ${columns[1][0].run}`}`;
            second = deltaLine;
        }
        const info = `${speed}× speed  ·  timers: real ms since each run's sync line  ·  frames aligned per run on its sync marker  ·  ${lagText}${mode === "all" ? "  ·  outlined = median run" : ""}`;
        const fit = (text, size) => Math.max(10, Math.min(size, Math.floor((W - 2 * GAP) / (Math.max(1, text.length) * 0.56))));
        g += `,drawtext=fontfile='${FONT}':textfile='${textFile(headline)}':x=(w-tw)/2:y=14:fontsize=${fit(headline, 34)}:fontcolor=white`;
        g += `,drawtext=fontfile='${FONT}':textfile='${textFile(second || " ")}':x=(w-tw)/2:y=58:fontsize=${fit(second, 28)}:fontcolor=${mode === "single" ? "0xe8eaf0" : d != null && d < 0 ? "0x66bb6a" : "0xef9a9a"}`;
        g += `,drawtext=fontfile='${FONT_REG}':textfile='${textFile(info)}':x=(w-tw)/2:y=98:fontsize=${fit(info, 18)}:fontcolor=0xaab0bf`;
        columns.forEach((col, c) => {
            const v = col[0].variant, head = `${v.toUpperCase()}  ·  ${labels[v]}`;
            g += `,drawtext=fontfile='${FONT}':textfile='${textFile(head)}':x=${GAP + c * (blockW + SIDE_GAP)}+(${blockW}-tw)/2:y=${HEADER_H + 10}:fontsize=${fit(head, 26)}:fontcolor=${SIDE_COLORS[v]}`;
        });
        g += `,format=yuv420p[v]`;
        const gFile = path.join(tmp, "graph.txt"); fs.writeFileSync(gFile, g);
        const encode = (crf) => execFileSync(ffmpeg, ["-y", "-v", "error", ...all.flatMap(t => ["-framerate", String(fps), "-i", path.join(t.dir, "s%05d.jpg")]),
            ...filterScriptArgs(ffmpeg, gFile), "-map", "[v]", "-r", String(fps), "-c:v", "libx264", "-preset", "medium", "-crf", String(crf), "-x264-params", "threads=4",
            "-pix_fmt", "yuv420p", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-movflags", "+faststart", "-an", out], {maxBuffer: 64 << 20, stdio: "pipe"});
        let crf = 22; encode(crf);
        while (fs.statSync(out).size > maxMb * 1024 * 1024 && crf < 36) { crf += 3; encode(crf); }
        const posterTile = mode === "single" ? all[0] : (columns[1].find(t => t.median) || columns[1][0]);
        const posterAt = posterTile.visible ?? END_MS - POST_MS;
        const poster = out.replace(/\.mp4$/, ".jpg");
        execFileSync(ffmpeg, ["-y", "-v", "error", "-i", out, "-vf", `select=eq(n\\,${Math.min(FRAMES - 1, Math.ceil(posterAt / speed / 1000 * fps))})`, "-frames:v", "1", "-q:v", "3",
            "-fflags", "+bitexact", "-flags:v", "+bitexact", poster]);
        return {out, poster, mode, size: `${W}x${H}`, tile: `${TW}x${TH}`, grid: `${L.cols}x${L.rows}`, fps, speed, realMs: END_MS, frames: FRAMES, crf, phase, scenario,
            planSha256: planHash.digest("hex"), tiles: all.map(t => ({variant: t.variant, run: t.run, visible: t.visible, shiftMs: t.shiftMs, median: t.median,
                freezeFrameRelMs: t.freeze ? Math.round(t.freeze.rel) : null}))};
    } finally { fs.rmSync(tmp, {recursive: true, force: true}); }
}
