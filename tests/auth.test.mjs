import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {fetchEnableParams, urlPatternMatches, challengeFromResponse, challengeFromFetch, authReason, authMode} from "../src/auth.mjs";
import {abVerdict, readRuns} from "../src/ab.mjs";
import {Recorder} from "../src/recorder.mjs";
import {runSet} from "../src/runner.mjs";
import {tmpDir, mockConfig} from "./helpers.mjs";

const item = {variant: "a", phase: "cold", measured: true};
const good = {variantReport: {globals: ["baseline"], marks: ["baseline"]}, sync: {ok: true}};

test("Fetch is enabled only when needed: documents with handleAuthRequests in cancel mode, the header variant's pattern as before", () => {
    assert.equal(fetchEnableParams({header: null, mode: "ignore"}), null);
    assert.deepEqual(fetchEnableParams({header: null, mode: "cancel"}),
        {patterns: [{urlPattern: "*", resourceType: "Document", requestStage: "Request"}], handleAuthRequests: true});
    assert.deepEqual(fetchEnableParams({header: {urlPattern: "https://api.example.test/*"}, mode: "ignore"}),
        {patterns: [{urlPattern: "https://api.example.test/*", requestStage: "Request"}]});
    const both = fetchEnableParams({header: {urlPattern: "https://api.example.test/*"}, mode: "cancel"});
    assert.equal(both.patterns.length, 2);
    assert.equal(both.handleAuthRequests, true);
    assert.throws(() => authMode("prompt"), /cancel or ignore/);
    assert.equal(authMode(), "cancel");
});

test("URL patterns follow the CDP wildcard rules", () => {
    assert.ok(urlPatternMatches("*", "https://example.test/a"));
    assert.ok(urlPatternMatches("https://api.example.test/*", "https://api.example.test/v1/items?x=1"));
    assert.ok(!urlPatternMatches("https://api.example.test/*", "https://example.test/v1"));
    assert.ok(urlPatternMatches("https://example.test/page?.html", "https://example.test/page1.html"));
    assert.ok(urlPatternMatches("https://example.test/a\\*b", "https://example.test/a*b"));
    assert.ok(!urlPatternMatches("https://example.test/a\\*b", "https://example.test/axxb"));
});

test("challenges are read from Fetch.authRequired and from 401/407 responses with an authenticate header", () => {
    const f = challengeFromFetch({request: {url: "https://staging.example.test/app/"}, authChallenge: {origin: "https://staging.example.test", scheme: "basic", realm: "staging", source: "Server"}}, "iframe");
    assert.deepEqual({origin: f.origin, scheme: f.scheme, realm: f.realm, frame: f.frame, handled: f.handled},
        {origin: "https://staging.example.test", scheme: "basic", realm: "staging", frame: "iframe", handled: "cancelled"});
    const r = challengeFromResponse({response: {status: 401, url: "https://staging.example.test/", headers: {"WWW-Authenticate": "Basic realm=\"staging\""}}}, "top");
    assert.deepEqual({origin: r.origin, scheme: r.scheme, realm: r.realm, handled: r.handled}, {origin: "https://staging.example.test", scheme: "Basic", realm: "staging", handled: "none"});
    assert.equal(challengeFromResponse({response: {status: 401, url: "https://example.test/api", headers: {}}}, "top"), null);
    assert.equal(challengeFromResponse({response: {status: 200, url: "https://example.test/", headers: {"www-authenticate": "Basic"}}}, "top"), null);
    assert.match(authReason([f, {...f}]), /^HTTP auth challenge from https:\/\/staging\.example\.test \(basic\): sign in to the browser profile first$/);
});

test("a run that met a challenge is rejected with that reason, and a page that reported nothing does not abort the set", () => {
    const ok = abVerdict(good, item, "baseline");
    assert.equal(ok.ab.valid, true); assert.equal(ok.ab.authOk, true);
    const hit = abVerdict({...good, authChallenges: [{origin: "https://staging.example.test", scheme: "basic"}]}, item, "baseline");
    assert.equal(hit.ab.valid, false); assert.equal(hit.ab.authOk, false);
    assert.match(hit.ab.reason, /HTTP auth challenge from https:\/\/staging\.example\.test/);
    const silent = abVerdict({variantReport: {globals: [], marks: []}, sync: {ok: false, reason: "no sync line"}, authChallenges: [{origin: "https://staging.example.test", scheme: "basic"}]}, item, "baseline");
    assert.equal(silent.v.missing, undefined);
    assert.match(silent.ab.reason, /^HTTP auth challenge/);
});

test("the recorder cancels a challenge, records it, and lets a paused document through unchanged", () => {
    const rec = new Recorder({log: () => {}});
    const sent = [];
    rec.send = (method, params, sid) => { sent.push({method, params, sid}); return Promise.resolve({}); };
    rec.sessions.set("S1", {type: "page", parent: null});
    rec.sessions.set("S2", {type: "iframe", parent: "S1"});
    rec.run = {P: "S1", targetId: "F1", header: {name: "X-Variant", value: "b", urlPattern: "https://api.example.test/*"}, authMode: "cancel", authChallenges: [], marks: [], console: [], contexts: new Map()};
    rec.onEvent({method: "Fetch.requestPaused", sessionId: "S1", params: {requestId: "r1", request: {url: "https://example.test/", headers: {}}}});
    rec.onEvent({method: "Fetch.requestPaused", sessionId: "S2", params: {requestId: "r2", request: {url: "https://api.example.test/items", headers: {Accept: "*/*"}}}});
    rec.onEvent({method: "Fetch.authRequired", sessionId: "S2", params: {requestId: "r3", frameId: "F2", request: {url: "https://staging.example.test/frame"},
        authChallenge: {origin: "https://staging.example.test", scheme: "basic", realm: "staging"}}});
    assert.deepEqual(sent[0], {method: "Fetch.continueRequest", params: {requestId: "r1"}, sid: "S1"});
    assert.deepEqual(sent[1].params.headers, [{name: "Accept", value: "*/*"}, {name: "X-Variant", value: "b"}]);
    assert.deepEqual(sent[2], {method: "Fetch.continueWithAuth", params: {requestId: "r3", authChallengeResponse: {response: "CancelAuth"}}, sid: "S2"});
    assert.equal(rec.run.authChallenges.length, 1);
    assert.equal(rec.run.authChallenges[0].frame, "iframe");
});

test("in ignore mode the recorder only records 401 challenges it sees in responses", () => {
    const rec = new Recorder({log: () => {}, authChallenges: "ignore"});
    rec.send = () => Promise.resolve({});
    rec.sessions.set("S1", {type: "page", parent: null});
    rec.run = {P: "S1", header: null, authMode: "ignore", authChallenges: [], marks: [], console: [], contexts: new Map()};
    rec.onEvent({method: "Network.responseReceived", sessionId: "S1", params: {response: {status: 401, url: "https://staging.example.test/", headers: {"www-authenticate": "Basic realm=\"x\""}}}});
    rec.onEvent({method: "Network.responseReceived", sessionId: "S1", params: {response: {status: 200, url: "https://staging.example.test/app.js", headers: {}}}});
    assert.equal(rec.run.authChallenges.length, 1);
    assert.equal(rec.run.authChallenges[0].handled, "none");
});

test("a cancelled challenge rejects that run and the set goes on", async () => {
    const root = tmpDir("auth-cancel");
    const res = await runSet({config: mockConfig(), root, cold: 2, hot: 0, mock: true, videos: false, quiet: true,
        mockOptions: {authChallenge: {key: "list/cold/a/run-1", handled: "cancelled"}}});
    assert.equal(res.state, "done");
    assert.deepEqual(res.rejected.map(r => `${r.variant}/${r.label}`), ["a/run-1"]);
    assert.match(res.rejected[0].reason, /HTTP auth challenge from http:\/\/127\.0\.0\.1:1/);
    assert.equal(readRuns(root, "a", "cold", "list").find(r => r._run === "run-1").ab.authOk, false);
    fs.rmSync(root, {recursive: true, force: true});
});

test("a challenge left to the browser stops the set before the next cold run clears anything", async () => {
    const root = tmpDir("auth-pending");
    const res = await runSet({config: mockConfig(), root, cold: 3, hot: 0, mock: true, videos: false, quiet: true, authChallenges: "ignore",
        mockOptions: {authChallenge: {key: "list/cold/a/run-1", handled: "none"}}});
    assert.equal(res.state, "aborted");
    assert.match(res.abortReason, /list cold B run-1 not run: an HTTP auth dialog may be open/);
    assert.equal(fs.existsSync(`${root}/b/cold/list/run-1.summary.json`), false);
    fs.rmSync(root, {recursive: true, force: true});
});

test("an unknown --auth-challenges mode fails before anything runs", async () => {
    await assert.rejects(runSet({config: mockConfig(), root: tmpDir("auth-bad"), cold: 1, hot: 0, mock: true, videos: false, quiet: true, authChallenges: "prompt"}), /cancel or ignore/);
});
