import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn, execFileSync} from "node:child_process";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function candidates() {
    if (process.platform === "win32") {
        const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean);
        return roots.flatMap(r => [path.join(r, "Google/Chrome/Application/chrome.exe"), path.join(r, "Chromium/Application/chrome.exe")]);
    }
    if (process.platform === "darwin") {
        return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium",
            path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome")];
    }
    const found = [];
    for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
        try { found.push(execFileSync("which", [name], {encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]}).trim()); } catch { /* not installed */ }
    }
    return [...found.filter(Boolean), "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"];
}

/** A Chrome/Chromium executable: the explicit path, then CHROME_PATH, then the usual install locations; null when none exists. */
export function findChrome(explicit) {
    for (const p of [explicit, process.env.CHROME_PATH, ...candidates()]) if (p && fs.existsSync(p)) return p;
    return null;
}

/** Launches Chrome with a temporary profile and a free DevTools port; close() kills it and removes the profile. */
export async function launchChrome({executable, headless = true, width = 1280, height = 900, extraArgs = [], timeoutMs = 30000} = {}) {
    const exe = findChrome(executable);
    if (!exe) throw new Error("no Chrome/Chromium found: pass --chrome <path> or set CHROME_PATH");
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ab-chrome-"));
    const args = ["--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
        "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
        "--disable-component-update", "--disable-sync", "--mute-audio", "--hide-scrollbars", `--window-size=${width},${height}`,
        ...(headless ? ["--headless=new"] : []), ...extraArgs, "about:blank"];
    const child = spawn(exe, args, {stdio: "ignore"});
    let exited = false;
    child.on("exit", () => { exited = true; });
    const portFile = path.join(profile, "DevToolsActivePort");
    const until = Date.now() + timeoutMs;
    let port = null, wsPath = null;
    while (Date.now() < until && !exited) {
        if (fs.existsSync(portFile)) {
            const [p, ws] = fs.readFileSync(portFile, "utf8").split(/\r?\n/);
            if (p && ws) { port = Number(p); wsPath = ws; break; }
        }
        await sleep(100);
    }
    const close = async () => {
        if (!exited) {
            child.kill();
            for (let i = 0; i < 50 && !exited; i++) await sleep(100);
        }
        fs.rmSync(profile, {recursive: true, force: true, maxRetries: 20, retryDelay: 250});
    };
    if (!port) { await close(); throw new Error(`Chrome did not open a DevTools port within ${timeoutMs / 1000} s (${exe})`); }
    return {wsUrl: `ws://127.0.0.1:${port}${wsPath}`, port, executable: exe, close};
}
