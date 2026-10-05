// Which files in a vault are notes, and which folders to skip — shared
// by every source (lib/source.js, and the browser reader's in web/).

// Folders an Obsidian vault (or a Git checkout) keeps its own data in —
// never notes or attachments.
export const IGNORED_DIR_RE = /(^|\/)\.[^/]*(\/|$)|(^|\/)node_modules(\/|$)/;

// A note: a Markdown file, but not an Excalidraw drawing (the Obsidian
// Excalidraw plugin saves drawings as "*.excalidraw.md"). Canvas files
// (.canvas) aren't Markdown at all.
export function isMarkdown(p) {
  const lower = p.toLowerCase();
  return lower.endsWith(".md") && !lower.endsWith(".excalidraw.md");
}
