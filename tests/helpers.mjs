import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {hasBinary} from "../src/media.mjs";
import {normalizeConfig} from "../src/scenario.mjs";

export const HAVE_FFMPEG = hasBinary("ffmpeg") && hasBinary("ffprobe");

export const tmpDir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `abvb-${name}-`));

export const mockConfig = () => normalizeConfig({
    scenarios: [{
        name: "list", label: "List page", url: "http://127.0.0.1:1/", visible: "true",
        variant: {type: "cookie", name: "v", values: {a: "baseline", b: "candidate"}},
        marks: [{name: "appStart", label: "app"}, {name: "dataReceived", label: "data"}, {name: "firstRender", label: "render"}],
        labels: {a: "baseline", b: "candidate"},
    }],
});
