import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import {fileURLToPath} from "node:url";

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "browser", "abmark.js"), "utf8");

function load({top = true, prefix} = {}) {
    const lines = [], marks = [];
    const window = {ABMARK_PREFIX: prefix};
    window.top = top ? window : {};
    const ctx = {window, console: {info: (s) => lines.push(s)}, performance: {timeOrigin: 1000, now: () => 250.5, mark: (n, o) => marks.push([n, o])}};
    vm.runInNewContext(SRC, ctx);
    return {api: window.ABMark, window, lines, marks};
}

test("mark writes one prefixed JSON line with the contract fields and a performance.mark", () => {
    const {api, lines, marks} = load();
    api.mark("dataReceived", {rows: 12, epochMs: 1});
    assert.equal(lines.length, 1);
    assert.ok(lines[0].startsWith("[ABMARK] {"));
    assert.deepEqual(JSON.parse(lines[0].slice("[ABMARK] ".length)), {mark: "dataReceived", frame: "top", perfNow: 250.5, epochMs: 1250.5, variant: null, rows: 12});
    assert.equal(marks[0][0], "dataReceived");
});

test("setVariant exposes window.__abVariant and every later line carries it", () => {
    const {api, window, lines} = load({top: false});
    api.setVariant("candidate");
    api.mark("appStart");
    assert.equal(window.__abVariant, "candidate");
    const parsed = lines.map(l => JSON.parse(l.slice(9)));
    assert.deepEqual(parsed.map(p => [p.mark, p.variant, p.frame]), [["variantSet", "candidate", "iframe"], ["appStart", "candidate", "iframe"]]);
});

test("the prefix and frame name are configurable", () => {
    const pre = load({prefix: "[PERF]"});
    pre.api.mark("x");
    assert.ok(pre.lines[0].startsWith("[PERF] "));
    pre.api.configure({prefix: "[P2]", frame: "sidebar"});
    pre.api.mark("y");
    assert.ok(pre.lines[1].startsWith("[P2] "));
    assert.equal(JSON.parse(pre.lines[1].slice(5)).frame, "sidebar");
});

test("the snippet is a classic script (no module syntax) and never throws", () => {
    assert.doesNotThrow(() => new vm.Script(SRC));
    const {api} = load();
    const circular = {}; circular.self = circular;
    assert.equal(api.mark("bad", circular), null);
});
