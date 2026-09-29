#!/usr/bin/env node
// md2book [settings] [notes-folder] [--port <n>] [--no-open]
//
// Serves a folder of Markdown notes (an Obsidian vault works as-is) as a
// paginated book at http://localhost:3000. The folder defaults to the
// current directory; the page reloads whenever a note changes.
// `md2book settings <folder>` opens the settings page instead.
import path from "node:path";

const args = process.argv.slice(2);
let folder = ".";
let port = Number(process.env.PORT || 3000);
let open = process.env.NO_OPEN !== "1";
let openPath;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (i === 0 && arg === "settings") openPath = "/settings";
  else if (arg === "--port" || arg === "-p") port = Number(args[++i]);
  else if (arg.startsWith("--port=")) port = Number(arg.slice("--port=".length));
  else if (arg === "--no-open") open = false;
  else if (arg === "--help" || arg === "-h") {
    console.log("Usage: md2book [settings] [notes-folder] [--port <n>] [--no-open]");
    process.exit(0);
  } else folder = arg;
}

if (!Number.isInteger(port) || port <= 0) {
  console.error("md2book: --port needs a number");
  process.exit(1);
}

// server.js reads the folder at import time.
process.env.MD2BOOK_NOTES = path.resolve(folder);
const { start } = await import("../server.js");
start({ port, open, openPath });
