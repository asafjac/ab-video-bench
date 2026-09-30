import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {checkVariant, readRuns} from "../src/ab.mjs";
import {makeStrategy} from "../src/variants.mjs";
import {runSet} from "../src/runner.mjs";
import {tmpDir, mockConfig} from "./helpers.mjs";

test("checkVariant accepts only the expected value and flags a page that reports nothing", () => {
    assert.equal(checkVariant({variantReport: {globals: ["candidate"], marks: ["candidate"]}}, "candidate").ok, true);
    const bad = checkVariant({variantReport: {globals: ["candidate"], marks: ["baseline"]}}, "candidate");
    assert.equal(bad.ok, false); assert.equal(bad.missing, undefined); assert.match(bad.reason, /baseline/);
    assert.equal(checkVariant({}, "a").missing, true);
    assert.equal(checkVariant({variantReport: {globals: [], marks: [null]}}, "a").missing, true);
    assert.equal(checkVariant({variantReport: {globals: [], marks: ["a"]}}, "a").ok, true);
});

test("strategies: cookie, query, localStorage, header, url", () => {
    const base = "https://example.test/page?x=1";
    const cookie = makeStrategy({type: "cookie", name: "v", values: {a: "0", b: "1"}, urls: [base, "http://other.test/"]}, base);
    assert.deepEqual(cookie.cookies("b").map(c => [c.url, c.value, c.secure]), [["https://example.test/", "1", true], ["http://other.test/", "1", false]]);
    assert.equal(cookie.expected("b"), "1");
    const query = makeStrategy({type: "query", param: "exp", values: {a: "off", b: "on"}}, base);
    assert.equal(query.url(base, "b"), "https://example.test/page?x=1&exp=on");
    const ls = makeStrategy({type: "localStorage", key: "exp", values: {a: "off", b: "on"}}, base);
    assert.match(ls.initScript("a"), /localStorage\.setItem\("exp", "off"\)/);
    assert.match(ls.initScript("a"), /"https:\/\/example\.test"/);
    const header = makeStrategy({type: "header", name: "X-Exp", values: {a: "off", b: "on"}}, base);
    assert.deepEqual(header.header("b"), {name: "X-Exp", value: "on", urlPattern: "*"});
    assert.equal(header.cookies("b").length, 0);
    const url = makeStrategy({type: "url", urls: {a: "https://a.test/", b: "https://b.test/"}}, base);
    assert.equal(url.url(base, "b"), "https://b.test/");
    assert.equal(url.expected("b"), "b");
    assert.equal(makeStrategy({type: "url", urls: {a: "https://a.test/", b: "https://b.test/"}, expect: {a: "old", b: "new"}}, base).expected("a"), "old");
    assert.throws(() => makeStrategy({type: "cookie", values: {a: 1, b: 2}}, base), /needs a name/);
    assert.throws(() => makeStrategy({type: "nope"}, base), /variant.type/);
});

test("a mismatched variant excludes that run; the set continues", async () => {
    const root = tmpDir("mismatch");
    const res = await runSet({config: mockConfig(), root, cold: 2, hot: 0, mock: true, videos: false, quiet: true, mockOptions: {mismatch: "list/cold/b/run-2"}});
    assert.equal(res.state, "done");
    assert.deepEqual(res.rejected.map(r => `${r.variant}/${r.label}`), ["b/run-2"]);
    assert.equal(res.rows[0].visible.b.n, 1);
    assert.equal(res.rows[0].visible.a.n, 2);
    assert.equal(readRuns(root, "b", "cold", "list").find(r => r._run === "run-2").ab.variantOk, false);
    fs.rmSync(root, {recursive: true, force: true});
});

test("a missing variant marker aborts the set", async () => {
    const root = tmpDir("missing");
    const res = await runSet({config: mockConfig(), root, cold: 3, hot: 0, mock: true, videos: false, quiet: true, mockOptions: {missing: "list/cold/a/run-1"}});
    assert.equal(res.state, "aborted");
    assert.match(res.abortReason, /reported no variant/);
    assert.equal(fs.existsSync(path.join(root, "b", "cold", "list", "run-1.summary.json")), false);
    fs.rmSync(root, {recursive: true, force: true});
});

test("a STOP file stops the set after the current run", async () => {
    const root = tmpDir("stop");
    let n = 0;
    const res = await runSet({config: mockConfig(), root, cold: 3, hot: 0, mock: true, videos: false, quiet: true,
        log: (line) => { if (/^ {2}list cold/.test(line) && ++n === 2) fs.writeFileSync(path.join(root, "STOP"), ""); }});
    assert.equal(res.state, "stopped");
    assert.equal(n, 2);
    fs.rmSync(root, {recursive: true, force: true});
});
