import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {findChrome} from "../src/chrome.mjs";
import {loadConfig, normalizeConfig} from "../src/scenario.mjs";
import {runSet} from "../src/runner.mjs";
import {startDemoServer} from "../demo/server.mjs";
import {HAVE_FFMPEG, tmpDir} from "./helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const skip = !findChrome() ? "no Chrome/Chromium found (set CHROME_PATH)" : !HAVE_FFMPEG ? "ffmpeg/ffprobe not on PATH" : false;

test("demo end to end: headless Chrome, both start actions, OOPIF marks, variant check, videos", {skip, timeout: 300000}, async () => {
    const server = await startDemoServer({port: 0});
    process.env.AB_DEMO_BASE_URL = server.baseUrl;
    const root = tmpDir("demo");
    try {
        const config = await loadConfig(path.join(HERE, "..", "demo", "scenarios.mjs"));
        const res = await runSet({config, root, cold: 1, hot: 1, coldWarmup: 0, hotPrime: 1, allowBattery: true, quiet: true});
        assert.equal(res.state, "done");
        assert.deepEqual(res.failed, []);
        assert.deepEqual(res.rejected, []);
        assert.equal(res.rows.length, 4);
        for (const r of res.rows) {
            assert.ok(r.visible.a && r.visible.b, `${r.phase}/${r.scenario} has visible runs on both sides`);
            assert.ok(r.visible.delta < 0, `${r.phase}/${r.scenario}: the parallel candidate is faster (${r.visible.delta} ms)`);
        }
        const tl = JSON.parse(fs.readFileSync(path.join(root, "a", "cold", "landing", "run-1.timeline.json"), "utf8"));
        assert.ok(tl.marks.some(m => m.mark === "frameReady" && m.frame === "iframe" && m.variant === "baseline"), "marks from the cross-site iframe are collected");
        const s = JSON.parse(fs.readFileSync(path.join(root, "b", "cold", "panel", "run-1.summary.json"), "utf8"));
        assert.match(s.t0Source, /click/);
        assert.ok(s.clearing.before.every(c => c.ok), "cold clearing steps all succeeded");
        assert.ok(res.sync && res.sync.n >= 4, "sync flash measured");
        assert.equal(res.videos.length, 4);
        for (const v of res.videos) assert.ok(fs.statSync(v.file).size > 10000);
    } finally {
        await server.close();
        fs.rmSync(root, {recursive: true, force: true});
    }
});

test("every variant strategy reaches the page and passes the variant check", {skip, timeout: 300000}, async () => {
    const server = await startDemoServer({port: 0});
    const base = server.baseUrl;
    const values = {a: "baseline", b: "candidate"};
    const strategies = {
        query: {type: "query", param: "variant", values},
        localStorage: {type: "localStorage", key: "ab_variant", values},
        header: {type: "header", name: "X-AB-Variant", values},
        url: {type: "url", urls: {a: `${base}/?variant=baseline`, b: `${base}/?variant=candidate`}, expect: values},
    };
    const config = normalizeConfig({viewport: {width: 900, height: 640}, scenarios: Object.entries(strategies).map(([name, variant]) => ({
        name, url: `${base}/`, variant, visible: () => document.querySelectorAll("#grid .tile.ready").length >= 12}))});
    const root = tmpDir("strategies");
    try {
        const res = await runSet({config, root, cold: 0, hot: 1, hotPrime: 0, videos: false, allowBattery: true, quiet: true});
        assert.equal(res.state, "done");
        assert.deepEqual(res.failed, []);
        assert.deepEqual(res.rejected, []);
        for (const name of Object.keys(strategies)) for (const v of ["a", "b"]) {
            const s = JSON.parse(fs.readFileSync(path.join(root, v, "hot", name, "run-1.summary.json"), "utf8"));
            assert.equal(s.ab.variantOk, true, `${name}/${v}`);
            assert.ok(s.variantReport.globals.includes(values[v]), `${name}/${v} reported ${s.variantReport.globals}`);
        }
    } finally {
        await server.close();
        fs.rmSync(root, {recursive: true, force: true});
    }
});
