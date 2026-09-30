import test from "node:test";
import assert from "node:assert/strict";
import {abSchedule} from "../src/ab.mjs";

test("schedule alternates A, B inside every phase, warm-ups first, cold before hot", () => {
    const s = abSchedule({scenarios: ["list", "form"], cold: 3, hot: 2, coldWarmup: 1, hotPrime: 1});
    assert.equal(s.length, 2 * (2 * (1 + 3) + 2 * (1 + 2)));
    s.forEach((r, i) => assert.equal(r.variant, i % 2 ? "b" : "a"));
    const list = s.filter(r => r.scenario === "list").map(r => `${r.phase}:${r.label}:${r.variant}`);
    assert.deepEqual(list, ["cold:warmup-1:a", "cold:warmup-1:b", "cold:run-1:a", "cold:run-1:b", "cold:run-2:a", "cold:run-2:b", "cold:run-3:a", "cold:run-3:b",
        "hot:warmup-1:a", "hot:warmup-1:b", "hot:run-1:a", "hot:run-1:b", "hot:run-2:a", "hot:run-2:b"]);
    assert.equal(s.findIndex(r => r.scenario === "form"), list.length);
    for (const v of ["a", "b"]) for (const p of ["cold", "hot"]) assert.equal(s.filter(r => r.variant === v && r.phase === p && r.measured && r.scenario === "list").length, p === "cold" ? 3 : 2);
    assert.ok(s.filter(r => r.label.startsWith("warmup")).every(r => !r.measured));
});

test("schedule skips a phase with 0 runs, priming included", () => {
    const s = abSchedule({scenarios: ["list"], cold: 0, hot: 2});
    assert.ok(s.every(r => r.phase === "hot"));
    assert.equal(s.length, 6);
});

test("warm-up and priming counts are configurable, including zero", () => {
    const s = abSchedule({scenarios: ["list"], cold: 1, hot: 1, coldWarmup: 0, hotPrime: 2});
    assert.deepEqual(s.map(r => `${r.phase}:${r.label}`), ["cold:run-1", "cold:run-1", "hot:warmup-1", "hot:warmup-1", "hot:warmup-2", "hot:warmup-2", "hot:run-1", "hot:run-1"]);
});
