# ab-video-bench

A/B page-load benchmark for Chrome, driven over the DevTools Protocol, with a deterministic, auto-annotated video of every
run of every scenario.

- **Strict alternation**: A, B, A, B, ... per scenario, so drift (thermal, network, background load) hits both variants alike.
- **Cold and hot sets**: cold = HTTP cache disabled and cleared, DNS host cache and socket pools flushed right before the start
  action; hot = caches and connections kept, after a discarded priming pair.
- **Every run is checked**: the page must report the variant it was asked for, and the run must carry a `sync` line whose
  marker is found in the video frames. A page that reports no variant aborts the set; a wrong variant or a missing sync gets
  that run excluded.
- **In-page marks from every frame**, including cross-site (out-of-process) iframes, on one clock: `performance.timeOrigin + performance.now()`.
- **Videos built only from the logs**: every run of both variants in one video, each tile starting at its own `sync` line
  (logged at the start action), with a running ms timer, a timeline bar with labeled mark ticks and a playhead, and a freeze
  with a highlighted border on the visible frame. Frames are aligned to the page clock per run by a tiny marker drawn in the
  same animation frame as the sync line. Re-rendering the same set gives a byte-identical file.
- **Diagnostics**: `--single` performs one run of one variant and prints its whole timeline.

No runtime dependencies: Node's standard library, a Chrome/Chromium, and ffmpeg.

## Contents

- [Install](#install)
- [Prerequisites](#prerequisites)
- [Quick start: the demo](#quick-start-the-demo)
- [Add the mark snippet to your page](#add-the-mark-snippet-to-your-page)
- [Write a scenario config](#write-a-scenario-config)
- [Variant strategies](#variant-strategies)
- [Run an A/B set](#run-an-ab-set)
- [HTTP auth challenges](#http-auth-challenges)
- [Diagnostics: single run](#diagnostics-single-run)
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
| ffmpeg and ffprobe on PATH | sync-marker detection, frame sizes, video encoding (libx264, drawtext) | `ffmpeg -version` and `ffprobe -version` |

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
the `ab_variant` cookie. `panel` starts with a click on a button, and the recorder's press listener logs its `sync` line;
`landing` starts with a navigation, and the page calls `ABMark.sync()` from its first script. `landing` also embeds a
cross-site iframe whose marks show up on the timeline.

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
| `ABMark.sync(detail?)` | Emits the `sync` line now and draws the sync marker (below). Use it when the start action is not a press, for example a navigation: call it from the first script of the top document. |
| `ABMark.syncOnPress(selector)` | Installs a capture-phase `pointerdown` listener that emits `sync` once, at the event's own timestamp, for a press inside `selector`. For pages that fire their own sync on a click start (scenario `sync: "page"`). |
| `ABMark.configure({prefix, frame, syncMarker})` | Changes the line prefix (default `[ABMARK]`), the `frame` name (default `top` or `iframe`), or the marker (`{size, color, ms, corner}`). `window.ABMARK_PREFIX` set before the script loads does the same for the prefix. |

Put marks where they explain the difference you expect: script start, request sent, reply received, first render. The
recorder adds its own (`sync` on click starts, `startAction`, `navigationStart`, `visible`) in the same format.

## Write a scenario config

A config is an `.mjs` (default export) or `.json` file. It holds one scenario, an array, or `{prefix, viewport, syncMarker, scenarios}`;
an `.mjs` may also export a function returning any of these.

```js
export default {
    prefix: "[ABMARK]",                           // must match the snippet
    viewport: {width: 1280, height: 800},
    syncMarker: {size: 8, color: "#ff00ff", ms: 100, corner: "top-left"},   // the defaults
    scenarios: [{
        name: "search",                           // used in paths: letters, digits, _ . -
        label: "Search results, click start",
        url: "https://staging.example.test/search",
        start: {type: "click", selector: "#go", readySelector: "#go", settleMs: 1000},   // or {type: "navigate"}
        sync: "recorder",                         // click default; "page" = the page emits sync itself (always for navigate)
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

- **Start state and start action.** `click`: the tab first loads `url` (waiting for `readySelector`), settles, then the
  recorder clicks `selector` with real input events. Its capture-phase `pointerdown` listener logs the `sync` line at the
  press's own timestamp and draws the marker. `navigate`: a fresh tab on `about:blank` navigates to `url`, and the page must
  call `ABMark.sync()` from its first script. Either way **t0 is the `sync` line**. A run without one is rejected.
- **`visible`** is a predicate evaluated in the page on every animation frame from the start action on, so its time is on
  the page clock. The first frame it returns true is "visible". It is serialized with `toString()`, so it must not reference
  variables from the config file. In JSON, give it as a string expression: `"document.querySelector('#done') !== null"`.
  The sync marker is a `div[data-ab-sync-marker]` appended to `<html>` (not `<body>`) for about 100 ms, with
  `pointer-events: none`, so body-scoped queries never see it.
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
| `--no-videos` | | no videos (the screencast is still recorded, to measure each run's sync) |
| `--video-median` | | also render the median-run side-by-side video |
| `--sync-flash` | off | also show the old pre-run flash; used only when a run's marker is not found |
| `--max-width`, `--max-height` | 1920, 1080 | output video cap |
| `--allow-battery` | | do not wait for AC power |
| `--auth-challenges cancel\|ignore` | cancel | what to do with an HTTP auth challenge (401 / 407 sign-in); see [HTTP auth challenges](#http-auth-challenges) |
| `--mock` | | no browser, see [Mock mode](#mock-mode) |

Per scenario the order is: cold warm-ups, cold pairs, hot priming, hot pairs, each pair A then B. Every run gets a fresh tab,
target-origin storage (service workers, Cache Storage, IndexedDB, localStorage, and sessionStorage via the fresh tab) cleared
before and after, and the recorder waits for the tab to be visible; a run whose tab went hidden is redone. On a laptop
running on battery the set waits for AC power, because a lowered CPU clock slows every page.

**Stopping.** Create an empty `STOP` file in the output directory; the set stops after the current run and still writes the
report and videos for what it has. Exit code 0 means every run finished and passed both checks, 2 otherwise.

When you attach with `--port`, the recorder opens and closes its own tabs, and it uses `chrome://net-internals` in a
background tab to flush DNS and sockets for cold runs. It clears the whole browser's HTTP cache for cold runs, so prefer a
dedicated profile.

## HTTP auth challenges

A page behind HTTP authentication (say, a Basic-auth protected staging site at `https://staging.example.test`) answers a
browser that has not signed in with `401` and a `WWW-Authenticate` header. Left alone, Chrome opens its sign-in dialog over
the tab: the run waits for visible until its timeout, and a cold run's HTTP cache clear and socket flush would close a dialog
someone is typing into. The same goes for a cross-site iframe on the page, and for a proxy asking with `407`.

| Mode | What happens |
|---|---|
| `--auth-challenges cancel` (default) | Every document request of the run's tab and its iframe targets is paused through the Fetch domain with `handleAuthRequests`. A challenge is answered with `CancelAuth`, so no dialog opens and the run stops waiting at once. The run is rejected: `REJECTED (HTTP auth challenge from https://staging.example.test (basic): sign in to the browser profile first)`. |
| `--auth-challenges ignore` | The browser handles challenges as it would without this option (a dialog may open). Challenges seen in responses are still recorded. After such a run the set stops before the next cold run instead of clearing the cache and flushing sockets under an open dialog: `ABORTED: ... not run: an HTTP auth dialog may be open ...`. |

- Every summary has `authChallenges: [{origin, scheme, realm, url, frame, handled}]` (`handled`: `cancelled` or `none`), and a
  challenged run's `ab.authOk` is false with the reason in `ab.reason`. A challenged page usually reports no variant; that is
  reported as the challenge and does not abort the set.
- Only documents are paused for this, so subresource requests are not slowed. It composes with the `header` variant strategy:
  one `Fetch.enable` carries both patterns, and only requests matching the strategy's `urlPattern` get the header.
- Sign the browser profile in first (attach with `--port` to a Chrome that already has the credentials), then run.

## Diagnostics: single run

```bash
ab-bench --config bench/scenarios.mjs --single search                  # one cold run of B
ab-bench --config bench/scenarios.mjs --single --variant a --hot --prime search
```

`--single <scenario>` performs exactly one run of one variant (`--variant a|b`, default `b`; `--cold` or `--hot`, default
cold). There is no alternation, no warm-up, and no comparison. `--prime` (hot only) first does one discarded run of the same
variant, so the measured run sees warm caches; without it a hot run in a freshly launched Chrome starts with empty caches.

It writes `<root>/<variant>/<phase>/<scenario>/run-1.{summary.json,timeline.json,console.json,frames/}` (the recorder does not
capture network traffic, so there is no HAR), renders one full-size video `videos/<phase>-<scenario>-<variant>-run-1.mp4`
with the timer, the visible freeze, the sync lag in the header, and a tick for **every** mark the run logged, and prints:

```
t0: sync line from the recorder's press listener on the start selector
variant: expected baseline, page reported baseline -> ok
sync: lag +18 ms by marker, removal +17.7 ms, drawn 11.3 ms after the sync line
visible: 760.8 ms

       ms  mark                   frame   source    detail
      0.0  sync                   top     recorder  {"syncTop":true,"selector":"#open","marker":{...}}
      3.6  startAction            top     recorder  {"selector":"#open"}
      4.8  dataRequested          top     page      {"strategy":"sequential"}
     11.3  syncFrame              top     recorder
    ...
```

The exit code is 0 when the run passed the variant and sync checks. Invalid arguments (an unknown scenario, `--variant c`,
`--prime` without `--hot`, `--cold --hot` together) fail with a message before anything runs.

## Render videos

`ab-bench` renders `videos/<phase>-<scenario>.mp4` for every scenario and phase at the end of a set. To re-render, or to pick
another mode:

```bash
ab-video --root ab-results/2026-09-30 --phase cold --scenario search            # all runs (default)
ab-video --root ab-results/2026-09-30 --phase cold --scenario search --median   # median runs, side by side
```

| Mode | What it shows |
|---|---|
| all runs (default) | Every valid run of both variants in one video: the A runs in a grid on the left, the B runs in a grid on the right. Run *k* sits in the same cell of both grids, so pairs are compared by position, and the column heads keep A and B apart. The median run of each variant has a cyan outline. |
| `--median` | Only the run closest to each variant's median visible time, side by side at full size. |
| single run | One run at full size with every mark ticked. Produced by `ab-bench --single`, and by `ab-video` on a single-run directory. |

Why two grids rather than one row per run index: at 10–15 runs a row-per-pair layout is 10–15 tiles tall and two wide, so
each tile ends up tiny and far from the header. Two side-by-side grids keep all tiles near square cells and use the width.

- **Cap and scaling.** The output is capped at 1920 x 1080 (`--max-width`, `--max-height`). The grid shape and tile width are
  chosen to give the largest tile that fits, never larger than the recorded frame; timers, labels and ticks scale with the
  tile, with minimum font sizes. At 15 runs per variant and a 900 x 640 viewport that is a 4 x 4 grid per side of ~215 px
  tiles; a layout that cannot fit even 80 px tiles stops with an error asking for a larger cap.
- **Lockstep.** Every tile plays on one output clock; t = 0 is each run's own `sync` line.
- `--speed` (default 0.5) slows playback; the timers always show real ms.
- Output is byte-identical across re-renders of the same set with the same ffmpeg and font. The encoder is bit-exact, metadata
  is stripped, and the frame selection is a pure function of the logs. The render result includes `planSha256`, a hash of
  the frame selection, which does not depend on the ffmpeg build.
- Files over `--max-mb` (default 14.5) are re-encoded at a higher CRF.

## Output layout

```
<root>/
  plan.json                     mode, scenarios, schedule, definitions
  progress.json                 live state: done, current, ETA, rejected, failed
  run.log                       one line per run
  report.md, report.json
  videos/<phase>-<scenario>[-median].{mp4,jpg,json}   video, poster, and a JSON sidecar describing the video
  {a,b}/{cold,hot}/<scenario>/
    run-N.summary.json          visibleMs, t0, sync (lag, method, marker), variant report, checks, clearing steps
    run-N.timeline.json         every mark, ms relative to the sync line, plus first occurrences
    run-N.console.json          the page's other console lines and exceptions during the run
    run-N.frames/               screencast JPEGs + index.json [{ts, file}]
    warmup-N.summary.json       warm-up and priming runs (no frames)
```

Every rendered video (all runs, `--median`, single run) has a `.json` sidecar with the same name: scenario, phase, mode,
speed, output size, `planSha256`, the header text and medians / Δ, and per tile its variant, run, grid cell, t0 (sync epoch),
sync lag, visible ms, median flag, freeze frame, the ticks drawn (name, label, ms), and the frame selection as runs of
`[first output frame, last output frame, source frame, source ms]`. Like the video, it is byte-identical across re-renders of
the same set.

`report.md` lists, per phase and scenario: n, median, p25–p75, IQR for A and B, Δ median and Δ % (B − A, negative = B faster),
runs that never became visible, and rejected runs. Then per-mark medians for A and B with their Δ, rejected runs with reasons,
failed runs, and the sync-lag summary.

## How to read the video

- **Header**: scenario, phase, n per variant (or which runs are shown), then the medians of A and B with Δ and Δ %. The third
  line states the playback speed and the measured sync lag over the set.
- **A left, B right**. Every tile starts at its own t0, the `sync` line of its start action, so all runs are compared from the
  same moment.
- **Timer** (top left of each tile): real ms since that run's sync line.
- **Label** (bottom left): `run-N · <visible> ms`, plus `median` on the median run.
- **Timeline bar** (under each tile): a tick per mark at its ms, labeled, and a white playhead moving with the timer.
- **Freeze**: when a tile reaches visible it freezes on the first frame at or after that moment, draws a yellow border, and
  prints `VISIBLE <ms>`. The others keep playing until they get there too.

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

The sync lines, from `ABMark.sync()`, `ABMark.syncOnPress()` or the recorder's press listener:

| mark | when | extra fields |
|---|---|---|
| `sync` | the start action: the press's event timestamp, or the moment `ABMark.sync()` is called. **This is t0.** | `syncTop: true` (only the top document's sync counts), `marker: {x, y, size, color, ms, vw, vh}` in CSS px |
| `syncFrame` | inside the next `requestAnimationFrame`, the frame that paints the marker | |
| `syncEnd` | the animation frame that removes the marker, `ms` later | |

The page also exposes its variant as `window.__abVariant` in each frame; the recorder reads that global in every frame after
the run.

## Alignment method and its measured error

Screencast frames carry Chrome's own timestamp, and marks carry the page's clock. They are close but not equal: a DOM change
reaches a frame after the next animation frame, paint, and compositor swap. The recorder measures that gap on **every run**,
at the start action itself:

1. At the press (or `ABMark.sync()`), the page logs `sync` and appends an 8 px magenta square to a corner of the viewport.
2. In the next animation frame it logs `syncFrame`; about 100 ms later it removes the square and logs `syncEnd`.
3. ffmpeg samples a small patch in the middle of the square in every frame near the sync line and finds the first frame that
   shows it and the first one after that without it:

```
lag     = ts(first frame with the marker)        - epochMs(syncFrame)
offLag  = ts(first frame after it without it)    - epochMs(syncEnd)
```

The renderer then puts each run's t = 0 at its `sync` line and shifts that run's frames earlier by its own `lag`, so the frame
that first shows the press lands at the moment of the press plus the time to its drawing frame (`pressToFrameMs`, recorded
too). The marker area is painted over with the background in every frame before cropping, so it never shows in a video.
A run with no `sync` line is rejected ("no sync line ..."); a run whose marker is not in the frames is rejected too, unless
`--sync-flash` was on and the old pre-run flash was measured, in which case that lag is used (`method: "flash"`).

Measured on the bundled demo (headless Chrome, Windows 11, 3 cold + 3 hot pairs, 2 scenarios, 24 measured runs):
lag median 18.3 ms [9.3–22.9], marker removal median 14.3 ms [3.8–27.8], sync line to drawing frame
median 5.8 ms [1.4–19.9]. The residual error after the shift is the frame spacing at the marker: a change
is placed within one screencast frame interval of when it was painted, so read the video to a frame; take the numbers from
the report. In mock mode, where the lag is injected, it is recovered exactly (the tests check 0, 12, 23 and 41 ms).

For navigation starts the `sync` line comes from the page's first script, a few tens of ms after `navigationStart` (which
is kept in the timeline as a negative mark), so time spent before that script runs is not in the measured visible time.

The visible time is taken inside the page on the animation frame where the predicate first holds, so it shares the marks'
clock; the freeze frame is the first frame at or after that time (within 150 ms).

## Mock mode

```bash
npm run mock             # ab-bench --mock --config demo/scenarios.mjs --cold 5 --hot 5 --root ab-results/mock
```

No browser: deterministic synthetic runs (B about 28% faster, marks spread over the load in config order) and 60 fps
synthetic frames with the sync marker at t0 and a known lag (`--mock-lag-ms`, default 12), written in the same formats and
pushed through the same checks, sync measurement, report and renderer. `--single` works in mock mode too. Useful for trying a
config's labels and marks, and for the tests.

## Tests

```bash
npm test                 # node --test
```

Alternation order, stats, the variant check (a mismatch excludes the run, a missing report aborts the set), the sync check
(a missing sync line rejects the run), HTTP auth challenges (a cancelled one rejects the run, one left to the browser stops
the set before the next cold run, and a real cross-site iframe behind Basic auth in headless Chrome), the STOP file, timeline building, sync-lag recovery through the marker with injected
lags and through the fallback flash, the snippet's line format and its `sync()` / `syncOnPress()`, golden frame plans for the
all-runs, median and single-run videos (`tests/golden/mock-render.json`), render-twice-same-md5 for the all-runs video, the
layout cap, argument validation, the single-run mode, and the demo end to end in headless Chrome: both start actions, every
variant strategy, and a single run. The browser tests skip when no Chrome is found, and the video tests skip without ffmpeg.
After an intentional renderer change, refresh the golden file with `AB_UPDATE_GOLDEN=1 npm test`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `ABORTED: ... the page reported no variant` | No frame called `ABMark.setVariant` and no mark line carried a `variant`. Check the prefix matches, the snippet loads before your marks, and the strategy really reaches the page (for a cookie: domain, `Secure` on http, third-party blocking in iframes). |
| Runs `REJECTED (the page reported x but the run asked for y)` | The strategy did not win: a cached HTML response, a cookie set by the server overriding yours, or `expect` not matching what the page reports. |
| Runs `REJECTED (no sync line ...)` | Navigation starts need the page to call `ABMark.sync()` in the top document. Click starts need the press to land inside `start.selector`; with `sync: "page"` the page must call `ABMark.syncOnPress(selector)`. |
| Runs `REJECTED (the sync marker is in none of the ... frames)` | Something covers the marker's corner (move it with `syncMarker.corner`), its color matches the page there (change `syncMarker.color`), or the tab did not paint. `--sync-flash` adds a fallback measurement. |
| Every run is `timeout` | The `visible` predicate never became true, or it references a variable from the config file. The summary's `consoleTail` and `run-N.console.json` show the page's console. |
| `chrome://net-internals controls missing` in `clearing` | A Chrome build without those buttons. Cold runs still clear and disable the HTTP cache; DNS and sockets are not flushed. |
| Runs `REJECTED (HTTP auth challenge from ...)` | The browser profile is not signed in to that origin, or lost its credentials. Sign it in by hand, then rerun; see [HTTP auth challenges](#http-auth-challenges). |
| `no Chrome/Chromium found` | Pass `--chrome <path>` or set `CHROME_PATH`. |
| `no TrueType font found` | Pass `--font file.ttf` (and `--font-bold`), or set `AB_FONT`. |
| `tiles do not fit` | Too many runs for the output cap: raise `--max-width` / `--max-height`, or render `--median`. |
| ffmpeg errors about `-/filter_complex` | ffmpeg older than 7 is detected and uses the older script option; if detection fails, upgrade ffmpeg. |
| Numbers jump around | Close other heavy apps, stay on AC power, and use more pairs. Alternation spreads drift evenly but does not remove noise. |
