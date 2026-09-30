#!/usr/bin/env node
import path from "node:path";
import {parseArgs, fail} from "../src/cli.mjs";
import {renderAbVideo} from "../src/render.mjs";
import {findFonts} from "../src/media.mjs";

const USAGE = `ab-video: side-by-side A vs B video of one scenario from an ab-bench output directory.

  ab-video --root <dir> --phase cold|hot --scenario <name> [options]

  --grid          every valid run, one row each (default: the median-visible run per variant)
  --speed X       playback speed (default 0.5)
  --fps N         output frame rate (default 30)
  --out FILE      output .mp4 (default <root>/videos/<phase>-<scenario>[-grid].mp4; a .jpg poster is written next to it)
  --font FILE     TrueType font (bold: --font-bold)
  --max-mb X      re-encode with a higher CRF until the file is under X MB (default 14.5)`;

const args = parseArgs(process.argv.slice(2));
if (args.has("help") || args.has("h")) { console.log(USAGE); process.exit(0); }
if (!args.get("root") || !args.get("phase") || !args.get("scenario")) fail(USAGE);
try {
    const res = renderAbVideo({root: path.resolve(args.get("root")), phase: args.get("phase"), scenario: args.get("scenario"), grid: args.has("grid"),
        speed: args.num("speed", 0.5), fps: args.num("fps", 30), out: args.get("out") && path.resolve(args.get("out")), maxMb: args.num("max-mb", 14.5),
        fonts: findFonts({regular: args.get("font"), bold: args.get("font-bold")})});
    console.log(JSON.stringify(res, null, 2));
} catch (e) {
    fail(`ab-video: ${(e.stderr || e.message).toString()}`);
}
