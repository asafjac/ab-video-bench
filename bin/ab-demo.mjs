#!/usr/bin/env node
import path from "node:path";
import {fileURLToPath} from "node:url";
import {parseArgs, fail} from "../src/cli.mjs";
import {loadConfig} from "../src/scenario.mjs";
import {runSet, defaultRoot} from "../src/runner.mjs";
import {startDemoServer} from "../demo/server.mjs";

const USAGE = `ab-demo: serves the bundled demo site, runs a full A/B set against it in headless Chrome and renders the videos.

  ab-demo [--cold 3] [--hot 3] [--scenarios landing,panel] [--root DIR] [--headed] [--chrome PATH] [--mock]`;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
if (args.has("help") || args.has("h")) { console.log(USAGE); process.exit(0); }

const server = args.has("mock") ? null : await startDemoServer({port: 0});
if (server) process.env.AB_DEMO_BASE_URL = server.baseUrl;
try {
    const config = await loadConfig(path.join(HERE, "..", "demo", "scenarios.mjs"));
    const only = args.get("scenarios") ? args.get("scenarios").split(",") : null;
    const res = await runSet({config, only, root: args.get("root") || defaultRoot("ab-results", args.has("mock") ? "-demo-mock" : "-demo"),
        cold: args.int("cold", 3), hot: args.int("hot", 3), coldWarmup: args.int("cold-warmup", 1), hotPrime: args.int("hot-prime", 1),
        mock: args.has("mock"), allowBattery: true, chrome: {executable: args.get("chrome"), headless: !args.has("headed")}});
    console.log(`\nreport: ${res.reportFile}`);
    for (const v of res.videos) console.log(`video:  ${v.file}`);
    if (res.sync && res.sync.n) console.log(`sync lag (first marker frame minus its drawing frame): median ${res.sync.lag.median} ms [${res.sync.lag.min}–${res.sync.lag.max}], removal median ${res.sync.offLag ? res.sync.offLag.median : "—"} ms, n=${res.sync.n}`);
    process.exitCode = res.state === "done" && !res.rejected.length && !res.failed.length ? 0 : 2;
} catch (e) {
    fail(`ab-demo: ${e.message}`);
} finally {
    if (server) await server.close();
}
