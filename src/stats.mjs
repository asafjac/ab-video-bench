export const median = (xs) => {
    const a = [...xs].sort((p, q) => p - q), h = Math.floor(a.length / 2);
    return a.length % 2 ? a[h] : (a[h - 1] + a[h]) / 2;
};

// Linear interpolation between closest ranks (numpy's default).
export const quantile = (xs, q) => {
    const a = [...xs].sort((p, r) => p - r), i = (a.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
    return a[lo] + (a[hi] - a[lo]) * (i - lo);
};

export const r1 = (x) => Math.round(x * 10) / 10;

export function stats(xs) {
    if (!xs.length) return null;
    const p25 = quantile(xs, 0.25), p75 = quantile(xs, 0.75);
    return {n: xs.length, median: median(xs), p25, p75, iqr: p75 - p25};
}
