#!/usr/bin/env node
import fs from "node:fs";
import {parseArgs, fail} from "../src/cli.mjs";
import {loadConfig} from "../src/scenario.mjs";
import {runSet} from "../src/runner.mjs";

const USAGE = `ab-bench: A/B page-load benchmark with strict A, B alternation, cold and hot sets, and side-by-side videos.

  ab-bench --config <scenarios.mjs|.json> [options]

  --cold N            measured cold A+B pairs per scenario (default 5)
  --hot N             measured hot A+B pairs per scenario (default 5)
  --cold-warmup N     discarded cold warm-up pairs before the cold set (default 1)
  --hot-prime N       discarded priming pairs before the hot set (default 1)
  --scenarios a,b     only these scenario names
  --root DIR          output directory (default ./ab-results/<date>[-N])
  --port N            attach to a Chrome already listening for DevTools on this port
  --chrome PATH       Chrome/Chromium to launch (default: auto-detected, or CHROME_PATH)
  --headed            launch a visible window instead of headless
  --timeout-ms N      per-run wait for "visible" (default 30000)
  --settle-ms N       recording kept after "visible" (default 1000)
  --no-videos         skip screencast frames and videos
  --video-grid        also render every run, one row each
  --speed X           video playback speed (default 0.5)
  --fps N             video frame rate (default 30)
  --font FILE         TrueType font for the overlay (bold: --font-bold)
  --allow-battery     do not wait for AC power
  --mock              no browser: synthetic frames and marks through the whole pipeline
  --mock-lag-ms N     frame lag injected in mock mode (default 12)

Create <root>/STOP to stop after the current run. Exit code 0 = done with no rejected runs, 2 = otherwise.`;

const args = parseArgs(process.argv.slice(2));
if (args.has("help") || args.has("h")) { console.log(USAGE); process.exit(0); }
const configPath = args.get("config");
if (!configPath) fail(USAGE);
if (!fs.existsSync(configPath)) fail(`config not found: ${configPath}`);

try {
    const config = await loadConfig(configPath, {argv: process.argv.slice(2)});
    const only = args.get("scenarios") ? args.get("scenarios").split(",").map(s => s.trim()).filter(Boolean) : null;
    const res = await runSet({config, only, root: args.get("root"), cold: args.int("cold", 5), hot: args.int("hot", 5), coldWarmup: args.int("cold-warmup", 1),
        hotPrime: args.int("hot-prime", 1), mock: args.has("mock"), videos: !args.has("no-videos"), videoGrid: args.has("video-grid"),
        speed: args.num("speed", 0.5), fps: args.num("fps", 30), allowBattery: args.has("allow-battery"),
        timeoutMs: args.get("timeout-ms") ? args.int("timeout-ms") : undefined, settleMs: args.get("settle-ms") ? args.int("settle-ms") : undefined,
        chrome: {port: args.get("port") ? args.int("port") : undefined, executable: args.get("chrome"), headless: !args.has("headed")},
        fonts: {regular: args.get("font"), bold: args.get("font-bold")}, mockOptions: {lagMs: args.get("mock-lag-ms") ? args.int("mock-lag-ms") : undefined}});
    process.exit(res.state === "done" && !res.rejected.length && !res.failed.length ? 0 : 2);
} catch (e) {
    fail(`ab-bench: ${e.message}`);
}
