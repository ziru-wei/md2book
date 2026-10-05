// Builds the browser reader (web/) into dist/: a static site that reads
// a folder of notes on the visitor's own computer — see web/app.js.
//   node scripts/build-web.mjs
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "dist");
const temml = JSON.parse(fs.readFileSync(path.join(root, "node_modules/temml/package.json"), "utf8"));

fs.rmSync(out, { recursive: true, force: true });

await esbuild.build({
  absWorkingDir: root,
  entryPoints: ["web/app.js"],
  outfile: "dist/app.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  sourcemap: true,
  legalComments: "linked",
  alias: {
    "node:path": "path-browserify",
    // Cheerio's own entry also brings in its Node-only fetching; its
    // parse5 loader (the same parser as on the server) is all md2book uses.
    "cheerio": "./node_modules/cheerio/dist/esm/load-parse.js",
    "fs": "./web/empty.js"
  },
  define: { TEMML_VERSION: JSON.stringify(temml.version) },
  logLevel: "info"
});

fs.copyFileSync(path.join(root, "web/index.html"), path.join(out, "index.html"));
fs.cpSync(path.join(root, "static"), path.join(out, "static"), { recursive: true });
fs.cpSync(path.join(root, "node_modules/justif/dist"), path.join(out, "vendor/justif"), { recursive: true });
fs.copyFileSync(path.join(root, "node_modules/justif/LICENSE"), path.join(out, "vendor/justif/LICENSE"));
// GitHub Pages: serve files as they are (no Jekyll).
fs.writeFileSync(path.join(out, ".nojekyll"), "");
console.log("Built dist/");
