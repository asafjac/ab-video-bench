# ab-video-bench

A/B page-load benchmark for Chrome, driven over the DevTools Protocol, with a deterministic, auto-annotated side-by-side video
for every scenario.

- **Strict alternation**: A, B, A, B, ... per scenario, so drift (thermal, network, background load) hits both variants alike.
- **Cold and hot sets**: cold = HTTP cache disabled and cleared, DNS host cache and socket pools flushed right before the start
  action; hot = caches and connections kept, after a discarded priming pair.
- **Every run is checked**: the page must report the variant it was asked for. A page that reports nothing aborts the set; a
  page that reports the wrong one gets that run excluded.
- **In-page marks from every frame**, including cross-site (out-of-process) iframes, on one clock: `performance.timeOrigin + performance.now()`.
- **Videos built only from the logs**: screencast frames with Chrome's own timestamps, a running ms timer per side, a timeline
  bar with labeled mark ticks and a playhead, a freeze with a highlighted border on the visible frame, and frames aligned to
  the page clock by a measured sync flash. Re-rendering the same set gives a byte-identical file.

No runtime dependencies: Node's standard library, a Chrome/Chromium, and ffmpeg.

## Contents

- [Install](#install)
- [Prerequisites](#prerequisites)
- [Quick start: the demo](#quick-start-the-demo)
- [Add the mark snippet to your page](#add-the-mark-snippet-to-your-page)
- [Write a scenario config](#write-a-scenario-config)
- [Variant strategies](#variant-strategies)
- [Run an A/B set](#run-an-ab-set)
- [Render videos](#render-videos)
- [Output layout](#output-layout)
- [How to read the video](#how-to-read-the-video)
- [The mark line contract](#the-mark-line-contract)
- [Alignment method and its measured error](#alignment-method-and-its-measured-error)
- [Mock mode](#mock-mode)
- [Tests](#tests)
- [Troubleshooting](#troubleshooting)

## Install

The package is not published to the npm registry; install it straight from GitHub.

```bash
# into a project (either form works)
npm install git+https://github.com/asafjac/ab-video-bench.git
npm install asafjac/ab-video-bench

# pin a tag, a commit or a branch
npm install asafjac/ab-video-bench#v0.1.0
npm install asafjac/ab-video-bench#3f2c1ab
npm install asafjac/ab-video-bench#main

# explicit host prefix, or over SSH
npm install github:asafjac/ab-video-bench#v0.1.0
npm install git+ssh://git@github.com/asafjac/ab-video-bench.git#v0.1.0
```

As a dependency in `package.json`:

```json
{
  "devDependencies": {
    "ab-video-bench": "github:asafjac/ab-video-bench#v0.1.0"
  }
}
```

Then run the CLIs through npx or an npm script. Three bin names are installed:

```bash
npx ab-bench --config bench/scenarios.mjs --cold 5 --hot 5
npx ab-video --root ab-results/2026-09-30 --phase cold --scenario landing
npx ab-demo
```

Global install, so `ab-bench`, `ab-video` and `ab-demo` are on your PATH:

```bash
npm install -g git+https://github.com/asafjac/ab-video-bench.git
```

Local development: clone, link, and every project that runs `npm link ab-video-bench` uses your working copy.

```bash
git clone https://github.com/asafjac/ab-video-bench.git
cd ab-video-bench
npm link                 # exposes the bins globally from this checkout
npm test
```

## Prerequisites

| Tool | Why | Check |
|---|---|---|
| Node.js >= 20 | runs everything (ES modules, `fetch`, `node --test`) | `node --version` |
| Chrome or Chromium | the browser under test (launched headless by default) | `"<path to chrome>" --version`; set `CHROME_PATH` if it is not found |
| ffmpeg and ffprobe on PATH | sync-flash detection, frame sizes, video encoding (libx264, drawtext) | `ffmpeg -version` and `ffprobe -version` |

Chrome is looked up in `--chrome <path>`, then `CHROME_PATH`, then the usual install locations on Windows, macOS and Linux.
ffmpeg needs libx264 and drawtext (freetype), which the common full builds include. The overlay font is found automatically
(Arial, Segoe UI, DejaVu Sans or Liberation Sans); pass `--font file.ttf` or set `AB_FONT` / `AB_FONT_BOLD` otherwise.

## Quick start: the demo

```bash
npm run demo              # or: npx ab-demo
```

This serves a small bundled site with node's `http` module, launches its own headless Chrome with a temporary profile and a
free DevTools port, runs 3 cold and 3 hot A/B pairs for two scenarios, and writes the report and four videos:

```
ab-results/<date>-demo/report.md
ab-results/<date>-demo/videos/{cold,hot}-{landing,panel}.mp4   (+ a .jpg poster each)
```

The demo site is a dashboard that loads a config and a list of items. Variant A (`baseline`) requests them one after the
other; variant B (`candidate`) requests both at once, so B should be about one API round trip faster. The variant is chosen by
the `ab_variant` cookie. One scenario starts with a navigation (`landing`), the other with a click on a button (`panel`), and
`landing` embeds a cross-site iframe whose marks show up on the timeline too.

Options: `--cold N --hot N --scenarios landing --root DIR --headed --chrome PATH`.

## Add the mark snippet to your page

`browser/abmark.js` has no dependencies and works both ways:

```html
<script src="/abmark.js"></script>
<script>ABMark.setVariant(readVariantSomehow()); ABMark.mark("appStart");</script>
```

```js
import "ab-video-bench/abmark";          // side effect: defines window.ABMark
window.ABMark.mark("dataReceived", {rows: 12});
```

Copy the file into your static assets or import it through your bundler. The API:

| Call | Effect |
|---|---|
| `ABMark.mark(name, detail?)` | `performance.mark(name, {detail})` plus one console line (below). Returns the line object, or `null` on failure; never throws. |
| `ABMark.setVariant(value)` | Sets `window.__abVariant = String(value)` and emits a `variantSet` mark. Call it as early as possible, in every frame that should be checked. |
| `ABMark.configure({prefix, frame})` | Changes the line prefix (default `[ABMARK]`) or the `frame` name (default `top` or `iframe`). `window.ABMARK_PREFIX` set before the script loads does the same for the prefix. |

Put marks where they explain the difference you expect: script start, request sent, reply received, first render. The
recorder adds its own (`startAction`, `navigationStart`, `visible`, `syncFlashOn`, `syncFlashOff`) in the same format.

## Write a scenario config

A config is an `.mjs` (default export) or `.json` file. It holds one scenario, an array, or `{prefix, viewport, scenarios}`;
an `.mjs` may also export a function returning any of these.

```js
export default {
    prefix: "[ABMARK]",                           // must match the snippet
    viewport: {width: 1280, height: 800},
    scenarios: [{
        name: "search",                           // used in paths: letters, digits, _ . -
        label: "Search results, navigation start",
        url: "https://staging.example.test/search?q=shoes",
        start: {type: "navigate"},                // or {type: "click", selector: "#go", readySelector: "#go", settleMs: 1000}
        visible: () => document.querySelectorAll(".result img").length >= 10
            && [...document.querySelectorAll(".result img")].every(i => i.complete),
        visibleFrame: null,                       // a URL substring to run `visible` inside an iframe instead of the top document
        marks: [{name: "appStart", label: "app"}, {name: "resultsReceived", label: "data"}, {name: "firstRender", label: "render"}],
        variant: {type: "cookie", name: "exp_search", values: {a: "control", b: "treatment"}},
        labels: {a: "control", b: "new ranking API"},
        storageOrigins: ["https://staging.example.test"],   // cleared before and after every run (default: the url's origin)
        crop: null,                               // a selector: crop the video to that element's box
        timeoutMs: 30000, settleMs: 1000,
    }],
};
```

- **Start state and start action.** `navigate`: a fresh tab on `about:blank` navigates to `url`; t0 is the new document's
  `performance.timeOrigin`. `click`: the tab first loads `url` (waiting for `readySelector`), settles, then the recorder
  clicks `selector` with real input events; t0 is the click event's own timestamp, taken by a capture-phase listener.
- **`visible`** is a predicate evaluated in the page on every animation frame after the start action, so its time is on the
  page clock. The first frame it returns true is "visible". It is serialized with `toString()`, so it must not reference
  variables from the config file. In JSON, give it as a string expression: `"document.querySelector('#done') !== null"`.
- **`marks`** picks the ticks drawn on the video timeline and the rows of the per-mark table, in that order. Without it, every
  mark the page logs is used.

## Variant strategies

The strategy tells the page which variant a run is, before the start action. Each run then asserts that every value the
page reported (`window.__abVariant` in any frame, and `variant` on any mark line) equals the expected one.

| `type` | Config | How it is applied |
|---|---|---|
| `cookie` | `name`, `values: {a, b}`, `urls?` | `Network.setCookie` for each URL's origin (default: the scenario URL) after the pre-run clearing; deleted after the run. |
| `query` | `param`, `values` | Added to the scenario URL as `?param=value`. |
| `localStorage` | `key`, `values`, `origins?` | Written by an init script in every matching document before any page script runs. |
| `header` | `name`, `values`, `urlPattern?` | `Fetch.enable` on the tab and every iframe target; each paused request continues with the header added. Both variants are intercepted, so the interception cost is symmetric. |
| `url` | `urls: {a, b}`, `expect?` | Two different URLs. Expected values default to `a` / `b`; set `expect: {a, b}` to what the pages report. |

For every strategy, `expect: {a, b}` overrides the value the page is expected to report. A cross-site iframe usually cannot
read the top page's cookies (third-party cookie blocking), so pass the variant to it another way, for example in its URL, as
the demo does.

## Run an A/B set

```bash
ab-bench --config bench/scenarios.mjs --cold 5 --hot 5
```

| Flag | Default | Meaning |
|---|---|---|
| `--cold N` / `--hot N` | 5 / 5 | measured A+B pairs per scenario |
| `--cold-warmup N` | 1 | discarded cold pairs before the measured cold runs |
| `--hot-prime N` | 1 | discarded pairs that fill the caches before the measured hot runs |
| `--scenarios a,b` | all | only these scenarios |
| `--root DIR` | `./ab-results/<date>[-N]` | output directory |
| `--port N` | | attach to a Chrome already listening for DevTools on that port, instead of launching one |
| `--chrome PATH`, `--headed` | auto, headless | the Chrome to launch, and whether to show its window |
| `--timeout-ms`, `--settle-ms` | 30000, 1000 | per-run wait for visible; recording kept after it |
| `--no-videos`, `--video-grid` | | skip frames and videos; also render the all-runs grid |
| `--allow-battery` | | do not wait for AC power |
| `--mock` | | no browser, see [Mock mode](#mock-mode) |

Per scenario the order is: cold warm-ups, cold pairs, hot priming, hot pairs, each pair A then B. Every run gets a fresh tab,
target-origin storage (service workers, Cache Storage, IndexedDB, localStorage, and sessionStorage via the fresh tab) cleared
before and after, and the recorder waits for the tab to be visible; a run whose tab went hidden is redone. On a laptop
running on battery the set waits for AC power, because a lowered CPU clock slows every page.

**Stopping.** Create an empty `STOP` file in the output directory; the set stops after the current run and still writes the
report and videos for what it has. Exit code 0 means every run finished and passed the variant check, 2 otherwise.

When you attach with `--port`, the recorder opens and closes its own tabs, and it uses `chrome://net-internals` in a
background tab to flush DNS and sockets for cold runs. It clears the whole browser's HTTP cache for cold runs, so prefer a
dedicated profile.

## Render videos

`ab-bench` renders `videos/<phase>-<scenario>.mp4` at the end of a set. To re-render or change options:

```bash
ab-video --root ab-results/2026-09-30 --phase cold --scenario search [--grid] [--speed 0.5] [--fps 30] [--out file.mp4]
```

- Median run per variant by default: the valid run whose visible time is closest to the variant's median. `--grid` shows every
  valid visible run, one row each.
- `--speed` (default 0.5) slows playback; the timers always show real ms.
- Frames are shifted by the set's smallest measured sync lag (next sections).
- Output is byte-identical across re-renders of the same set with the same ffmpeg and font. The encoder is bit-exact, metadata
  is stripped, and the frame selection is a pure function of the logs. The render result includes `planSha256`, a hash of
  the frame selection, which does not depend on the ffmpeg build.
- Files over `--max-mb` (default 14.5) are re-encoded at a higher CRF.

## Output layout

```
<root>/
  plan.json                     scenarios, schedule, definitions
  progress.json                 live state: done, current, ETA, rejected, failed
  run.log                       one line per run
  report.md, report.json
  videos/<phase>-<scenario>[-grid].{mp4,jpg}
  {a,b}/{cold,hot}/<scenario>/
    run-N.summary.json          visibleMs, t0, variant report and check, sync, clearing steps
    run-N.timeline.json         every mark, ms relative to t0, plus first occurrences
    run-N.frames/               screencast JPEGs + index.json [{ts, file}]
    warmup-N.summary.json       warm-up and priming runs (no frames)
```

`report.md` lists, per phase and scenario: n, median, p25–p75, IQR for A and B, Δ median and Δ % (B − A, negative = B faster),
runs that never became visible, and rejected runs. Then per-mark medians for A and B with their Δ, rejected runs with reasons,
failed runs, and the sync-lag summary.

## How to read the video

- **Header**: scenario, phase, which runs are shown, then the visible medians for A and B with Δ, Δ % and n. The third line
  states the playback speed and the frame shift applied.
- **Two columns**: A on the left, B on the right. Both start at their own t0, the start action, so they are compared from the
  same moment.
- **Timer** (top left of each tile): real ms since that side's start action.
- **Timeline bar** (under each tile): a tick per mark at its ms, labeled, and a white playhead moving with the timer.
- **Freeze**: when a side reaches visible it freezes on the first frame at or after that moment, draws a yellow border, and
  prints `VISIBLE <ms>`. The other side keeps playing until it gets there too.

## The mark line contract

Anything that writes this line to the console of any frame in the measured tab is picked up. The snippet is one way to do it.

```
[ABMARK] {"mark":"dataReceived","frame":"top","perfNow":812.4,"epochMs":1790000000812.4,"variant":"candidate","rows":12}
```

- One `console.info` (any console method works) whose first argument is the string `<prefix> <json>`: a single space between
  the prefix and the JSON object.
- `mark` (string): the mark name.
- `frame` (string): `top`, `iframe`, or a name you configure.
- `perfNow` (number): `performance.now()` in that document.
- `epochMs` (number): `performance.timeOrigin + perfNow`, the absolute clock every frame shares. Timelines use only this.
- `variant` (string or null): the frame's `window.__abVariant` at that moment.
- Any other keys are free-form detail and are kept in the timeline. Detail keys never overwrite the five fields above.
- Lines emitted by the recorder itself carry `"source": "recorder"`.

The page also exposes its variant as `window.__abVariant` in each frame; the recorder reads that global in every frame after
the run.

## Alignment method and its measured error

Screencast frames carry Chrome's own timestamp, and marks carry the page's clock. They are close but not equal: a DOM change
reaches a frame after the next animation frame, paint, and compositor swap. To measure the gap on every run, the recorder
shows a 48 px magenta square in the top-left corner for ~200 ms just before t0, logging `syncFlashOn` and `syncFlashOff` from
inside the page. ffmpeg then finds the first frame with the square and the first frame without it:

```
lag_on  = ts(first magenta frame)     - epochMs(syncFlashOn)
lag_off = ts(first non-magenta frame) - epochMs(syncFlashOff)
```

The report gives the median and range over the set, and the renderer shifts all frames earlier by the smallest measured lag
(never more than the true lag, so a frame shown at or after a mark really contains it). Measured on the bundled demo (headless
Chrome, Windows 11, 3 cold + 3 hot pairs, 2 scenarios): flash on median 21 ms [6.2–32.4], flash off median 16.9 ms
[5.9–35.2], n = 24 runs. The videos were therefore shifted by 5.9 ms, and a frame can still trail its mark by up to about
30 ms, under two display frames at 60 Hz. Read the video to a frame or two; take the numbers from the report. In mock mode,
where the lag is injected, it is recovered exactly (the tests check 0, 12, 23 and 41 ms).

The visible time is taken inside the page on the animation frame where the predicate first holds, so it shares the marks'
clock; the freeze frame is the first frame at or after that time (within 150 ms).

## Mock mode

```bash
npm run mock             # ab-bench --mock --config demo/scenarios.mjs --cold 5 --hot 5 --root ab-results/mock
```

No browser: deterministic synthetic runs (B about 28% faster, marks spread over the load in config order) and 60 fps
synthetic frames with a sync flash and a known lag (`--mock-lag-ms`, default 12), written in the same formats and pushed
through the same variant check, sync measurement, report and renderer. Useful for trying a config's labels and marks, and
for the tests.

## Tests

```bash
npm test                 # node --test
```

Alternation order, stats, the variant check (a mismatch excludes the run, a missing report aborts the set), the STOP file,
timeline building, sync-lag recovery, golden-file determinism (render twice, same md5, and the frame plan against
`tests/golden/mock-render.json`), the mark snippet's line format, and the demo end to end in headless Chrome, including every
variant strategy. The browser tests skip when no Chrome is found, and the video tests skip without ffmpeg. After an
intentional renderer change, refresh the golden file with `AB_UPDATE_GOLDEN=1 npm test`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `ABORTED: ... the page reported no variant` | No frame called `ABMark.setVariant` and no mark line carried a `variant`. Check the prefix matches, the snippet loads before your marks, and the strategy really reaches the page (for a cookie: domain, `Secure` on http, third-party blocking in iframes). |
| Runs `REJECTED (the page reported x but the run asked for y)` | The strategy did not win: a cached HTML response, a cookie set by the server overriding yours, or `expect` not matching what the page reports. |
| Every run is `timeout` | The `visible` predicate never became true, or it references a variable from the config file. The summary's `consoleTail` shows the page's last console lines. |
| `sync=FAILED` | Something covered the top-left corner, or the tab did not paint during the flash. The run is still measured; only its lag is missing. |
| `chrome://net-internals controls missing` in `clearing` | A Chrome build without those buttons. Cold runs still clear and disable the HTTP cache; DNS and sockets are not flushed. |
| `no Chrome/Chromium found` | Pass `--chrome <path>` or set `CHROME_PATH`. |
| `no TrueType font found` | Pass `--font file.ttf` (and `--font-bold`), or set `AB_FONT`. |
| ffmpeg errors about `-/filter_complex` | ffmpeg older than 7 is detected and uses the older script option; if detection fails, upgrade ffmpeg. |
| Numbers jump around | Close other heavy apps, stay on AC power, and use more pairs. Alternation spreads drift evenly but does not remove noise. |
