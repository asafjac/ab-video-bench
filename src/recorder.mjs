import fs from "node:fs";
import path from "node:path";
import {Cdp} from "./cdp.mjs";
import {syncFlashJs, measureSync} from "./sync.mjs";
import {buildRunTimeline} from "./timeline.mjs";

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export class FatalRunError extends Error {}

// Injected into every document of the measured tab (all frames, before any page script).
function pageAgent(CFG, visible) {
    try {
        if (window.__abAgent) return;
        const isTop = window.top === window;
        const agent = window.__abAgent = {visibleAt: null, armed: false, clicked: false};
        const now = () => performance.timeOrigin + performance.now();
        const emit = (mark, epochMs, extra) => {
            try {
                console.info(CFG.prefix + " " + JSON.stringify(Object.assign({mark, frame: isTop ? "top" : "iframe", perfNow: epochMs - performance.timeOrigin, epochMs,
                    variant: window.__abVariant ?? null, source: "recorder"}, extra || {})));
            } catch (e) { /* never break the page */ }
        };
        const web = /^https?:$/.test(location.protocol);
        const watchHere = web && (CFG.visibleFrame ? location.href.includes(CFG.visibleFrame) : isTop);
        const arm = () => {
            if (agent.armed) return;
            agent.armed = true;
            const check = () => {
                if (agent.visibleAt !== null) return;
                let ok = false;
                try { ok = !!visible(); } catch (e) { ok = false; }
                if (ok) { agent.visibleAt = now(); emit("visible", agent.visibleAt, {url: location.href}); } else requestAnimationFrame(check);
            };
            requestAnimationFrame(check);
        };
        if (isTop && web) {
            if (CFG.start === "navigate") emit("navigationStart", performance.timeOrigin, {url: location.href});
            document.addEventListener("visibilitychange", () => { if (document.visibilityState !== "visible") emit("hidden", now()); });
        }
        if (isTop && CFG.start === "click") {
            document.addEventListener("click", (ev) => {
                const t = ev.target;
                if (agent.clicked || !t || !t.closest || !t.closest(CFG.selector)) return;
                agent.clicked = true;
                emit("startAction", performance.timeOrigin + ev.timeStamp, {selector: CFG.selector});
                if (watchHere) arm();
            }, true);
        } else if (watchHere) arm();
    } catch (e) { /* never break the page */ }
}

const agentScript = (scenario, prefix) => `(${pageAgent.toString()})(${JSON.stringify({prefix, start: scenario.start.type, selector: scenario.start.selector || null,
    visibleFrame: scenario.visibleFrame})}, ${scenario.visibleSource});`;

const cropJs = (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect();
    return {x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio}; })()`;

/** CDP recorder: a fresh tab per run, OOPIFs auto-attached, mark lines from every frame, timestamped screencast frames. */
export class Recorder {
    constructor(opts = {}) {
        Object.assign(this, {prefix: "[ABMARK]", ffmpeg: "ffmpeg", settleMs: 1000, timeoutMs: 30000, preRollMs: 800, syncFlash: true,
            viewport: {width: 1280, height: 800}, log: console.log}, opts);
        this.sessions = new Map();
        this.run = null;
        this.netInternals = null;
    }

    async connect(wsUrl) {
        this.cdp = new Cdp(wsUrl);
        await this.cdp.open();
        this.cdp.on((m) => this.onEvent(m));
        this.browserVersion = (await this.send("Browser.getVersion")).product;
    }

    async close({closeBrowser = false} = {}) {
        if (this.netInternals) await this.send("Target.closeTarget", {targetId: this.netInternals.targetId}, undefined, 10000).catch(() => {});
        this.netInternals = null;
        if (closeBrowser) await this.send("Browser.close", {}, undefined, 5000).catch(() => {});
        this.cdp.close();
    }

    send(method, params, sid, timeoutMs) { return this.cdp.send(method, params, sid, timeoutMs); }

    rootOf(sid) { let s = sid; for (let i = 0; i < 20; i++) { const info = this.sessions.get(s); if (!info || !info.parent) return s; s = info.parent; } return s; }

    onEvent(m) {
        if (m.method === "Target.attachedToTarget") {
            const {sessionId, targetInfo, waitingForDebugger} = m.params;
            this.sessions.set(sessionId, {type: targetInfo.type, url: targetInfo.url, parent: m.sessionId || null});
            if (this.run && m.sessionId && this.rootOf(sessionId) === this.run.P) this.setupChild(sessionId, targetInfo).catch(() => {});
            else if (m.sessionId && waitingForDebugger) this.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
            return;
        }
        if (m.method === "Target.detachedFromTarget") { this.sessions.delete(m.params.sessionId); return; }
        const run = this.run;
        if (!run || !m.sessionId || this.rootOf(m.sessionId) !== run.P) return;
        const p = m.params || {};
        if (m.method === "Fetch.requestPaused") {
            const headers = Object.entries(p.request.headers || {}).filter(([k]) => k.toLowerCase() !== run.header.name.toLowerCase()).map(([name, value]) => ({name, value}));
            headers.push({name: run.header.name, value: run.header.value});
            this.send("Fetch.continueRequest", {requestId: p.requestId, headers}, m.sessionId).catch(() => {});
            return;
        }
        if (m.method === "Runtime.consoleAPICalled" && run.recording) {
            const first = (p.args || [])[0];
            if (first && typeof first.value === "string" && first.value.startsWith(run.linePrefix)) {
                try { run.marks.push({...JSON.parse(first.value.slice(run.linePrefix.length)), consoleTs: p.timestamp}); } catch { /* not JSON */ }
            } else if (run.console.length < 200) run.console.push({type: p.type, text: (p.args || []).map(a => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(" ").slice(0, 300)});
            return;
        }
        if (m.method === "Runtime.exceptionThrown" && run.recording) {
            const d = p.exceptionDetails || {};
            if (run.console.length < 200) run.console.push({type: "exception", text: `${d.text || ""} ${(d.exception && d.exception.description) || ""}`.slice(0, 500)});
            return;
        }
        if (m.method === "Runtime.executionContextCreated") { const c = p.context; if (c.auxData && c.auxData.isDefault) run.contexts.set(`${m.sessionId}|${c.id}`, {sid: m.sessionId, id: c.id, origin: c.origin}); return; }
        if (m.method === "Runtime.executionContextDestroyed") { run.contexts.delete(`${m.sessionId}|${p.executionContextId}`); return; }
        if (m.method === "Runtime.executionContextsCleared") { for (const k of [...run.contexts.keys()]) if (k.startsWith(`${m.sessionId}|`)) run.contexts.delete(k); return; }
        if (m.method === "Page.screencastFrame" && m.sessionId === run.P) {
            this.send("Page.screencastFrameAck", {sessionId: p.sessionId}, run.P).catch(() => {});
            const sc = run.screencast;
            if (sc) {
                const file = path.join(sc.dir, `f${String(sc.frames.length).padStart(5, "0")}.jpg`);
                fs.writeFileSync(file, Buffer.from(p.data, "base64"));
                sc.frames.push({ts: p.metadata.timestamp * 1000, file});
            }
        }
    }

    async setupChild(sid, info) {
        const run = this.run;
        await this.send("Network.enable", {}, sid).catch(() => {});
        await this.send("Network.setCacheDisabled", {cacheDisabled: run.cacheDisabled}, sid).catch(() => {});
        if (run.header) await this.send("Fetch.enable", {patterns: [{urlPattern: run.header.urlPattern, requestStage: "Request"}]}, sid).catch(() => {});
        if (info.type === "iframe") {
            await this.send("Page.enable", {}, sid).catch(() => {});
            await this.send("Runtime.enable", {}, sid).catch(() => {});
            await this.send("Page.addScriptToEvaluateOnNewDocument", {source: run.initScript}, sid).catch(() => {});
        }
        await this.send("Target.setAutoAttach", {autoAttach: true, waitForDebuggerOnStart: true, flatten: true}, sid).catch(() => {});
        await this.send("Runtime.runIfWaitingForDebugger", {}, sid).catch(() => {});
    }

    async openTab() {
        const {targetId} = await this.send("Target.createTarget", {url: "about:blank"});
        const {sessionId} = await this.send("Target.attachToTarget", {targetId, flatten: true});
        this.sessions.set(sessionId, {type: "page", url: "about:blank", parent: null});
        return {targetId, P: sessionId};
    }

    async evalTop(sid, expr, timeoutMs = 15000) {
        const r = await this.send("Runtime.evaluate", {expression: expr, returnByValue: true, awaitPromise: true}, sid, timeoutMs);
        if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.text} ${(r.exceptionDetails.exception && r.exceptionDetails.exception.description) || ""}`);
        return r.result.value;
    }

    async evalCtx(sid, contextId, expr, awaitPromise = false) {
        const r = await this.send("Runtime.evaluate", {expression: expr, contextId, returnByValue: true, awaitPromise}, sid, 10000);
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
        return r.result.value;
    }

    async navigate(P, url, {readySelector, timeoutMs = 30000} = {}) {
        const loaded = this.cdp.waitFor(m => m.sessionId === P && m.method === "Page.loadEventFired", timeoutMs).catch(() => null);
        const r = await this.send("Page.navigate", {url}, P, timeoutMs);
        if (r.errorText) throw new FatalRunError(`navigation to ${url} failed: ${r.errorText}`);
        await loaded;
        if (!readySelector) return;
        const until = Date.now() + timeoutMs;
        while (Date.now() < until) {
            if (await this.evalTop(P, `!!document.querySelector(${JSON.stringify(readySelector)})`).catch(() => false)) return;
            await sleep(100);
        }
        throw new FatalRunError(`${readySelector} did not appear on ${url} within ${timeoutMs / 1000} s`);
    }

    async navigateBlank(P) {
        const loaded = this.cdp.waitFor(m => m.sessionId === P && m.method === "Page.loadEventFired", 10000).catch(() => null);
        await this.send("Page.navigate", {url: "about:blank"}, P, 10000);
        await loaded;
    }

    // A hidden or covered tab is render-throttled: wait for it to be visible, up to 10 minutes.
    async ensureVisible(P) {
        await this.send("Page.bringToFront", {}, P).catch(() => {});
        let vis = await this.evalTop(P, "document.visibilityState").catch(() => "?");
        if (vis === "visible") return;
        this.log(`  (the measured tab is ${vis}: waiting up to 10 min for the Chrome window to be visible)`);
        const until = Date.now() + 10 * 60 * 1000;
        while (Date.now() < until) {
            await sleep(2000);
            await this.send("Page.bringToFront", {}, P).catch(() => {});
            vis = await this.evalTop(P, "document.visibilityState").catch(() => "?");
            if (vis === "visible") { await sleep(1000); return; }
        }
        throw new FatalRunError("the measured tab stayed hidden for 10 minutes");
    }

    // A real input click at the center of the first on-screen, hit-testable match.
    async clickSelector(P, sel) {
        const r = await this.evalTop(P, `(() => { const els = [...document.querySelectorAll(${JSON.stringify(sel)})];
            const ok = (e) => { const r = e.getBoundingClientRect(); if (r.width < 2 || r.height < 2 || r.x < 0 || r.y < 0 || r.x + r.width / 2 > innerWidth || r.y + r.height / 2 > innerHeight) return false;
                const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!hit && (hit === e || e.contains(hit)); };
            let el = els.find(ok); if (!el && els[0]) { els[0].scrollIntoView({block: "center"}); el = els.find(ok); }
            if (!el) return null; const r = el.getBoundingClientRect();
            return {x: r.x + r.width / 2, y: r.y + r.height / 2, what: el.tagName + (el.id ? "#" + el.id : "")}; })()`);
        if (!r) return null;
        for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await this.send("Input.dispatchMouseEvent", {type, x: r.x, y: r.y, button: "left", clickCount: 1}, P);
        return r.what;
    }

    async netFlush() {
        if (!this.netInternals) {
            const {targetId} = await this.send("Target.createTarget", {url: "chrome://net-internals/#sockets", background: true});
            const {sessionId} = await this.send("Target.attachToTarget", {targetId, flatten: true});
            this.netInternals = {targetId, sessionId};
            await sleep(1500);
        }
        const r = await this.evalTop(this.netInternals.sessionId, `(() => { const d = document.getElementById("dns-view-clear-cache"), s = document.getElementById("sockets-view-flush-button");
            if (d) d.click(); if (s) s.click(); return {hostCache: !!d, socketPools: !!s}; })()`);
        if (!r.hostCache || !r.socketPools) throw new Error(`chrome://net-internals controls missing (clear host cache: ${r.hostCache}, flush socket pools: ${r.socketPools})`);
        return {hostCacheCleared: true, socketPoolsFlushed: true};
    }

    // Stages: before = origin storage, then (cold) HTTP cache + DNS + sockets; pre-t0 = the network part again; after = live frames, then origin storage.
    async clearState({scenario, phase, stage, P, live = false, networkOnly = false}) {
        const log = [];
        const step = async (what, method, fn) => {
            const t = Date.now();
            try { const detail = await fn(); log.push({stage, what, method, ok: true, ms: Date.now() - t, ...(detail !== undefined ? {detail} : {})}); }
            catch (e) { log.push({stage, what, method, ok: false, ms: Date.now() - t, error: e.message}); }
        };
        if (!networkOnly) {
            if (live && this.run) {
                for (const c of [...this.run.contexts.values()].filter(c => scenario.storageOrigins.includes(c.origin)))
                    await step(`localStorage + sessionStorage in a live ${c.origin} frame`, "Runtime.evaluate", () => this.evalCtx(c.sid, c.id, "localStorage.clear(); sessionStorage.clear(); true"));
                await step("page unloaded", "Page.navigate about:blank", () => this.navigateBlank(P));
            }
            for (const origin of scenario.storageOrigins) await step(`service workers, Cache Storage, IndexedDB, localStorage of ${origin}`, "Storage.clearDataForOrigin",
                () => this.send("Storage.clearDataForOrigin", {origin, storageTypes: "service_workers,cache_storage,indexeddb,local_storage"}, P, 30000).then(() => undefined));
            if (scenario.clearCookies) await step("cookies", "Network.getCookies + Network.deleteCookies", async () => {
                const {cookies} = await this.send("Network.getCookies", {urls: scenario.storageOrigins.map(o => o + "/")}, P);
                for (const c of cookies) await this.send("Network.deleteCookies", {name: c.name, domain: c.domain, path: c.path}, P);
                return {deleted: cookies.length};
            });
        }
        if (phase === "hot" || stage === "after") return log;
        await step("HTTP cache", "Network.clearBrowserCache", () => this.send("Network.clearBrowserCache", {}, P, 60000).then(() => undefined));
        await step("DNS host cache + socket pools", "chrome://net-internals", () => this.netFlush());
        return log;
    }

    /** One run in a fresh tab. Writes <label>.summary.json, .timeline.json and, with keepFrames, <label>.frames/. Returns the summary. */
    async runOnce({scenario, variant, phase, label, outDir, keepFrames = true}) {
        const prefix = path.join(outDir, label), framesDir = `${prefix}.frames`;
        const strategy = scenario.strategy;
        const tab = await this.openTab();
        const initScript = [strategy.initScript(variant), agentScript(scenario, this.prefix)].filter(Boolean).join("\n");
        const run = this.run = {P: tab.P, initScript, linePrefix: `${this.prefix} `, cacheDisabled: phase === "cold", header: strategy.header(variant),
            contexts: new Map(), marks: [], console: [], recording: false, screencast: null};
        const clearing = {before: [], preT0: [], after: []};
        const timeoutMs = scenario.timeoutMs || this.timeoutMs;
        const url = strategy.url(scenario.url, variant);
        let frames = [], flash = null, cropRect = null, globals = [], failure = null, startedWall = null, clicked = null, screencastOn = false;
        try {
            const {width, height} = this.viewport;
            await this.send("Emulation.setDeviceMetricsOverride", {width, height, deviceScaleFactor: 1, mobile: false}, run.P);
            await this.send("Network.enable", {}, run.P);
            await this.send("Network.setCacheDisabled", {cacheDisabled: run.cacheDisabled}, run.P);
            if (run.header) await this.send("Fetch.enable", {patterns: [{urlPattern: run.header.urlPattern, requestStage: "Request"}]}, run.P);
            await this.send("Page.enable", {}, run.P);
            await this.send("Runtime.enable", {}, run.P);
            await this.send("Page.addScriptToEvaluateOnNewDocument", {source: initScript}, run.P);
            await this.send("Target.setAutoAttach", {autoAttach: true, waitForDebuggerOnStart: true, flatten: true}, run.P);
            clearing.before = await this.clearState({scenario, phase, stage: "before", P: run.P});
            for (const c of strategy.cookies(variant)) await this.send("Network.setCookie", {...c, expires: Date.now() / 1000 + 600}, run.P);
            if (scenario.start.type === "click") {
                await this.navigate(run.P, url, {readySelector: scenario.start.readySelector || scenario.start.selector, timeoutMs});
                await sleep(scenario.start.settleMs ?? 1000);
                clearing.preT0 = await this.clearState({scenario, phase, stage: "pre-t0", P: run.P, networkOnly: true});
            }
            await this.ensureVisible(run.P);

            run.recording = true;
            fs.rmSync(framesDir, {recursive: true, force: true}); fs.mkdirSync(framesDir, {recursive: true});
            run.screencast = {frames: [], dir: framesDir};
            await this.send("Page.startScreencast", {format: "jpeg", quality: 70, maxWidth: width, maxHeight: height, everyNthFrame: 1}, run.P);
            screencastOn = true;
            if (this.syncFlash) flash = await this.evalTop(run.P, syncFlashJs(this.prefix)).catch(e => ({error: e.message}));
            await sleep(this.preRollMs);
            startedWall = Date.now();
            if (scenario.start.type === "click") {
                clicked = await this.clickSelector(run.P, scenario.start.selector);
                if (!clicked) throw new FatalRunError(`start selector ${scenario.start.selector} not found or not clickable`);
            } else {
                const r = await this.send("Page.navigate", {url}, run.P, 30000);
                if (r.errorText) throw new FatalRunError(`navigation to ${url} failed: ${r.errorText}`);
            }
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                const t0 = findT0(run.marks, scenario);
                if (t0 && run.marks.some(m => m.mark === "visible" && m.source === "recorder" && m.epochMs >= t0.epochMs)) break;
                await sleep(50);
            }
            await sleep(scenario.settleMs ?? this.settleMs);
            for (const c of [...run.contexts.values()]) {
                const v = await this.evalCtx(c.sid, c.id, "window.__abVariant ?? null").catch(() => null);
                if (v != null) globals.push(String(v));
            }
            if (scenario.crop) cropRect = await this.evalTop(run.P, cropJs(scenario.crop)).catch(() => null);
            await this.send("Page.stopScreencast", {}, run.P).catch(() => {}); screencastOn = false;
            frames = run.screencast.frames; run.screencast = null;
            run.recording = false;
            if (run.marks.some(m => m.mark === "hidden" && m.source === "recorder")) throw Object.assign(new Error("the tab went hidden during the run"), {hiddenDuringRun: true});
        } catch (e) { failure = e; }
        finally {
            if (screencastOn) await this.send("Page.stopScreencast", {}, run.P).catch(() => {});
            run.recording = false; run.screencast = null;
            try { clearing.after = await this.clearState({scenario, phase, stage: "after", P: run.P, live: true}); }
            catch (e) { clearing.after.push({stage: "after", ok: false, error: e.message}); }
            for (const c of strategy.cookies(variant)) await this.send("Network.deleteCookies", {name: c.name, url: c.url}, run.P).catch(() => {});
            await this.send("Target.closeTarget", {targetId: tab.targetId}, undefined, 10000).catch(() => {});
            this.run = null;
        }
        if (failure) { fs.rmSync(framesDir, {recursive: true, force: true}); throw failure; }

        const t0m = findT0(run.marks, scenario);
        const t0Epoch = t0m ? t0m.epochMs : startedWall;
        const t0Source = t0m ? (t0m.mark === "startAction" ? "capture-phase click listener on the start selector" : "performance.timeOrigin of the navigated document")
            : "recorder wall clock before the start action (no start mark seen)";
        const vis = run.marks.find(m => m.mark === "visible" && m.source === "recorder" && m.epochMs >= t0Epoch);
        const visibleMs = vis ? Math.round((vis.epochMs - t0Epoch) * 10) / 10 : null;
        const pageVariants = run.marks.filter(m => m.source !== "recorder" && m.variant != null).map(m => String(m.variant));
        const summary = {scenario: scenario.name, label, variant, phase, url, startAction: scenario.start.type === "click" ? {click: scenario.start.selector, target: clicked} : {navigate: url},
            state: visibleMs == null ? "timeout" : "visible", visibleMs, t0Epoch, t0Source, variantReport: {expected: strategy.expected(variant), globals, marks: [...new Set(pageVariants)]},
            cropRect, browser: this.browserVersion, clearing, frames: frames.length};
        if (visibleMs == null) summary.consoleTail = run.console.slice(-30);
        if (this.syncFlash) summary.sync = measureSync(frames, flash, this.ffmpeg);
        fs.writeFileSync(`${prefix}.timeline.json`, JSON.stringify(buildRunTimeline({summary, marks: run.marks}), null, 1));
        if (keepFrames) fs.writeFileSync(path.join(framesDir, "index.json"), JSON.stringify(frames.map(f => ({ts: f.ts, file: path.basename(f.file)}))));
        else fs.rmSync(framesDir, {recursive: true, force: true});
        fs.writeFileSync(`${prefix}.summary.json`, JSON.stringify(summary, null, 2));
        return summary;
    }
}

function findT0(marks, scenario) {
    const name = scenario.start.type === "click" ? "startAction" : "navigationStart";
    return marks.find(m => m.mark === name && m.source === "recorder") || null;
}

/** rec.runOnce, redone (up to 5 attempts) when the tab went hidden mid-run. */
export async function runVisible(rec, args, log) {
    for (let attempt = 1; ; attempt++) {
        try { return await rec.runOnce(args); }
        catch (e) { if (!e.hiddenDuringRun || attempt >= 5) throw e; log(`  (${args.label}: the tab went hidden mid-run; redoing it)`); }
    }
}
