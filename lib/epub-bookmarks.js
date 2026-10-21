import fsp from "node:fs/promises";
import path from "node:path";

// Each book has one private data file; update against the latest GitHub SHA.
// Operations, rather than whole snapshots, preserve other devices' bookmarks.
const text = (value, max) => typeof value === "string" && value.length <= max;

// A highlight is anchored by its quoted text (with a little context) inside a
// chapter, so it survives a change of page layout; `note` is the comment.
export function validateHighlight(value) {
  if (!value || !/^[\w-]{1,64}$/.test(value.id) || !Number.isInteger(value.section) || value.section < 0 || value.section > 100000 ||
      !text(value.quote, 1000) || !value.quote.trim() || !text(value.prefix ?? "", 64) || !text(value.suffix ?? "", 64) || !text(value.note ?? "", 2000)) {
    throw new Error("Invalid highlight");
  }
  return { id: value.id, section: value.section, quote: value.quote, prefix: value.prefix ?? "", suffix: value.suffix ?? "", note: value.note ?? "",
    // false: the highlight is erased and only the note's underline remains.
    ...(value.marker === false && value.note ? { marker: false } : {}) };
}

export function validateBookmarkOperation(value) {
  if (value && value.type === "highlight") return { type: "highlight", highlight: validateHighlight(value.highlight) };
  if (value && value.type === "unhighlight") {
    if (!/^[\w-]{1,64}$/.test(value.id)) throw new Error("Invalid highlight");
    return { type: "unhighlight", id: value.id };
  }
  if (!value || !["add", "remove"].includes(value.type)) throw new Error("Invalid bookmark operation");
  if (typeof value.cfi !== "string" || !/^epubcfi\(.+\)$/.test(value.cfi) || value.cfi.length > 4096) throw new Error("Invalid bookmark location");
  if (value.type === "remove") return { type: "remove", cfi: value.cfi };
  if (typeof value.label !== "string" || value.label.length > 300) throw new Error("Invalid bookmark label");
  return { type: "add", cfi: value.cfi, label: value.label };
}

export function applyHighlightOperation(highlights, operation) {
  if (operation.type === "unhighlight") return highlights.filter(h => h.id !== operation.id);
  const existing = highlights.find(h => h.id === operation.highlight.id);
  if (!existing && highlights.length >= 2000) throw new Error("This book already has 2,000 highlights");
  const next = { ...operation.highlight, created: existing?.created || new Date().toISOString() };
  return existing ? highlights.map(h => h.id === next.id ? next : h) : [...highlights, next];
}

export function applyBookmarkOperation(bookmarks, operation) {
  const rest = bookmarks.filter(b => b.cfi !== operation.cfi);
  if (operation.type === "remove") return rest;
  const existing = bookmarks.find(b => b.cfi === operation.cfi);
  if (rest.length >= 1000) throw new Error("This book already has 1,000 bookmarks");
  return [...rest, { cfi: operation.cfi, label: operation.label, created: existing?.created || new Date().toISOString() }];
}

// Each book's notes are one readable file in a folder of the repo, named
// after the book (`Book/EPUB Notes/<title>.json`); a second book with the
// same title gets a short id suffix.
export const DEFAULT_NOTES_DIR = "Book/EPUB Notes";
export function notesFileName(book, books) {
  const base = book.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "book";
  const clash = books.some(other => other.id !== book.id && other.title === book.title);
  return `${base}${clash ? "-" + book.id.slice(0, 8) : ""}.json`;
}

export function createGitHubBookmarkStore(config, api) {
  const dir = (config.notesDir || DEFAULT_NOTES_DIR).replace(/^\/+|\/+$/g, "");
  const legacy = id => `/repos/${config.owner}/${config.repo}/contents/.md2book/epub/${id}.json`;
  const endpoint = (id, name) => {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid book id");
    if (!name) return legacy(id);
    return `/repos/${config.owner}/${config.repo}/contents/${[...dir.split("/"), name].map(encodeURIComponent).join("/")}`;
  };
  async function fetchFile(url) {
    const file = await api(`${url}?ref=${encodeURIComponent(config.branch)}`, config.token);
    const data = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
    if (!Array.isArray(data.bookmarks)) throw new Error("Invalid cloud bookmark file");
    return { bookmarks: data.bookmarks, highlights: Array.isArray(data.highlights) ? data.highlights : [], sha: file.sha };
  }
  // Files from before the folder existed (.md2book/epub/<id>.json) are still
  // read; the next save writes the book's own file.
  async function read(id, name) {
    try { return await fetchFile(endpoint(id, name)); }
    catch (error) {
      if (error.status !== 404) throw error;
      if (name) {
        try { return { ...(await fetchFile(legacy(id))), sha: null }; }
        catch (old) { if (old.status !== 404) throw old; }
      }
      return { bookmarks: [], highlights: [], sha: null };
    }
  }
  return {
    async read(id, name) { const { bookmarks, highlights } = await read(id, name); return { bookmarks, highlights }; },
    async update(id, value, name) {
      const operation = validateBookmarkOperation(value);
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = await read(id, name);
        const highlightOp = operation.type === "highlight" || operation.type === "unhighlight";
        const bookmarks = highlightOp ? current.bookmarks : applyBookmarkOperation(current.bookmarks, operation);
        const highlights = highlightOp ? applyHighlightOperation(current.highlights, operation) : current.highlights;
        if (current.sha && JSON.stringify([bookmarks, highlights]) === JSON.stringify([current.bookmarks, current.highlights])) return { bookmarks, highlights };
        try {
          await api(endpoint(id, name), config.token, { method: "PUT", body: {
            message: "md2book: update EPUB bookmarks and highlights",
            branch: config.branch,
            content: Buffer.from(JSON.stringify({ bookmarks, highlights }, null, 2) + "\n").toString("base64"),
            ...(current.sha ? { sha: current.sha } : {})
          } });
          return { bookmarks, highlights };
        } catch (error) {
          if (![409, 422].includes(error.status) || attempt === 2) throw error;
        }
      }
    }
  };
}

// The same files in a folder on this computer: a local vault, which Git keeps
// in step with the repo, so the local server and a deployed one share each
// book's bookmarks and highlights. Writes go one at a time, each replacing
// the file whole.
export function createFileBookmarkStore(rootDir, notesDir = DEFAULT_NOTES_DIR) {
  const dir = path.join(rootDir, ...notesDir.replace(/^\/+|\/+$/g, "").split("/"));
  const legacy = id => path.join(rootDir, ".md2book", "epub", `${id}.json`);
  async function readFile(file) {
    const data = JSON.parse(await fsp.readFile(file, "utf8"));
    if (!Array.isArray(data.bookmarks)) throw new Error("Invalid bookmark file");
    return { bookmarks: data.bookmarks, highlights: Array.isArray(data.highlights) ? data.highlights : [] };
  }
  async function read(id, name) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid book id");
    for (const file of [name && path.join(dir, name), legacy(id)].filter(Boolean)) {
      try { return await readFile(file); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    return { bookmarks: [], highlights: [] };
  }
  let queue = Promise.resolve();
  return {
    read,
    update(id, value, name) {
      const operation = validateBookmarkOperation(value);
      const run = queue.then(async () => {
        const current = await read(id, name);
        const highlightOp = operation.type === "highlight" || operation.type === "unhighlight";
        const bookmarks = highlightOp ? current.bookmarks : applyBookmarkOperation(current.bookmarks, operation);
        const highlights = highlightOp ? applyHighlightOperation(current.highlights, operation) : current.highlights;
        await fsp.mkdir(dir, { recursive: true });
        const file = path.join(dir, name), part = path.join(dir, `.${name}.part`);
        await fsp.writeFile(part, JSON.stringify({ bookmarks, highlights }, null, 2) + "\n");
        await fsp.rename(part, file);
        return { bookmarks, highlights };
      });
      queue = run.catch(() => {});
      return run;
    }
  };
}
