// Demo site: a dashboard whose variant (cookie ab_variant = baseline | candidate) loads its data sequentially or in parallel.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SNIPPET = fs.readFileSync(path.join(HERE, "..", "browser", "abmark.js"), "utf8");
const APP = fs.readFileSync(path.join(HERE, "site", "app.js"), "utf8");
const FRAME = fs.readFileSync(path.join(HERE, "site", "frame.js"), "utf8");
const STYLE = fs.readFileSync(path.join(HERE, "site", "style.css"), "utf8");
// Padding that makes app.js a ~200 KB download, so cold (no HTTP cache) and hot differ visibly.
const PADDING = `\n/*${"0123456789abcdef".repeat(12800)}*/\n`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// The variant arrives as a request header, a ?variant= parameter or the ab_variant cookie (resolved here), or in localStorage (resolved in the page).
const page = ({title, body, frameSrc, variant, syncOnLoad}) => `<!doctype html>
<html lang="en" data-variant="${variant || ""}"><head><meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="/style.css">
<script src="/abmark.js"></script>
<script>
  (function () {
    var v = document.documentElement.getAttribute("data-variant");
    if (!v) { try { v = localStorage.getItem("ab_variant"); } catch (e) { v = null; } }
    if (v) ABMark.setVariant(v);
  })();${syncOnLoad ? `
  ABMark.sync();` : ""}
</script>
</head><body>
<header><h1>${title}</h1><span id="variant"></span></header>
${body}
${frameSrc ? `<aside><iframe id="side" title="status" src="${frameSrc}"></iframe></aside>` : ""}
<script src="/app.js" defer></script>
</body></html>`;

const FRAME_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><script src="/abmark.js"></script></head>
<body class="frame"><div id="badge" class="badge">status: loading</div><script src="/frame.js" defer></script></body></html>`;

/** Starts the demo on 127.0.0.1 (and ::1 when available) with an OOPIF served from the other loopback name. */
export async function startDemoServer({port = 0, apiDelayMs = 350, bundleDelayMs = 250, jitterMs = 40} = {}) {
    const handler = async (req, res) => {
        const url = new URL(req.url, "http://x");
        const host = req.headers.host || "";
        const otherHost = host.startsWith("localhost") ? host.replace("localhost", "127.0.0.1") : host.replace(/^[^:]+/, "localhost");
        const send = (status, type, body, cache = "no-store") => { res.writeHead(status, {"Content-Type": type, "Cache-Control": cache}); res.end(body); };
        const jitter = () => Math.round(Math.random() * jitterMs);
        const cookie = (/(?:^|;\s*)ab_variant=([^;]+)/.exec(req.headers.cookie || "") || [])[1];
        const raw = req.headers["x-ab-variant"] || url.searchParams.get("variant") || (cookie && decodeURIComponent(cookie)) || "";
        const variant = /^[\w-]{1,40}$/.test(raw) ? raw : "";
        // A cross-site iframe cannot read the top page's cookie, so the variant travels in its URL.
        const frameSrc = `http://${otherHost}/frame${variant ? `?variant=${variant}` : ""}`;
        switch (url.pathname) {
            case "/":
                return send(200, "text/html; charset=utf-8", page({title: "Demo dashboard", frameSrc, variant, syncOnLoad: true,
                    body: `<main id="grid" class="grid" data-autoload="1"></main>`}));
            case "/panel":
                return send(200, "text/html; charset=utf-8", page({title: "Demo reports", variant,
                    body: `<button id="open" type="button">Open report</button><main id="panel" class="grid"></main>`}));
            case "/frame":
                return send(200, "text/html; charset=utf-8", FRAME_PAGE);
            case "/abmark.js":
                return send(200, "text/javascript", SNIPPET, "max-age=600");
            case "/style.css":
                return send(200, "text/css", STYLE, "max-age=600");
            case "/app.js":
                await sleep(bundleDelayMs);
                return send(200, "text/javascript", APP + PADDING, "max-age=600");
            case "/frame.js":
                return send(200, "text/javascript", FRAME, "max-age=600");
            case "/api/config":
                await sleep(apiDelayMs + jitter());
                return send(200, "application/json", JSON.stringify({columns: 4, accent: "#4fc3f7"}));
            case "/api/items":
                await sleep(apiDelayMs + jitter());
                return send(200, "application/json", JSON.stringify(Array.from({length: 12}, (_, i) => ({id: i + 1, name: `Metric ${i + 1}`, value: (i * 37) % 100}))));
            case "/api/status":
                await sleep(Math.round(apiDelayMs / 2) + jitter());
                return send(200, "application/json", JSON.stringify({status: "ok"}));
            default:
                return send(404, "text/plain", "not found");
        }
    };
    const listen = (server, p, host) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(p, host, () => resolve(server)); });
    const v4 = await listen(http.createServer(handler), port, "127.0.0.1");
    const actual = v4.address().port;
    let v6 = null;
    try { v6 = await listen(http.createServer(handler), actual, "::1"); } catch { v6 = null; }
    const close = () => Promise.all([v4, v6].filter(Boolean).map(s => new Promise(r => { s.closeAllConnections?.(); s.close(() => r()); })));
    return {port: actual, baseUrl: `http://127.0.0.1:${actual}`, frameBaseUrl: `http://localhost:${actual}`, close};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const s = await startDemoServer({port: Number(process.argv[2] || 8765)});
    console.log(`demo site: ${s.baseUrl}/ (navigation) and ${s.baseUrl}/panel (click); Ctrl+C to stop`);
}
