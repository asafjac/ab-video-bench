import fs from "node:fs";
import {execFileSync} from "node:child_process";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** "ac" | "battery" | "unknown". On battery most laptops lower the CPU clock and every page gets slower. */
export function powerSource() {
    try {
        if (process.platform === "win32") {
            const s = execFileSync("powershell", ["-NoProfile", "-Command", "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SystemInformation]::PowerStatus.PowerLineStatus"],
                {encoding: "utf8", timeout: 20000}).trim();
            return s === "Online" ? "ac" : s === "Offline" ? "battery" : "unknown";
        }
        if (process.platform === "darwin") {
            const s = execFileSync("pmset", ["-g", "batt"], {encoding: "utf8", timeout: 10000});
            return /AC Power/.test(s) ? "ac" : /Battery Power/.test(s) ? "battery" : "unknown";
        }
        const dir = "/sys/class/power_supply";
        if (!fs.existsSync(dir)) return "unknown";
        const mains = fs.readdirSync(dir).map(d => `${dir}/${d}`).filter(d => { try { return fs.readFileSync(`${d}/type`, "utf8").trim() === "Mains"; } catch { return false; } });
        if (!mains.length) return "unknown";
        return mains.some(d => fs.readFileSync(`${d}/online`, "utf8").trim() === "1") ? "ac" : "battery";
    } catch { return "unknown"; }
}

/** Waits up to 60 min for AC power before a run; throws if it never comes back. */
export async function waitForAc(label, log) {
    if (powerSource() !== "battery") return;
    log(`  (${label}: on battery; waiting up to 60 min for AC power, or rerun with --allow-battery)`);
    for (let i = 0; i < 120; i++) { await sleep(30000); if (powerSource() !== "battery") { log(`  (${label}: on AC power again)`); return; } }
    throw new Error("the machine stayed on battery for 60 min");
}
