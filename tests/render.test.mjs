import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {fileURLToPath} from "node:url";
import {runSet} from "../src/runner.mjs";
import {renderAbVideo} from "../src/render.mjs";
import {HAVE_FFMPEG, tmpDir, mockConfig} from "./helpers.mjs";

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), "golden", "mock-render.json");
const md5 = (f) => crypto.createHash("md5").update(fs.readFileSync(f)).digest("hex");

test("mock set renders byte-identical videos twice and matches the golden frame plan", {skip: !HAVE_FFMPEG && "ffmpeg/ffprobe not on PATH"}, async (t) => {
    const root = tmpDir("golden");
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const res = await runSet({config: mockConfig(), root, cold: 3, hot: 0, mock: true, quiet: true, videoGrid: true});
    assert.equal(res.videos.length, 2);
    const first = res.videos.map(v => ({file: v.file, md5: md5(v.file), poster: md5(v.poster)}));
    const again = renderAbVideo({root, phase: "cold", scenario: "list", out: path.join(root, "again.mp4")});
    assert.equal(md5(again.out), first[0].md5, "re-render of the same set is byte-identical");
    assert.equal(md5(again.poster), first[0].poster);
    const grid = renderAbVideo({root, phase: "cold", scenario: "list", grid: true, out: path.join(root, "again-grid.mp4")});
    assert.equal(md5(grid.out), first[1].md5);
    const actual = {single: pick(again), grid: pick(grid)};
    if (process.env.AB_UPDATE_GOLDEN) fs.writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + "\n");
    assert.deepEqual(actual, JSON.parse(fs.readFileSync(GOLDEN, "utf8")));
});

// Everything but the encoded bytes, which depend on the local ffmpeg/x264 build and font.
const pick = (r) => ({size: r.size, tile: r.tile, frames: r.frames, realMs: r.realMs, frameShiftMs: r.frameShiftMs, planSha256: r.planSha256, tiles: r.tiles});
