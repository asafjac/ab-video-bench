// ab-video-bench page marks: zero dependencies, works as a classic <script> and as an ES module import (both expose window.ABMark).
(function (root) {
    "use strict";
    if (!root || (root.ABMark && root.ABMark.version)) return;
    var CORE = {mark: 1, frame: 1, perfNow: 1, epochMs: 1, variant: 1};
    var state = {prefix: typeof root.ABMARK_PREFIX === "string" ? root.ABMARK_PREFIX : "[ABMARK]", frame: null};

    function timeOrigin() {
        return typeof performance.timeOrigin === "number" ? performance.timeOrigin : Date.now() - performance.now();
    }

    function frameName() {
        if (state.frame) return state.frame;
        try { return root.top === root ? "top" : "iframe"; } catch (e) { return "iframe"; }
    }

    function mark(name, detail) {
        try {
            var perfNow = performance.now();
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

    function setVariant(value) {
        root.__abVariant = value === undefined || value === null ? null : String(value);
        return mark("variantSet");
    }

    function configure(options) {
        if (options && typeof options.prefix === "string") state.prefix = options.prefix;
        if (options && typeof options.frame === "string") state.frame = options.frame;
    }

    root.ABMark = {mark: mark, setVariant: setVariant, configure: configure, version: "1"};
})(typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : this);
