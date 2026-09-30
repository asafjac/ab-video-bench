import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {mockRun, writeMockFrames} from "../src/mock.mjs";
import {measureSync} from "../src/sync.mjs";
import {runSet} from "../src/runner.mjs";
import {HAVE_FFMPEG, tmpDir, mockConfig} from "./helpers.mjs";

const skip = !HAVE_FFMPEG && "ffmpeg/ffprobe not on PATH";

for (const lagMs of [0, 12, 23, 41]) {
    test(`measureSync recovers an injected ${lagMs} ms frame lag exactly, on and off`, {skip}, () => {
        const dir = tmpDir("sync");
        const run = mockRun({scenario: {name: "list"}, variant: "a", phase: "hot", label: "run-2", lagMs});
        const frames = writeMockFrames({dir: path.join(dir, "run-2.frames"), run});
        const sync = measureSync(frames, run.flash);
        fs.rmSync(dir, {recursive: true, force: true});
        assert.equal(sync.ok, true);
        assert.equal(sync.onErrorMs, lagMs);
        assert.equal(sync.offErrorMs, lagMs);
        assert.equal(sync.litFrames, 12);
    });
}

test("measureSync reports a missing flash instead of guessing", () => {
    assert.deepEqual(measureSync([], null), {ok: false, reason: "no sync flash"});
    assert.equal(measureSync([], {error: "boom"}).reason, "boom");
});

test("the set's sync summary and the video shift equal the injected lag", {skip}, async () => {
    const root = tmpDir("syncset");
    const res = await runSet({config: mockConfig(), root, cold: 2, hot: 0, coldWarmup: 0, mock: true, quiet: true, mockOptions: {lagMs: 23}});
    assert.equal(res.sync.n, 4);
    assert.deepEqual([res.sync.onMin, res.sync.onMax, res.sync.offMin, res.sync.offMax], [23, 23, 23, 23]);
    assert.equal(res.videos[0].frameShiftMs, 23);
    fs.rmSync(root, {recursive: true, force: true});
});
