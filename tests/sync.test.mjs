import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {mockRun, writeMockFrames} from "../src/mock.mjs";
import {measureSync, resolveSync} from "../src/sync.mjs";
import {checkSync} from "../src/ab.mjs";
import {runSet} from "../src/runner.mjs";
import {readRuns} from "../src/ab.mjs";
import {HAVE_FFMPEG, tmpDir, mockConfig} from "./helpers.mjs";

const skip = !HAVE_FFMPEG && "ffmpeg/ffprobe not on PATH";

for (const lagMs of [0, 12, 23, 41]) {
    test(`the sync marker recovers an injected ${lagMs} ms frame lag exactly, on and off`, {skip}, () => {
        const dir = tmpDir("sync");
        const run = mockRun({scenario: {name: "list"}, variant: "a", phase: "hot", label: "run-2", lagMs});
        const frames = writeMockFrames({dir: path.join(dir, "run-2.frames"), run});
        const sync = resolveSync({marks: run.marks, frames});
        fs.rmSync(dir, {recursive: true, force: true});
        assert.equal(sync.ok, true);
        assert.equal(sync.method, "marker");
        assert.equal(sync.lagMs, lagMs);
        assert.equal(sync.offLagMs, lagMs);
        assert.equal(sync.litFrames, 6);
        assert.equal(sync.anchor, "syncFrame");
    });
}

test("the optional pre-run flash still measures the lag, and is the fallback when the marker is missing", {skip}, () => {
    const dir = tmpDir("flash");
    const run = mockRun({scenario: {name: "list"}, variant: "b", phase: "cold", label: "run-1", lagMs: 23, flash: true});
    const frames = writeMockFrames({dir: path.join(dir, "f"), run});
    assert.equal(measureSync(frames, run.flash).onErrorMs, 23);
    const noMarker = run.marks.map(m => (m.mark === "sync" ? {...m, marker: {...m.marker, x: 200, y: 600}} : m));
    const s = resolveSync({marks: noMarker, frames, flash: run.flash});
    fs.rmSync(dir, {recursive: true, force: true});
    assert.equal(s.ok, true);
    assert.equal(s.method, "flash");
    assert.equal(s.lagMs, 23);
    assert.match(s.markerReason, /none of the/);
});

test("a run without a sync line is rejected with a clear reason", {skip}, () => {
    const dir = tmpDir("nosync");
    const run = mockRun({scenario: {name: "list"}, variant: "a", phase: "cold", label: "run-1", sync: false});
    const frames = writeMockFrames({dir: path.join(dir, "f"), run});
    const s = resolveSync({marks: run.marks, frames});
    fs.rmSync(dir, {recursive: true, force: true});
    assert.equal(s.ok, false);
    assert.match(checkSync({sync: s}).reason, /no sync line/);
});

test("measureSync reports a missing anchor instead of guessing", () => {
    assert.deepEqual(measureSync([], null), {ok: false, reason: "no sync anchor"});
    assert.equal(measureSync([], {error: "boom"}).reason, "boom");
});

test("each run's lag lands in summary.sync, the report and the per-tile video shift", {skip}, async () => {
    const root = tmpDir("syncset");
    const res = await runSet({config: mockConfig(), root, cold: 2, hot: 0, coldWarmup: 0, mock: true, quiet: true, mockOptions: {lagMs: 23}});
    assert.equal(res.sync.n, 4);
    assert.deepEqual([res.sync.lag.min, res.sync.lag.max, res.sync.offLag.median], [23, 23, 23]);
    assert.ok(readRuns(root, "b", "cold", "list").every(r => r.sync.lagMs === 23 && r.ab.syncOk));
    assert.match(fs.readFileSync(res.reportFile, "utf8"), /Frame \/ log alignment \(sync marker\)[\s\S]*lag .* median 23 ms \[23–23\]/);
    const v = JSON.parse(fs.readFileSync(path.join(root, "report.json"), "utf8"));
    assert.equal(v.videos.length, 1);
    fs.rmSync(root, {recursive: true, force: true});
});

test("a run missing its sync line is rejected in a set, and the set continues", async () => {
    const root = tmpDir("syncreject");
    const res = await runSet({config: mockConfig(), root, cold: 2, hot: 0, mock: true, videos: false, quiet: true, mockOptions: {noSync: "list/cold/a/run-2"}});
    assert.equal(res.state, "done");
    assert.deepEqual(res.rejected.map(r => `${r.variant}/${r.label}`), ["a/run-2"]);
    assert.match(res.rejected[0].reason, /no sync line/);
    assert.equal(res.rows[0].visible.a.n, 1);
    fs.rmSync(root, {recursive: true, force: true});
});
