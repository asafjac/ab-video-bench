import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import {fileURLToPath} from "node:url";

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "browser", "abmark.js"), "utf8");

function load({top = true, prefix} = {}) {
    const lines = [], marks = [], appended = [], listeners = [], rafs = [], timers = [];
    let now = 250.5;
    const window = {ABMARK_PREFIX: prefix, innerWidth: 900, innerHeight: 640};
    window.top = top ? window : {};
    const document = {
        createElement: () => { const el = {attrs: {}, style: {}, setAttribute(k, v) { this.attrs[k] = v; }, parentNode: null}; return el; },
        documentElement: {appendChild(el) { el.parentNode = this; appended.push(el); }, removeChild(el) { el.parentNode = null; }},
        addEventListener: (type, fn, capture) => listeners.push({type, fn, capture}),
    };
    const ctx = {window, document, console: {info: (s) => lines.push(s)}, requestAnimationFrame: (fn) => rafs.push(fn), setTimeout: (fn) => timers.push(fn),
        performance: {timeOrigin: 1000, now: () => now, mark: (n, o) => marks.push([n, o])}};
    vm.runInNewContext(SRC, ctx);
    const parsed = () => lines.map(l => JSON.parse(l.slice(l.indexOf(" ") + 1)));
    const tick = (ms) => { now += ms; const fns = rafs.splice(0); fns.forEach(f => f(now)); const ts = timers.splice(0); ts.forEach(f => f()); };
    return {api: window.ABMark, window, lines, marks, appended, listeners, parsed, tick};
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
    const {api, window, parsed} = load({top: false});
    api.setVariant("candidate");
    api.mark("appStart");
    assert.equal(window.__abVariant, "candidate");
    assert.deepEqual(parsed().map(p => [p.mark, p.variant, p.frame]), [["variantSet", "candidate", "iframe"], ["appStart", "candidate", "iframe"]]);
});

test("sync logs the sync line, draws the corner marker, then logs syncFrame and syncEnd and removes it", () => {
    const {api, appended, parsed, tick} = load();
    api.configure({syncMarker: {size: 10, corner: "bottom-right", ms: 120}});
    api.sync();
    const [line] = parsed();
    assert.equal(line.mark, "sync");
    assert.equal(line.epochMs, 1250.5);
    assert.deepEqual(line.marker, {x: 890, y: 630, size: 10, color: "#ff00ff", ms: 120, vw: 900, vh: 640});
    assert.equal(line.syncTop, true);
    assert.equal(appended.length, 1);
    assert.match(appended[0].style.cssText, /left:890px;top:630px;width:10px;height:10px;background:#ff00ff/);
    assert.ok("data-ab-sync-marker" in appended[0].attrs);
    tick(16);
    assert.equal(parsed()[1].mark, "syncFrame");
    tick(120); tick(16);
    assert.deepEqual(parsed().map(p => p.mark), ["sync", "syncFrame", "syncEnd"]);
    assert.equal(appended[0].parentNode, null);
});

test("syncOnPress fires sync once, at the pointerdown's own timestamp, only inside the selector", () => {
    const {api, listeners, parsed} = load();
    api.syncOnPress("#go");
    assert.deepEqual(listeners.map(l => [l.type, l.capture]), [["pointerdown", true]]);
    const hit = {closest: (s) => (s === "#go" ? {} : null)}, miss = {closest: () => null};
    listeners[0].fn({target: miss, timeStamp: 100});
    listeners[0].fn({target: hit, timeStamp: 200});
    listeners[0].fn({target: hit, timeStamp: 300});
    const syncs = parsed().filter(p => p.mark === "sync");
    assert.equal(syncs.length, 1);
    assert.equal(syncs[0].epochMs, 1200);
    assert.equal(syncs[0].selector, "#go");
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
