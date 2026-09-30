// Demo scenario config. ab-demo sets AB_DEMO_BASE_URL to the port it started the demo site on.
const base = process.env.AB_DEMO_BASE_URL || "http://127.0.0.1:8765";
const frameBase = base.replace("127.0.0.1", "localhost");

const variant = {type: "cookie", name: "ab_variant", values: {a: "baseline", b: "candidate"}};
const marks = [
    {name: "appStart", label: "app"},
    {name: "dataRequested", label: "request"},
    {name: "dataReceived", label: "data"},
    {name: "firstRender", label: "render"},
];
const labels = {a: "baseline (sequential)", b: "candidate (parallel)"};

export default {
    prefix: "[ABMARK]",
    viewport: {width: 900, height: 640},
    scenarios: [
        {
            name: "landing",
            label: "Dashboard, navigation start",
            url: `${base}/`,
            start: {type: "navigate"},
            visible: () => document.querySelectorAll("#grid .tile.ready").length >= 12,
            marks: [...marks, {name: "frameReady", label: "iframe"}],
            variant, labels,
            storageOrigins: [base, frameBase],
        },
        {
            name: "panel",
            label: "Reports panel, click start",
            url: `${base}/panel`,
            start: {type: "click", selector: "#open"},
            visible: () => document.querySelectorAll("#panel .tile.ready").length >= 12,
            marks,
            variant, labels,
        },
    ],
};
