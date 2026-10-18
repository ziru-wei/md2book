import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { resolveConfig, rowFor, rowForEpub } from "../lib/config-core.js";
import { createEntrySource } from "../lib/source.js";
import { createFileListSource } from "../web/source.js";
import * as render from "../lib/render.js";

test("EPUBs share one layout row without affecting collections", () => {
  const config = resolveConfig(JSON.parse(JSON.stringify({ layouts: {
    epub: { columns: 1, justify: true },
    rules: [{ collection: "a", columns: 2 }]
  } })));
  assert.equal(rowForEpub(config).columns, 1);
  assert.equal(rowForEpub(config).justify, true);
  assert.equal(rowFor(config, "a").justify, false);
  rowForEpub(config).columns = 2;
  assert.equal(rowForEpub(config).columns, 1);
});

test("recursive discovery, EPUB-only vaults and Markdown remain separate", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "md2book-epub-"));
  try {
    await mkdir(path.join(dir, "nested"));
    await writeFile(path.join(dir, "nested", "Book.EPUB"), "epub bytes");
    await writeFile(path.join(dir, "Book.epub"), "other epub bytes");
    await writeFile(path.join(dir, "nested", "note.md"), "# Note\n\nMarkdown body.");
    const source = createEntrySource(dir);
    const config = resolveConfig({});
    render.setup({ config, source, hash: s => crypto.createHash("sha256").update(s).digest("hex") });
    const entries = await render.listEntries();
    const epubs = await render.listEpubs();
    assert.equal(entries.length, 1);
    assert.equal(epubs.length, 2);
    assert.notEqual(epubs[0].id, epubs[1].id);
    const vault = await render.scanVault();
    assert.equal(vault.notes, 1);
    assert.deepEqual(vault.collections, [{ name: "nested", notes: 1 }]);
    assert.equal(vault.epubs.length, 2);
    const home = render.renderHomePage(entries, epubs);
    assert.ok(home.indexOf('aria-label="EPUB"') < home.indexOf('class="index-header'));
    assert.ok(!render.renderHomePage(entries).includes('aria-label="EPUB"'));
    assert.ok(render.renderHomePage([], epubs).includes(`/epub/${epubs[0].id}`));
    const reader = render.renderEpubPage(epubs[0]);
    assert.ok(reader.includes("static/epub-reader.js"));
    assert.ok(!reader.includes('src="/static/reader.js"'));
    assert.ok((await render.renderEntryPage(entries[0])).includes('src="/static/reader.js"'));
    assert.ok((await render.renderContentsPage(entries, "nested")).includes("Markdown body."));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("browser folder uploads retain EPUB files as readable assets", async () => {
  const files = ["vault/sub/book.EPUB", "vault/note.md"].map(webkitRelativePath => ({ webkitRelativePath, lastModified: 1 }));
  const source = createFileListSource(files);
  const { notes, assets } = await source.listAll();
  assert.deepEqual(assets, ["sub/book.EPUB"]);
  assert.equal(notes.length, 1);
  assert.equal(await source.readAsset(assets[0]), files[0]);
});
