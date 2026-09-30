import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {runSingle} from "../src/runner.mjs";
import {HAVE_FFMPEG, tmpDir, mockConfig} from "./helpers.mjs";

test("single run (mock): one run, its artifacts, a printed timeline and one full-size video", {skip: !HAVE_FFMPEG && "ffmpeg/ffprobe not on PATH"}, async (t) => {
    const root = tmpDir("single");
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const res = await runSingle({config: mockConfig(), scenario: "list", variant: "a", phase: "hot", prime: true, root, mock: true, quiet: true});
    const dir = path.join(root, "a", "hot", "list");
    for (const f of ["run-1.summary.json", "run-1.timeline.json", "run-1.console.json", "run-1.frames/index.json", "warmup-1.summary.json"])
        assert.ok(fs.existsSync(path.join(dir, f)), f);
    assert.equal(fs.existsSync(path.join(root, "b")), false, "no B runs");
    assert.equal(res.summary.ab.valid, true);
    const text = res.lines.join("\n");
    assert.match(text, /variant: expected baseline, page reported baseline -> ok/);
    assert.match(text, /sync: lag \+12 ms by marker/);
    assert.match(text, /^\s+0\.0 {2}sync /m);
    assert.match(text, /dataReceived/);
    assert.equal(res.video.mode, "single");
    assert.equal(res.video.tiles.length, 1);
    assert.equal(res.video.tile, "480x640", "native size");
    assert.ok(fs.existsSync(res.video.out));
});

test("single run arguments are validated", async () => {
    const config = mockConfig();
    await assert.rejects(runSingle({config, scenario: "list", variant: "c", mock: true, quiet: true}), /--variant must be a or b, got "c"/);
    await assert.rejects(runSingle({config, scenario: "nope", mock: true, quiet: true}), /unknown scenario "nope" \(known: list\)/);
    await assert.rejects(runSingle({config, scenario: "list", phase: "cold", prime: true, mock: true, quiet: true}), /--prime only applies to a hot single run/);
    await assert.rejects(runSingle({config, mock: true, quiet: true}), /name the scenario/);
});
