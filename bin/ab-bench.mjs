#!/usr/bin/env node
import fs from "node:fs";
import {parseArgs, fail} from "../src/cli.mjs";
import {loadConfig} from "../src/scenario.mjs";
import {runSet, runSingle} from "../src/runner.mjs";

const USAGE = `ab-bench: A/B page-load benchmark with strict A, B alternation, cold and hot sets, and annotated videos.

  ab-bench --config <scenarios.mjs|.json> [options]                            a full A/B set
  ab-bench --config <file> --single [--variant a|b] [--cold|--hot] [--prime] <scenario>   one diagnostic run

A/B set:
  --cold N            measured cold A+B pairs per scenario (default 5)
  --hot N             measured hot A+B pairs per scenario (default 5)
  --cold-warmup N     discarded cold warm-up pairs before the cold set (default 1)
  --hot-prime N       discarded priming pairs before the hot set (default 1)
  --scenarios a,b     only these scenario names
  --no-videos         skip the videos (the screencast is still recorded to measure the sync lag)
  --video-median      also render the median-run side-by-side video

Single run (diagnostics): one run of one variant (default b, cold), no alternation and no stats; writes the run's
artifacts, one full-size video with every mark, and prints its timeline.
  --variant a|b       which variant (default b)
  --cold | --hot      cache mode (default cold)
  --prime             one discarded run of the same variant first (hot only)

Common:
  --root DIR          output directory (default ./ab-results/<date>[-...])
  --port N            attach to a Chrome already listening for DevTools on this port
  --chrome PATH       Chrome/Chromium to launch (default: auto-detected, or CHROME_PATH)
  --headed            launch a visible window instead of headless
  --timeout-ms N      per-run wait for "visible" (default 30000)
  --settle-ms N       recording kept after "visible" (default 1000)
  --sync-flash        also show the pre-run flash, used when a run's sync marker is not found in the frames
  --auth-challenges cancel|ignore
                      HTTP auth challenges (401/407 sign-in): cancel = answer with CancelAuth and reject the run
                      (default); ignore = leave them to the browser, and stop the set before the next cold run
  --speed X           video playback speed (default 0.5)
  --fps N             video frame rate (default 30)
  --max-width N       output video cap (default 1920)
  --max-height N      output video cap (default 1080)
  --font FILE         TrueType font for the overlay (bold: --font-bold)
  --allow-battery     do not wait for AC power
  --mock              no browser: synthetic frames and marks through the whole pipeline
  --mock-lag-ms N     frame lag injected in mock mode (default 12)

Create <root>/STOP to stop a set after the current run. Exit code 0 = no rejected or failed runs, 2 = otherwise.`;

const argv = process.argv.slice(2);
const args = parseArgs(argv);
if (args.has("help") || args.has("h")) { console.log(USAGE); process.exit(0); }
const configPath = args.get("config");
if (!configPath) fail(USAGE);
if (!fs.existsSync(configPath)) fail(`config not found: ${configPath}`);

const VALUE_FLAGS = new Set(["config", "root", "port", "chrome", "timeout-ms", "settle-ms", "speed", "fps", "max-width", "max-height", "font", "font-bold",
    "mock-lag-ms", "variant", "scenarios", "cold-warmup", "hot-prime", "auth-challenges"]);

try {
    const config = await loadConfig(configPath, {argv});
    const common = {root: args.get("root"), mock: args.has("mock"), videos: !args.has("no-videos"), speed: args.num("speed", 0.5), fps: args.num("fps", 30),
        allowBattery: args.has("allow-battery"), syncFlash: args.has("sync-flash"), authChallenges: args.get("auth-challenges", "cancel"),
        maxWidth: args.get("max-width") ? args.int("max-width") : undefined, maxHeight: args.get("max-height") ? args.int("max-height") : undefined,
        timeoutMs: args.get("timeout-ms") ? args.int("timeout-ms") : undefined, settleMs: args.get("settle-ms") ? args.int("settle-ms") : undefined,
        chrome: {port: args.get("port") ? args.int("port") : undefined, executable: args.get("chrome"), headless: !args.has("headed")},
        fonts: {regular: args.get("font"), bold: args.get("font-bold")}, mockOptions: {lagMs: args.get("mock-lag-ms") ? args.int("mock-lag-ms") : undefined}};
    if (args.has("single")) {
        const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && VALUE_FLAGS.has(argv[i - 1].slice(2))));
        if (positional.length > 1) throw new Error(`--single takes one scenario, got ${positional.join(", ")}`);
        if (args.has("cold") && args.has("hot")) throw new Error("--single takes --cold or --hot, not both");
        const res = await runSingle({...common, config, scenario: positional[0] || args.get("scenario"), variant: args.get("variant", "b"),
            phase: args.has("hot") ? "hot" : "cold", prime: args.has("prime")});
        process.exit(res.summary && res.summary.ab.valid ? 0 : 2);
    }
    const only = args.get("scenarios") ? args.get("scenarios").split(",").map(s => s.trim()).filter(Boolean) : null;
    const res = await runSet({...common, config, only, cold: args.int("cold", 5), hot: args.int("hot", 5), coldWarmup: args.int("cold-warmup", 1),
        hotPrime: args.int("hot-prime", 1), videoMedian: args.has("video-median")});
    process.exit(res.state === "done" && !res.rejected.length && !res.failed.length ? 0 : 2);
} catch (e) {
    fail(`ab-bench: ${e.message}`);
}
