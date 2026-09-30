import fs from "node:fs";
import {execFileSync} from "node:child_process";

const FONT_CANDIDATES = {
    bold: [
        "C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/segoeuib.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/Library/Fonts/Arial Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ],
    regular: [
        "C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/segoeui.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf", "/Library/Fonts/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/TTF/DejaVuSans.ttf", "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ],
};

/** {bold, regular} font files for drawtext: explicit paths, then AB_FONT_BOLD / AB_FONT, then common system fonts. */
export function findFonts({bold, regular} = {}) {
    const pick = (explicit, env, list) => {
        for (const f of [explicit, process.env[env], ...list]) if (f && fs.existsSync(f)) return f;
        return null;
    };
    const reg = pick(regular, "AB_FONT", FONT_CANDIDATES.regular);
    const b = pick(bold, "AB_FONT_BOLD", FONT_CANDIDATES.bold) || reg;
    if (!reg) throw new Error("no TrueType font found for the video overlay: pass --font <file.ttf> or set AB_FONT");
    return {bold: b, regular: reg};
}

/** A file path escaped for a single-quoted ffmpeg filter option value. */
export const filterPath = (p) => p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");

export function hasBinary(bin) {
    try { execFileSync(bin, ["-version"], {stdio: "pipe", timeout: 20000}); return true; } catch { return false; }
}

const majorCache = new Map();
export function ffmpegMajor(ffmpeg) {
    if (!majorCache.has(ffmpeg)) {
        let major = 0;
        try { major = Number((/version n?(\d+)/.exec(execFileSync(ffmpeg, ["-version"], {encoding: "utf8"})) || [])[1] || 0); } catch { /* unknown */ }
        majorCache.set(ffmpeg, major);
    }
    return majorCache.get(ffmpeg);
}

/** Arguments that load a filter graph from a file: `-/filter_complex` on ffmpeg >= 7, the older script option before that. */
export const filterScriptArgs = (ffmpeg, file) => (ffmpegMajor(ffmpeg) >= 7 || ffmpegMajor(ffmpeg) === 0 ? ["-/filter_complex", file] : ["-filter_complex_script", file]);
