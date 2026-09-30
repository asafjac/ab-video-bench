// ab-video-bench page marks: zero dependencies, works as a classic <script> and as an ES module import (both expose window.ABMark).
(function (root) {
    "use strict";
    if (!root || (root.ABMark && root.ABMark.version)) return;
    var CORE = {mark: 1, frame: 1, perfNow: 1, epochMs: 1, variant: 1};
    var state = {prefix: typeof root.ABMARK_PREFIX === "string" ? root.ABMARK_PREFIX : "[ABMARK]", frame: null,
        marker: {size: 8, color: "#ff00ff", ms: 100, corner: "top-left"}};

    function timeOrigin() {
        return typeof performance.timeOrigin === "number" ? performance.timeOrigin : Date.now() - performance.now();
    }

    function isTop() {
        try { return root.top === root; } catch (e) { return false; }
    }

    function frameName() {
        return state.frame || (isTop() ? "top" : "iframe");
    }

    function emit(name, perfNow, detail) {
        try {
            var line = {mark: String(name), frame: frameName(), perfNow: perfNow, epochMs: timeOrigin() + perfNow,
                variant: root.__abVariant === undefined ? null : root.__abVariant};
            if (detail && typeof detail === "object") {
                for (var key in detail) if (Object.prototype.hasOwnProperty.call(detail, key) && !CORE[key]) line[key] = detail[key];
            }
            try { performance.mark(line.mark, {detail: line}); } catch (e) { /* older engines: mark without detail */ }
            console.info(state.prefix + " " + JSON.stringify(line));
            return line;
        } catch (e) {
            return null;
        }
    }

    function mark(name, detail) {
        return emit(name, performance.now(), detail);
    }

    function setVariant(value) {
        root.__abVariant = value === undefined || value === null ? null : String(value);
        return mark("variantSet");
    }

    function markerConfig() {
        var cfg = {}, key, over = root.__abSyncMarker || {};
        for (key in state.marker) cfg[key] = state.marker[key];
        for (key in over) if (Object.prototype.hasOwnProperty.call(over, key)) cfg[key] = over[key];
        return cfg;
    }

    // The sync line at `perfNow`, then a corner square drawn in the next frame (syncFrame) and removed after cfg.ms (syncEnd).
    function syncAt(perfNow, detail) {
        var cfg = markerConfig(), size = cfg.size, vw = root.innerWidth, vh = root.innerHeight;
        var x = /right/.test(cfg.corner) ? vw - size : 0, y = /bottom/.test(cfg.corner) ? vh - size : 0;
        var info = {x: x, y: y, size: size, color: cfg.color, ms: cfg.ms, vw: vw, vh: vh};
        var extra = {syncTop: isTop(), marker: info}, key;
        if (detail) for (key in detail) if (Object.prototype.hasOwnProperty.call(detail, key)) extra[key] = detail[key];
        var line = emit("sync", perfNow, extra);
        try {
            var el = document.createElement("div");
            el.setAttribute("data-ab-sync-marker", "");
            el.setAttribute("aria-hidden", "true");
            el.style.cssText = "position:fixed;left:" + x + "px;top:" + y + "px;width:" + size + "px;height:" + size + "px;background:" + cfg.color +
                ";z-index:2147483647;pointer-events:none;margin:0;padding:0;border:0";
            document.documentElement.appendChild(el);
            requestAnimationFrame(function () {
                emit("syncFrame", performance.now());
                setTimeout(function () {
                    requestAnimationFrame(function () {
                        if (el.parentNode) el.parentNode.removeChild(el);
                        emit("syncEnd", performance.now());
                    });
                }, cfg.ms);
            });
        } catch (e) { /* no DOM: the line alone */ }
        return line;
    }

    function sync(detail) {
        return syncAt(performance.now(), detail);
    }

    // Opt-in: fire sync on the first press (capture-phase pointerdown) inside `selector`, at the event's own timestamp.
    function syncOnPress(selector) {
        var done = false;
        document.addEventListener("pointerdown", function (ev) {
            var t = ev.target;
            if (done || !t || !t.closest || !t.closest(selector)) return;
            done = true;
            syncAt(ev.timeStamp, {selector: selector});
        }, true);
    }

    function configure(options) {
        if (!options) return;
        if (typeof options.prefix === "string") state.prefix = options.prefix;
        if (typeof options.frame === "string") state.frame = options.frame;
        if (options.syncMarker) for (var key in options.syncMarker) state.marker[key] = options.syncMarker[key];
    }

    root.ABMark = {mark: mark, setVariant: setVariant, sync: sync, syncOnPress: syncOnPress, configure: configure, version: "2"};
})(typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : this);
