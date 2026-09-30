import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {stats, median, quantile} from "../src/stats.mjs";
import {buildReport, medianRun, markMedians} from "../src/ab.mjs";
import {tmpDir} from "./helpers.mjs";

test("stats: median and p25/p75 by linear interpolation", () => {
    assert.deepEqual(stats([1, 2, 3, 4]), {n: 4, median: 2.5, p25: 1.75, p75: 3.25, iqr: 1.5});
    const s = stats([10, 50, 20, 40, 30]);
    assert.equal(s.median, 30); assert.equal(s.p25, 20); assert.equal(s.p75, 40); assert.equal(s.iqr, 20);
    assert.equal(stats([]), null);
    assert.equal(median([7]), 7);
    assert.equal(quantile([0, 10], 0.9), 9);
});

test("medianRun picks the run closest to the median visible, skipping rejected and invisible runs", () => {
    const runs = [{visibleMs: 300, _run: "run-1"}, {visibleMs: 100, _run: "run-2"}, {visibleMs: 210, _run: "run-3"},
        {visibleMs: 205, _run: "run-4", ab: {variantOk: false}}, {visibleMs: null, _run: "run-5"}];
    assert.equal(medianRun(runs)._run, "run-3");
    assert.equal(medianRun([]), null);
});

test("report: n, median [p25–p75], IQR, delta, rejected runs excluded", () => {
    const root = tmpDir("report");
    const put = (variant, i, visible, ab = {variantOk: true}) => {
        const dir = path.join(root, variant, "cold", "list"); fs.mkdirSync(dir, {recursive: true});
        fs.writeFileSync(path.join(dir, `run-${i}.summary.json`), JSON.stringify({visibleMs: visible, ab}));
    };
    [100, 200, 300].forEach((v, i) => put("a", i + 1, v));
    put("b", 1, 60); put("b", 2, 80); put("b", 3, 5, {variantOk: false, variantReason: "the page reported a"});
    const {rows, md} = buildReport(root, [{name: "list"}]);
    fs.rmSync(root, {recursive: true, force: true});
    assert.equal(rows.length, 1);
    const v = rows[0].visible;
    assert.equal(v.a.median, 200); assert.equal(v.b.median, 70); assert.equal(v.b.n, 2); assert.equal(v.delta, -130);
    assert.equal(rows[0].counts.b.rejected, 1);
    assert.match(md, /\| cold \| list \| 3\/2 \| 200 \[150–250\] \| 100 \| 70 \[65–75\] \| 10 \| -130 \| -65\.0% \| 0\/0 \| 1 \|/);
    assert.match(md, /Rejected: B run-3 \(the page reported a\)/);
});

test("markMedians compares first-occurrence marks per variant", () => {
    const root = tmpDir("marks");
    for (const [variant, rel] of [["a", [900, 1100]], ["b", [300, 500]]]) rel.forEach((r, i) => {
        const dir = path.join(root, variant, "cold", "list"); fs.mkdirSync(dir, {recursive: true});
        fs.writeFileSync(path.join(dir, `run-${i + 1}.summary.json`), JSON.stringify({visibleMs: r + 500}));
        fs.writeFileSync(path.join(dir, `run-${i + 1}.timeline.json`), JSON.stringify({first: {dataRequested: r, visible: r + 500, syncFlashOn: -1000}}));
    });
    const m = markMedians(root, "cold", "list");
    fs.rmSync(root, {recursive: true, force: true});
    assert.deepEqual(m.map(x => x.mark), ["dataRequested"]);
    assert.equal(m[0].a.median, 1000); assert.equal(m[0].b.median, 400); assert.equal(m[0].delta, -600);
});
