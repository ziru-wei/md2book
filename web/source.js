import { IGNORED_DIR_RE, isMarkdown } from "../lib/vault-files.js";

// Notes from a folder on this computer, read by the browser — the same
// shape as the sources in lib/source.js (listAll, readFile), plus
// readAsset(path) -> a File, and signature() for noticing changes.

// A folder picked with showDirectoryPicker() (Chrome, Edge): read afresh
// on every listing, so edits show up.
export function createDirectorySource(dirHandle) {
  let files = new Map();

  async function walk(dir, prefix, out) {
    for await (const [name, handle] of dir.entries()) {
      const rel = prefix + name;
      if (handle.kind === "directory") {
        if (!IGNORED_DIR_RE.test(rel + "/")) await walk(handle, rel + "/", out);
      } else if (!IGNORED_DIR_RE.test(rel)) {
        out.set(rel, handle);
      }
    }
    return out;
  }

  return {
    label: "note repo",
    name: dirHandle.name,

    async listAll() {
      files = await walk(dirHandle, "", new Map());
      const notes = [];
      const assets = [];
      for (const [rel, handle] of files) {
        if (isMarkdown(rel)) {
          const file = await handle.getFile();
          // Browsers don't know when a file was created; a note without
          // `created` in its frontmatter shows only its updated date.
          notes.push({ id: rel, version: file.lastModified, updated: new Date(file.lastModified) });
        } else {
          assets.push(rel);
        }
      }
      return { notes, assets };
    },

    async readFile(id) {
      const handle = files.get(id);
      if (!handle) throw new Error(`No note "${id}"`);
      return (await handle.getFile()).text();
    },

    async readAsset(p) {
      const handle = files.get(p);
      return handle ? handle.getFile() : null;
    },

    // Every file's path and time, to tell whether anything changed.
    async signature() {
      const all = await walk(dirHandle, "", new Map());
      const parts = [];
      for (const [rel, handle] of all) {
        parts.push(isMarkdown(rel) ? `${rel}:${(await handle.getFile()).lastModified}` : rel);
      }
      return parts.sort().join("\n");
    }
  };
}

// A folder chosen with <input webkitdirectory> (every browser): a
// snapshot of its files at the moment it was picked.
export function createFileListSource(fileList) {
  const files = new Map();
  let name = "";
  for (const file of fileList) {
    // "vault/sub/note.md" -> "sub/note.md"
    const [top, ...rest] = file.webkitRelativePath.split("/");
    name ||= top;
    const rel = rest.join("/");
    if (rel && !IGNORED_DIR_RE.test(rel)) files.set(rel, file);
  }

  return {
    label: "note repo",
    name,

    async listAll() {
      const notes = [];
      const assets = [];
      for (const [rel, file] of files) {
        if (isMarkdown(rel)) notes.push({ id: rel, version: file.lastModified, updated: new Date(file.lastModified) });
        else assets.push(rel);
      }
      return { notes, assets };
    },

    async readFile(id) {
      const file = files.get(id);
      if (!file) throw new Error(`No note "${id}"`);
      return file.text();
    },

    async readAsset(p) {
      return files.get(p) || null;
    }
  };
}
