// Variant strategies: how the recorder tells the page which variant a run is, before the start action.
const TYPES = ["cookie", "query", "localStorage", "header", "url"];

const originOf = (u) => new URL(u).origin;

function requireValues(spec) {
    if (!spec.values || spec.values.a == null || spec.values.b == null) throw new Error(`variant strategy "${spec.type}" needs values: {a, b}`);
}

/** A scenario's `variant` spec as {type, describe, expected, url, cookies, initScript, header}; each method takes "a" or "b". */
export function makeStrategy(spec, scenarioUrl) {
    if (!spec || !TYPES.includes(spec.type)) throw new Error(`variant.type must be one of ${TYPES.join(", ")}`);
    const t = spec.type;
    if (t === "url") {
        if (!spec.urls || !spec.urls.a || !spec.urls.b) throw new Error("variant strategy \"url\" needs urls: {a, b}");
    } else requireValues(spec);
    if ((t === "cookie" || t === "query" || t === "header") && !(spec.name || spec.param)) throw new Error(`variant strategy "${t}" needs a name`);
    if (t === "localStorage" && !spec.key) throw new Error("variant strategy \"localStorage\" needs a key");
    const value = (v) => String(spec.values[v]);
    const expected = (v) => String(spec.expect && spec.expect[v] != null ? spec.expect[v] : t === "url" ? v : spec.values[v]);
    const describe = {
        cookie: () => `cookie ${spec.name} (a=${spec.values.a}, b=${spec.values.b})`,
        query: () => `query parameter ${spec.param || spec.name} (a=${spec.values.a}, b=${spec.values.b})`,
        localStorage: () => `localStorage key ${spec.key} set before any page script (a=${spec.values.a}, b=${spec.values.b})`,
        header: () => `request header ${spec.name} injected via the Fetch domain on ${spec.urlPattern || "*"} (a=${spec.values.a}, b=${spec.values.b})`,
        url: () => `two URLs (a=${spec.urls.a}, b=${spec.urls.b})`,
    }[t]();
    return {
        type: t,
        describe,
        expected,
        url(base, v) {
            if (t === "url") return spec.urls[v];
            if (t !== "query") return base;
            const u = new URL(base); u.searchParams.set(spec.param || spec.name, value(v)); return u.toString();
        },
        cookies(v) {
            if (t !== "cookie") return [];
            const urls = spec.urls && spec.urls.length ? spec.urls : [scenarioUrl];
            return urls.map(u => ({name: spec.name, value: value(v), url: originOf(u) + "/", path: "/", secure: u.startsWith("https:"), sameSite: "Lax"}));
        },
        initScript(v) {
            if (t !== "localStorage") return null;
            const origins = spec.origins && spec.origins.length ? spec.origins.map(originOf) : [originOf(scenarioUrl)];
            return `(() => { try { if (${JSON.stringify(origins)}.includes(location.origin)) localStorage.setItem(${JSON.stringify(spec.key)}, ${JSON.stringify(value(v))}); } catch (e) {} })();`;
        },
        header(v) {
            return t === "header" ? {name: spec.name, value: value(v), urlPattern: spec.urlPattern || "*"} : null;
        },
    };
}
