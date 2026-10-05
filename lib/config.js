import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig, SETTINGS_NAME } from "./config-core.js";

export { DEFAULTS, SETTINGS_NAME, allowed, resolveConfig, rowFor, rowForNote } from "./config-core.js";

// Reading and writing md2book.settings.json (see lib/config-core.js for
// what it holds).

// The md2book folder (this file is in its lib/).
const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function settingsFile() {
  const file = process.env.MD2BOOK_SETTINGS
    ? path.resolve(process.env.MD2BOOK_SETTINGS)
    : path.join(APP_DIR, SETTINGS_NAME);
  return { file, exists: fs.existsSync(file) };
}

// The settings as saved (only what differs from the defaults is needed).
export function readSettings() {
  const { file, exists } = settingsFile();
  if (!exists) return { file, exists, saved: {} };
  return { file, exists, saved: JSON.parse(fs.readFileSync(file, "utf8")) };
}

export function loadConfig() {
  const { file, exists, saved } = readSettings();
  const config = resolveConfig(saved);
  config.file = exists ? file : null;
  return config;
}

export function writeSettings(file, saved) {
  fs.writeFileSync(file, JSON.stringify(saved, null, 2) + "\n");
}
