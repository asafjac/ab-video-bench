// HTTP auth challenges (401 / 407 with a WWW-Authenticate / Proxy-Authenticate header, e.g. a Basic-auth protected staging
// site). A challenge nobody answers opens Chrome's sign-in dialog over the run, the run then times out, and a cold run's cache
// clear or socket flush would close a dialog someone is filling in. Mode "cancel" (default) answers every challenge with
// CancelAuth through the Fetch domain, so it fails fast, and rejects the run; mode "ignore" leaves challenges to the browser
// (the behavior before this option) and only records the ones it can see.

export const AUTH_MODES = ["cancel", "ignore"];

/** Validates an --auth-challenges value. */
export function authMode(value = "cancel") {
    if (!AUTH_MODES.includes(value)) throw new Error(`--auth-challenges must be ${AUTH_MODES.join(" or ")}, got "${value}"`);
    return value;
}

/**
 * Fetch.enable parameters for one target, or null when Fetch is not needed. `header` is the header variant's
 * {urlPattern} (its requests are paused to add the header). In cancel mode, documents are paused too, and handleAuthRequests
 * makes Chrome send Fetch.authRequired instead of showing its dialog for any paused request. Only documents are added, so
 * subresources are not paused (and slowed) by this option; the challenge that opens the dialog is the document's.
 */
export function fetchEnableParams({header, mode}) {
    const patterns = [];
    if (header) patterns.push({urlPattern: header.urlPattern || "*", requestStage: "Request"});
    if (mode === "cancel") patterns.push({urlPattern: "*", resourceType: "Document", requestStage: "Request"});
    if (!patterns.length) return null;
    return {patterns, ...(mode === "cancel" ? {handleAuthRequests: true} : {})};
}

/** CDP URL-pattern match: `*` = any run of characters, `?` = one character, `\` escapes. */
export function urlPatternMatches(pattern, url) {
    if (!pattern || pattern === "*") return true;
    let re = "";
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === "\\" && i + 1 < pattern.length) re += pattern[++i].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
        else if (c === "*") re += ".*";
        else if (c === "?") re += ".";
        else re += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    }
    return new RegExp(`^${re}$`).test(url);
}

/** A challenge record from a Fetch.authRequired event. */
export function challengeFromFetch(p, frame) {
    const a = p.authChallenge || {};
    let origin = a.origin || null;
    if (!origin) try { origin = new URL(p.request.url).origin; } catch { origin = null; }
    return {origin, scheme: a.scheme || null, realm: a.realm || null, source: a.source || null, url: p.request && p.request.url, frame, handled: "cancelled"};
}

/** A challenge record from a Network.responseReceived event, or null when the response is not a challenge. */
export function challengeFromResponse(p, frame) {
    const r = p.response || {};
    if (r.status !== 401 && r.status !== 407) return null;
    const h = Object.entries(r.headers || {}).find(([k]) => /^(www|proxy)-authenticate$/i.test(k));
    if (!h) return null;
    let origin = null;
    try { origin = new URL(r.url).origin; } catch { /* keep null */ }
    const scheme = String(h[1]).split(/[\s,]/)[0] || null, realm = (/realm="([^"]*)"/i.exec(String(h[1])) || [])[1] || null;
    return {origin, scheme, realm, url: r.url, frame, handled: "none"};
}

/** The rejection reason for a run that met challenges. */
export function authReason(challenges) {
    const list = [...new Set(challenges.map(c => `${c.origin || "an unknown origin"}${c.scheme ? ` (${c.scheme})` : ""}`))];
    return `HTTP auth challenge from ${list.join(", ")}: sign in to the browser profile first`;
}
