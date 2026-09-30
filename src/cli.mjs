/** Tiny --flag value / --switch parser. */
export function parseArgs(argv) {
    const get = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
    const has = (n) => argv.includes(`--${n}`);
    const int = (n, d) => { const v = get(n); if (v === undefined) return d; const x = Number(v); if (!Number.isInteger(x) || x < 0) throw new Error(`--${n} must be an integer >= 0`); return x; };
    const num = (n, d) => { const v = get(n); if (v === undefined) return d; const x = Number(v); if (!Number.isFinite(x) || x <= 0) throw new Error(`--${n} must be a positive number`); return x; };
    return {get, has, int, num};
}

export function fail(message, code = 1) {
    console.error(message);
    process.exit(code);
}
