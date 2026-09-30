import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {fileURLToPath} from "node:url";
import {runSet} from "../src/runner.mjs";
import {renderAbVideo, chooseLayout} from "../src/render.mjs";
import {HAVE_FFMPEG, tmpDir, mockConfig} from "./helpers.mjs";

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), "golden", "mock-render.json");
const md5 = (f) => crypto.createHash("md5").update(fs.readFileSync(f)).digest("hex");
const skip = !HAVE_FFMPEG && "ffmpeg/ffprobe not on PATH";
// Everything but the encoded bytes, which depend on the local ffmpeg/x264 build and font.
const pick = (r) => ({mode: r.mode, size: r.size, tile: r.tile, grid: r.grid, frames: r.frames, realMs: r.realMs, planSha256: r.planSha256, tiles: r.tiles});

test("every mode matches its golden frame plan, and the all-runs video re-renders byte-identical", {skip}, async (t) => {
    const root = tmpDir("golden");
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const res = await runSet({config: mockConfig(), root, cold: 3, hot: 0, mock: true, quiet: true, videoMedian: true});
    assert.deepEqual(res.videos.map(v => v.kind), ["all runs", "median runs"]);
    const all = renderAbVideo({root, phase: "cold", scenario: "list", out: path.join(root, "all-again.mp4")});
    assert.equal(md5(all.out), md5(res.videos[0].file), "re-render of the same set is byte-identical");
    assert.equal(md5(all.poster), md5(res.videos[0].poster));
    const allTwice = renderAbVideo({root, phase: "cold", scenario: "list", out: path.join(root, "all-twice.mp4")});
    assert.equal(md5(allTwice.out), md5(all.out));
    const median = renderAbVideo({root, phase: "cold", scenario: "list", mode: "median", out: path.join(root, "median.mp4")});
    assert.equal(md5(median.out), md5(res.videos[1].file));
    const single = renderAbVideo({root, phase: "cold", scenario: "list", mode: "single", single: {variant: "b", run: "run-2"}, out: path.join(root, "single.mp4")});
    assert.equal(all.tiles.length, 6);
    assert.equal(all.tiles.filter(x => x.median).length, 2);
    assert.ok(all.tiles.every(x => x.shiftMs === 12));
    const actual = {all: pick(all), median: pick(median), single: pick(single)};
    if (process.env.AB_UPDATE_GOLDEN) fs.writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + "\n");
    assert.deepEqual(actual, JSON.parse(fs.readFileSync(GOLDEN, "utf8")));
});

test("render arguments are validated with clear errors", {skip}, async (t) => {
    const root = tmpDir("args");
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    await runSet({config: mockConfig(), root, cold: 1, hot: 0, coldWarmup: 0, mock: true, quiet: true});
    assert.throws(() => renderAbVideo({root, phase: "cold", scenario: "list", mode: "single", single: {variant: "b", run: "run-9"}}), /variant b has no run-9 \(available: run-1\)/);
    assert.throws(() => renderAbVideo({root, phase: "cold", scenario: "list", mode: "single", single: {variant: "c", run: "run-1"}}), /variant a or b/);
    assert.throws(() => renderAbVideo({root, phase: "cold", scenario: "list", mode: "grid"}), /mode must be one of all, median, single/);
    assert.throws(() => renderAbVideo({root, phase: "hot", scenario: "list"}), /at least one valid run per variant/);
});

test("the all-runs layout fits the output cap and prefers the largest tiles", () => {
    for (const n of [1, 5, 10, 15]) {
        const l = chooseLayout({sides: 2, n, aspect: 640 / 900, nativeW: 900, maxW: 1920, maxH: 1080});
        assert.ok(l.W <= 1920 && l.H <= 1080, `n=${n}: ${l.W}x${l.H}`);
        assert.ok(l.cols * l.rows >= n);
    }
    assert.equal(chooseLayout({sides: 2, n: 1, aspect: 640 / 900, nativeW: 900, maxW: 1920, maxH: 1080}).TW, 900);
    assert.deepEqual((({cols, rows}) => ({cols, rows}))(chooseLayout({sides: 2, n: 15, aspect: 640 / 900, nativeW: 900, maxW: 1920, maxH: 1080})), {cols: 4, rows: 4});
    assert.throws(() => chooseLayout({sides: 2, n: 60, aspect: 1, nativeW: 900, maxW: 640, maxH: 480}), /raise --max-width/);
});
