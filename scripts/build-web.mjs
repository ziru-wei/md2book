// Builds the browser reader (web/) into dist/: a static site that reads
// a folder of notes on the visitor's own computer — see web/app.js.
//   node scripts/build-web.mjs
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "dist");
const temml = JSON.parse(fs.readFileSync(path.join(root, "node_modules/temml/package.json"), "utf8"));

// A fresh dist/ each time — except dist/.vercel, which links it to a
// Vercel project (`vercel deploy dist`; see the README).
const vercelLink = path.join(out, ".vercel");
const keep = fs.existsSync(vercelLink) && fs.mkdtempSync(path.join(root, ".vercel-link-"));
if (keep) fs.renameSync(vercelLink, path.join(keep, ".vercel"));
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);
if (keep) {
  fs.renameSync(path.join(keep, ".vercel"), vercelLink);
  fs.rmSync(keep, { recursive: true });
}

// This build's version: a digest of the code it is made from. GitHub Pages
// lets browsers keep a file for 10 minutes, so after a deploy a page could
// run the new app.js with the old reader.js (or the other way round). Each
// address of app.js and the reader's own scripts and stylesheets carries it
// (?v=…; see versioned in web/app.js): a new build is a new address.
const digest = createHash("sha256");
for (const dir of ["lib", "static", "web"]) {
  for (const file of fs.readdirSync(path.join(root, dir), { recursive: true }).sort()) {
    const full = path.join(root, dir, file);
    if (/\.(js|mjs|css|html)$/.test(file) && fs.statSync(full).isFile()) digest.update(file).update(fs.readFileSync(full));
  }
}
const build = digest.digest("hex").slice(0, 10);

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
  define: { TEMML_VERSION: JSON.stringify(temml.version), MD2BOOK_BUILD: JSON.stringify(build) },
  logLevel: "info"
});

const indexHtml = fs.readFileSync(path.join(root, "web/index.html"), "utf8");
if (!indexHtml.includes('src="app.js"')) throw new Error('web/index.html: no <script src="app.js">');
fs.writeFileSync(path.join(out, "index.html"), indexHtml.replace('src="app.js"', `src="app.js?v=${build}"`));
fs.cpSync(path.join(root, "static"), path.join(out, "static"), { recursive: true });
fs.cpSync(path.join(root, "node_modules/justif/dist"), path.join(out, "vendor/justif"), { recursive: true });
fs.copyFileSync(path.join(root, "node_modules/justif/LICENSE"), path.join(out, "vendor/justif/LICENSE"));
// GitHub Pages: serve files as they are (no Jekyll).
fs.writeFileSync(path.join(out, ".nojekyll"), "");
console.log("Built dist/");

for (const [pkg, file, license] of [["epubjs", "epub.min.js", "license"], ["jszip", "jszip.min.js", "LICENSE.markdown"]]) {
  fs.mkdirSync(path.join(out, "vendor", pkg), { recursive: true });
  fs.copyFileSync(path.join(root, "node_modules", pkg, "dist", file), path.join(out, "vendor", pkg, file));
  fs.copyFileSync(path.join(root, "node_modules", pkg, license), path.join(out, "vendor", pkg, "LICENSE"));
}
fs.mkdirSync(path.join(out, "vendor/perfect-freehand"), { recursive: true });
fs.copyFileSync(path.join(root, "node_modules/perfect-freehand/dist/esm/index.mjs"), path.join(out, "vendor/perfect-freehand/index.mjs"));
fs.copyFileSync(path.join(root, "node_modules/perfect-freehand/LICENSE"), path.join(out, "vendor/perfect-freehand/LICENSE"));
