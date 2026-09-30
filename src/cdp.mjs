import {connectWebSocket} from "./ws.mjs";

export class Cdp {
    constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.handlers = new Set(); this.closed = false; }

    async open() {
        this.ws = await connectWebSocket(this.url);
        this.ws.onmessage = (text) => {
            const m = JSON.parse(text);
            if (m.id !== undefined && this.pending.has(m.id)) {
                const p = this.pending.get(m.id); this.pending.delete(m.id);
                if (m.error) p.rej(new Error(`${p.method}: ${m.error.message}`)); else p.res(m.result);
            } else if (m.method) for (const h of [...this.handlers]) { try { h(m); } catch (e) { console.error("CDP event handler failed:", e); } }
        };
        this.ws.onclose = () => {
            this.closed = true;
            for (const p of this.pending.values()) p.rej(new Error(`${p.method}: CDP socket closed`));
            this.pending.clear();
        };
    }

    send(method, params = {}, sessionId, timeoutMs = 60000) {
        if (this.closed) return Promise.reject(new Error(`${method}: CDP socket closed`));
        const id = ++this.id;
        return new Promise((res, rej) => {
            const timer = timeoutMs ? setTimeout(() => { if (this.pending.delete(id)) rej(new Error(`${method}: no reply within ${timeoutMs} ms`)); }, timeoutMs) : null;
            this.pending.set(id, {method, res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); }});
            this.ws.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
        });
    }

    on(h) { this.handlers.add(h); return () => this.handlers.delete(h); }

    waitFor(pred, timeoutMs) {
        return new Promise((res, rej) => {
            const off = this.on((m) => { if (pred(m)) { off(); clearTimeout(t); res(m); } });
            const t = setTimeout(() => { off(); rej(new Error("timed out waiting for a CDP event")); }, timeoutMs);
        });
    }

    close() { try { this.ws.close(); } catch { /* already closed */ } }
}

/** The browser-level websocket URL of a Chrome listening for DevTools on host:port. */
export async function browserWsUrl(port, host = "127.0.0.1") {
    const res = await fetch(`http://${host}:${port}/json/version`);
    if (!res.ok) throw new Error(`http://${host}:${port}/json/version answered HTTP ${res.status}`);
    const v = await res.json();
    return {wsUrl: v.webSocketDebuggerUrl, browser: v.Browser};
}
