import fs from "node:fs";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {makeStrategy} from "./variants.mjs";

export const DEFAULT_PREFIX = "[ABMARK]";

/** Loads a .mjs / .js / .json config: a scenario, an array of scenarios, {scenarios, prefix, viewport}, or a function returning any of these. */
export async function loadConfig(file, ctx = {}) {
    const abs = path.resolve(file);
    let raw;
    if (abs.endsWith(".json")) raw = JSON.parse(fs.readFileSync(abs, "utf8"));
    else raw = (await import(pathToFileURL(abs).href)).default;
    if (typeof raw === "function") raw = await raw(ctx);
    return normalizeConfig(raw);
}

export function normalizeConfig(raw) {
    const cfg = Array.isArray(raw) ? {scenarios: raw} : raw && raw.scenarios ? raw : {scenarios: [raw]};
    const out = {prefix: cfg.prefix || DEFAULT_PREFIX, viewport: cfg.viewport || {width: 1280, height: 800}, scenarios: cfg.scenarios.map(normalizeScenario)};
    const names = out.scenarios.map(s => s.name);
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) throw new Error(`scenario name "${dup}" is used twice`);
    return out;
}

function normalizeScenario(s) {
    if (!s || typeof s !== "object") throw new Error("a scenario must be an object");
    if (!s.name || !/^[A-Za-z0-9_.-]+$/.test(s.name)) throw new Error(`scenario.name "${s.name}" must be non-empty and use only letters, digits, _ . -`);
    const start = s.start || {type: "navigate"};
    if (!["navigate", "click"].includes(start.type)) throw new Error(`${s.name}: start.type must be "navigate" or "click"`);
    if (start.type === "click" && !start.selector) throw new Error(`${s.name}: a click start needs start.selector`);
    const variant = s.variant || {};
    const url = s.url || (variant.type === "url" && variant.urls && variant.urls.a);
    if (!url) throw new Error(`${s.name}: url is required`);
    if (!s.visible) throw new Error(`${s.name}: visible (a predicate run in the page) is required`);
    const visibleSource = typeof s.visible === "function" ? s.visible.toString() : `() => (${s.visible})`;
    const strategy = makeStrategy(variant, url);
    const storageOrigins = (s.storageOrigins && s.storageOrigins.length ? s.storageOrigins
        : variant.type === "url" ? [variant.urls.a, variant.urls.b] : [url]).map(u => new URL(u).origin);
    const marks = (s.marks || []).map(m => (typeof m === "string" ? {name: m} : m));
    return {
        name: s.name, label: s.label || s.name, url, start, visibleSource, visibleFrame: s.visibleFrame || null, marks, variant, strategy,
        labels: {a: "A", b: "B", ...(s.labels || {})}, storageOrigins: [...new Set(storageOrigins)], clearCookies: !!s.clearCookies,
        crop: s.crop || null, timeoutMs: s.timeoutMs || null, settleMs: s.settleMs ?? null,
    };
}

/** What plan.json keeps per scenario (and what the renderer reads back). */
export const scenarioPlan = (s) => ({name: s.name, label: s.label, url: s.url, start: s.start, visible: s.visibleSource, visibleFrame: s.visibleFrame,
    marks: s.marks, labels: s.labels, variant: s.strategy.describe, expected: {a: s.strategy.expected("a"), b: s.strategy.expected("b")}, storageOrigins: s.storageOrigins});
