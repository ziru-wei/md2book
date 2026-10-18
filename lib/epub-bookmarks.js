// Each book has one private data file; update against the latest GitHub SHA.
// Operations, rather than whole snapshots, preserve other devices' bookmarks.
export function validateBookmarkOperation(value) {
  if (!value || !["add", "remove"].includes(value.type)) throw new Error("Invalid bookmark operation");
  if (typeof value.cfi !== "string" || !/^epubcfi\(.+\)$/.test(value.cfi) || value.cfi.length > 4096) throw new Error("Invalid bookmark location");
  if (value.type === "remove") return { type: "remove", cfi: value.cfi };
  if (typeof value.label !== "string" || value.label.length > 300) throw new Error("Invalid bookmark label");
  return { type: "add", cfi: value.cfi, label: value.label };
}

export function applyBookmarkOperation(bookmarks, operation) {
  const rest = bookmarks.filter(b => b.cfi !== operation.cfi);
  if (operation.type === "remove") return rest;
  const existing = bookmarks.find(b => b.cfi === operation.cfi);
  if (rest.length >= 1000) throw new Error("This book already has 1,000 bookmarks");
  return [...rest, { cfi: operation.cfi, label: operation.label, created: existing?.created || new Date().toISOString() }];
}

export function createGitHubBookmarkStore(config, api) {
  const endpoint = id => {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid book id");
    return `/repos/${config.owner}/${config.repo}/contents/.md2book/epub/${id}.json`;
  };
  async function read(id) {
    try {
      const file = await api(`${endpoint(id)}?ref=${encodeURIComponent(config.branch)}`, config.token);
      const data = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
      if (!Array.isArray(data.bookmarks)) throw new Error("Invalid cloud bookmark file");
      return { bookmarks: data.bookmarks, sha: file.sha };
    } catch (error) {
      if (error.status === 404) return { bookmarks: [], sha: null };
      throw error;
    }
  }
  return {
    async read(id) { return { bookmarks: (await read(id)).bookmarks }; },
    async update(id, value) {
      const operation = validateBookmarkOperation(value);
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = await read(id);
        const bookmarks = applyBookmarkOperation(current.bookmarks, operation);
        if (JSON.stringify(bookmarks) === JSON.stringify(current.bookmarks)) return { bookmarks };
        try {
          await api(endpoint(id), config.token, { method: "PUT", body: {
            message: "md2book: update EPUB bookmark",
            branch: config.branch,
            content: Buffer.from(JSON.stringify({ bookmarks }, null, 2) + "\n").toString("base64"),
            ...(current.sha ? { sha: current.sha } : {})
          } });
          return { bookmarks };
        } catch (error) {
          if (![409, 422].includes(error.status) || attempt === 2) throw error;
        }
      }
    }
  };
}
