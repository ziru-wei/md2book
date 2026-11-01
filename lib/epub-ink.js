import fsp from "node:fs/promises";
import path from "node:path";
import { DEFAULT_NOTES_DIR } from "./epub-bookmarks.js";

// Handwriting on an EPUB's pages: one file per book beside its notes
// (`Book/EPUB Notes/<title>.ink.json`). A stroke never changes once drawn, so
// devices only ever add strokes or erase them; an erased id is remembered, so
// a stroke a device sends again (its answer lost) never comes back. Every
// operation can be applied twice with the same result.
const MAX_STROKES = 20000, MAX_ERASED = 50000, MAX_POINTS = 4000;
const text = (value, max) => typeof value === "string" && value.length <= max;
const finite = (value, max) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= max;
const ID = /^[\w-]{1,64}$/;

// A stroke is drawn on a page of the single-column tablet layout (720 × 1000,
// paginated alike on a computer and an iPad): `section` is the chapter, `page`
// the sheet in it and the layout. `pts` is [x, y, pressure, dx, dy, dpressure,
// …]: quarter pixels from `page.x`/`page.y` on that page, the first point whole
// and each later one as a difference; pressure in hundredths.
export function validateStroke(value) {
  if (!value || !ID.test(value.id) || !Number.isInteger(value.section) || value.section < 0 || value.section > 100000 ||
      !/^#[0-9a-f]{6}$/i.test(value.color) || !finite(value.size, 40) || value.size < .5 ||
      !Array.isArray(value.pts) || !value.pts.length || value.pts.length % 3 || value.pts.length > MAX_POINTS * 3 ||
      !value.pts.every(n => Number.isInteger(n) && Math.abs(n) <= 4e6)) throw new Error("Invalid stroke");
  const page = value.page;
  if (!page || !text(page.key, 300) || !Number.isInteger(page.sheet) || page.sheet < 0 || !finite(page.x, 1e5) || !finite(page.y, 1e5)) throw new Error("Invalid stroke page");
  return { id: value.id, section: value.section, color: value.color, size: value.size,
    page: { key: page.key, sheet: page.sheet, x: page.x, y: page.y }, pts: value.pts,
    ...(text(value.created, 40) ? { created: value.created } : {}) };
}

export function validateInkOperations(value) {
  const ops = value?.ops;
  if (!Array.isArray(ops) || !ops.length || ops.length > 500) throw new Error("Invalid ink operations");
  return ops.map(op => {
    if (op?.type === "stroke") return { type: "stroke", stroke: validateStroke(op.stroke) };
    if (op?.type === "erase" && ID.test(op.id)) return { type: "erase", id: op.id };
    throw new Error("Invalid ink operation");
  });
}

// `changed`: whether anything was new (a repeated batch changes nothing).
export function applyInkOperations(data, ops) {
  const erased = new Set(data.erased), strokes = new Map(data.strokes.map(s => [s.id, s]));
  let changed = false;
  for (const op of ops) {
    if (op.type === "erase") {
      if (!erased.has(op.id)) { strokes.delete(op.id); erased.add(op.id); changed = true; }
    } else if (!erased.has(op.stroke.id) && !strokes.has(op.stroke.id)) {
      if (strokes.size >= MAX_STROKES) throw new Error("This book already has 20,000 strokes");
      strokes.set(op.stroke.id, op.stroke); changed = true;
    }
  }
  return { strokes: [...strokes.values()], erased: [...erased].slice(-MAX_ERASED), changed };
}

// Readable, and a change touches only its own lines: one stroke per line.
export function formatInk({ strokes, erased }) {
  return `{\n"strokes": [${strokes.map(s => "\n" + JSON.stringify(s)).join(",")}\n],\n"erased": ${JSON.stringify(erased)}\n}\n`;
}
const parse = raw => {
  const data = JSON.parse(raw);
  if (!Array.isArray(data.strokes)) throw new Error("Invalid ink file");
  return { strokes: data.strokes, erased: Array.isArray(data.erased) ? data.erased : [] };
};
export const inkFileName = notesName => notesName.replace(/\.json$/, "") + ".ink.json";

export function createGitHubInkStore(config, api) {
  const dir = (config.notesDir || DEFAULT_NOTES_DIR).replace(/^\/+|\/+$/g, "");
  const repo = `/repos/${config.owner}/${config.repo}`;
  const endpoint = name => `${repo}/contents/${[...dir.split("/"), name].map(encodeURIComponent).join("/")}`;
  async function read(name) {
    let file;
    try { file = await api(`${endpoint(name)}?ref=${encodeURIComponent(config.branch)}`, config.token); }
    catch (error) { if (error.status === 404) return { strokes: [], erased: [], sha: null }; throw error; }
    // The contents API leaves out a file over 1 MB; its blob has it.
    const content = file.content && file.encoding === "base64" ? file.content : (await api(`${repo}/git/blobs/${file.sha}`, config.token)).content;
    return { ...parse(Buffer.from(content, "base64").toString("utf8")), sha: file.sha };
  }
  return {
    async read(name) { const { strokes, erased } = await read(name); return { strokes, erased }; },
    async update(name, value) {
      const ops = validateInkOperations(value);
      for (let attempt = 0; attempt < 4; attempt++) {
        const current = await read(name), next = applyInkOperations(current, ops);
        if (!next.changed) return { count: next.strokes.length };
        try {
          await api(endpoint(name), config.token, { method: "PUT", body: {
            message: "md2book: update EPUB handwriting", branch: config.branch,
            content: Buffer.from(formatInk(next)).toString("base64"),
            ...(current.sha ? { sha: current.sha } : {})
          } });
          return { count: next.strokes.length };
        } catch (error) {
          if (![409, 422].includes(error.status) || attempt === 3) throw error;
        }
      }
    }
  };
}

// The same file in a local vault, written whole, one change at a time.
export function createFileInkStore(rootDir, notesDir = DEFAULT_NOTES_DIR) {
  const dir = path.join(rootDir, ...notesDir.replace(/^\/+|\/+$/g, "").split("/"));
  async function read(name) {
    try { return parse(await fsp.readFile(path.join(dir, name), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return { strokes: [], erased: [] }; throw error; }
  }
  let queue = Promise.resolve();
  return {
    read,
    update(name, value) {
      const ops = validateInkOperations(value);
      const run = queue.then(async () => {
        const next = applyInkOperations(await read(name), ops);
        if (!next.changed) return { count: next.strokes.length };
        await fsp.mkdir(dir, { recursive: true });
        const file = path.join(dir, name), part = path.join(dir, `.${name}.part`);
        await fsp.writeFile(part, formatInk(next));
        await fsp.rename(part, file);
        return { count: next.strokes.length };
      });
      queue = run.catch(() => {});
      return run;
    }
  };
}
