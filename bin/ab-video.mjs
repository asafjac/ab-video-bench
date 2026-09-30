#!/usr/bin/env node
import path from "node:path";
import {parseArgs, fail} from "../src/cli.mjs";
import {renderAbVideo, readPlan, DEFAULT_MAX} from "../src/render.mjs";
import {findFonts} from "../src/media.mjs";

const USAGE = `ab-video: re-render a video from an ab-bench output directory.

  ab-video --root <dir> --phase cold|hot --scenario <name> [options]

  (default)       all runs: A runs in a grid on the left, B runs on the right, run k in the same cell on both sides,
                  every tile starting at its own sync line; the median run of each variant is outlined
  --median        only the median-visible run of each variant, side by side at full size
                  (a single-run directory from ab-bench --single renders its one run automatically)
  --speed X       playback speed (default 0.5)
  --fps N         output frame rate (default 30)
  --max-width N   output cap in px (default ${DEFAULT_MAX.width}); tiles shrink to fit
  --max-height N  output cap in px (default ${DEFAULT_MAX.height})
  --out FILE      output .mp4 (default <root>/videos/<phase>-<scenario>[-median].mp4; a .jpg poster is written next to it)
  --font FILE     TrueType font (bold: --font-bold)
  --max-mb X      re-encode with a higher CRF until the file is under X MB (default 14.5)`;

const args = parseArgs(process.argv.slice(2));
if (args.has("help") || args.has("h")) { console.log(USAGE); process.exit(0); }
if (!args.get("root") || !args.get("phase") || !args.get("scenario")) fail(USAGE);
try {
    const root = path.resolve(args.get("root"));
    const plan = readPlan(root);
    const single = plan.mode === "single";
    if (single && args.has("median")) throw new Error("--median needs an A/B set; this directory holds a single run");
    const res = renderAbVideo({root, phase: args.get("phase"), scenario: args.get("scenario"), mode: single ? "single" : args.has("median") ? "median" : "all",
        single: single ? {variant: plan.variant, run: "run-1"} : null, speed: args.num("speed", 0.5), fps: args.num("fps", 30),
        out: args.get("out") && path.resolve(args.get("out")), maxMb: args.num("max-mb", 14.5),
        maxWidth: args.get("max-width") ? args.int("max-width") : undefined, maxHeight: args.get("max-height") ? args.int("max-height") : undefined,
        fonts: findFonts({regular: args.get("font"), bold: args.get("font-bold")})});
    console.log(JSON.stringify(res, null, 2));
} catch (e) {
    fail(`ab-video: ${(e.stderr || e.message).toString()}`);
}
