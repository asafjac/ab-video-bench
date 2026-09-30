import test from "node:test";
import assert from "node:assert/strict";
import {buildRunTimeline} from "../src/timeline.mjs";

test("buildRunTimeline puts every mark relative to t0, in order, with first occurrences", () => {
    const t0 = 1_000_000;
    const tl = buildRunTimeline({summary: {t0Epoch: t0, t0Source: "click", visibleMs: 900, scenario: "list", label: "run-1", variant: "b", phase: "cold"},
        marks: [{mark: "dataReceived", frame: "top", epochMs: t0 + 500, variant: "candidate", consoleTs: 1},
            {mark: "dataRequested", frame: "iframe", epochMs: t0 + 200.26, variant: "candidate"},
            {mark: "dataRequested", frame: "top", epochMs: t0 + 700, variant: "candidate"},
            {mark: "syncFlashOn", frame: "top", source: "recorder", epochMs: t0 - 1000, variant: null}]});
    assert.deepEqual(tl.marks.map(m => m.mark), ["syncFlashOn", "start", "dataRequested", "dataReceived", "dataRequested"]);
    assert.deepEqual(tl.first, {syncFlashOn: -1000, start: 0, dataRequested: 200.3, dataReceived: 500, visible: 900});
    assert.equal(tl.reportedVariant, "candidate");
    assert.equal(tl.marks[2].frame, "iframe");
    assert.ok(tl.marks.every(m => m.consoleTs === undefined));
});

test("a run that never became visible has no visible entry", () => {
    const tl = buildRunTimeline({summary: {t0Epoch: 5, visibleMs: null}, marks: [{mark: "visible", epochMs: 1, source: "recorder"}]});
    assert.equal(tl.first.visible, undefined);
    assert.equal(tl.visibleMs, null);
});
