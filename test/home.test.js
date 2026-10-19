import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import JSZip from "jszip";
import { resolveConfig, isInputFolder, folderRole } from "../lib/config-core.js";
import { buildHomeModel } from "../lib/home-model.js";
import { booksFromAssets, describeBooks, bookCover, countWords } from "../lib/library.js";

const hash = s => crypto.createHash("sha256").update(s).digest("hex");
const paths = { entry: s => `/entry/${s}`, contents: n => `/contents/${n}`, book: b => `/${b.fmt}/${b.id}`, cover: b => `/epub-cover/${b.id}` };
const entry = (id, tags, updated, body = "<p>one two three</p>") => ({ id, slug: hash(id).slice(0, 8), title: id, tags, updated, created: updated, bodyHtml: body });

test("a folder and its subfolders follow collections.inputFolders", () => {
  const config = resolveConfig({ collections: { inputFolders: ["Papers"] } });
  assert.equal(isInputFolder(config, "Papers"), true);
  assert.equal(isInputFolder(config, "papers/Reading"), true);
  assert.equal(isInputFolder(config, "PapersExtra"), false);
  assert.equal(isInputFolder(config, "Journal"), false);
  assert.equal(isInputFolder(resolveConfig({}), "Journal"), false);
});

test("a folder is input, output or ignored", () => {
  const auto = resolveConfig({ collections: { inputFolders: ["Papers"] } });
  assert.equal(folderRole(auto, "Journal", true), "output");
  assert.equal(folderRole(auto, "Papers", true), "input");
  assert.equal(folderRole(auto, "Books", false), "input");
  // Once the output folders are listed, a folder in neither list is ignored.
  const explicit = resolveConfig({ collections: { inputFolders: ["Papers"], outputFolders: ["Journal"] } });
  assert.equal(folderRole(explicit, "Journal", true), "output");
  assert.equal(folderRole(explicit, "Papers", true), "input");
  assert.equal(folderRole(explicit, "Travel", true), null);
  assert.equal(folderRole(explicit, "Books", false), null);
});

test("words: CJK characters and Latin words", () => {
  assert.equal(countWords("酒吧长谈 and the bar"), 4 + 3);
  assert.equal(countWords(""), 0);
});

test("the home model has a volume per output collection and every note, newest first", () => {
  const entries = [
    entry("Journal/a.md", ["Journal"], "2026-10-01"),
    entry("Journal/b.md", ["Journal"], "2026-10-05"),
    entry("Papers/c.md", ["Papers"], "2026-09-01"),
    entry("loose.md", [], "2026-10-02")
  ];
  const output = buildHomeModel({ entries, books: [], config: resolveConfig({}), paths });
  assert.deepEqual(output.collections.map(c => [c.name, c.notes, c.latest]), [["Journal", 2, "2026-10-05"], ["Papers", 1, "2026-09-01"]]);
  assert.deepEqual(output.notes.map(n => n.title), ["Journal/b.md", "loose.md", "Journal/a.md", "Papers/c.md"]);
  assert.equal(output.notes[1].collection, null);
  // Papers is input: its notes are no volume (they are still notes).
  const input = buildHomeModel({ entries, books: [], config: resolveConfig({ collections: { inputFolders: ["Papers"] } }), paths });
  assert.deepEqual(input.collections.map(c => c.name), ["Journal"]);
  assert.equal(input.notes.length, 4);
});

test("an output folder's EPUB and PDF files are left off the library, an input folder's are shown", () => {
  const entries = [entry("Journal/a.md", ["Journal"], "2026-10-01"), entry("Papers/c.md", ["Papers"], "2026-09-01")];
  const books = [
    { id: "1", fmt: "epub", folder: "Journal", title: "In journal" },
    { id: "2", fmt: "pdf", folder: "Papers/Reading", title: "In papers" },
    { id: "3", fmt: "epub", folder: "Books/Fiction", title: "Only files here" },
    { id: "4", fmt: "epub", folder: "", title: "At the top" }
  ];
  const titles = config => buildHomeModel({ entries, books, config, paths }).books.map(b => b.title);
  assert.deepEqual(titles(resolveConfig({})), ["Only files here", "At the top"]);
  assert.deepEqual(titles(resolveConfig({ collections: { inputFolders: ["Papers"] } })), ["In papers", "Only files here", "At the top"]);
});

test("ignored folders make no collection and put no files on the shelves", () => {
  const entries = [entry("Journal/a.md", ["Journal"], "2026-10-01"), entry("Travel/b.md", ["Travel"], "2026-09-01")];
  const books = [{ id: "1", fmt: "pdf", folder: "Papers", title: "p" }, { id: "2", fmt: "pdf", folder: "Other", title: "o" }];
  const config = resolveConfig({ collections: { inputFolders: ["Papers"], outputFolders: ["Journal"] } });
  const out = buildHomeModel({ entries, books, config, paths });
  assert.deepEqual(out.collections.map(c => c.name), ["Journal"]);
  assert.deepEqual(out.books.map(b => b.title), ["p"]);
  assert.equal(out.notes.length, 2);
});

test("books: title, author, length and cover are read from the EPUB; a PDF's length from its size", async () => {
  const zip = new JSZip();
  zip.file("META-INF/container.xml", '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>');
  zip.file("OEBPS/content.opf", '<package><metadata xmlns:dc="x"><dc:title>Pale Fire</dc:title><dc:creator>Vladimir Nabokov</dc:creator><meta name="cover" content="cov"/></metadata><manifest><item id="cov" href="img/cover.png" media-type="image/png"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest></package>');
  zip.file("OEBPS/img/cover.png", new Uint8Array([1, 2, 3]));
  zip.file("OEBPS/c1.xhtml", "<html><body><p>one two three</p><p>酒吧</p></body></html>");
  const epub = await zip.generateAsync({ type: "uint8array" });
  const files = new Map([["Books/Fiction/pale.epub", epub], ["Papers/x.pdf", new Uint8Array(6000)], ["notes.md", new Uint8Array(1)]]);
  const source = { readAsset: async p => files.has(p) ? { size: files.get(p).length, lastModified: 1, arrayBuffer: async () => files.get(p).buffer.slice(files.get(p).byteOffset, files.get(p).byteOffset + files.get(p).length) } : null };
  const books = booksFromAssets([...files.keys()], hash);
  assert.deepEqual(books.map(b => [b.fmt, b.folder, b.title]), [["epub", "Books/Fiction", "pale"], ["pdf", "Papers", "x"]]);
  const [epubBook, pdfBook] = await describeBooks(books, source);
  assert.equal(epubBook.title, "pale");
  assert.equal(epubBook.author, "Vladimir Nabokov");
  assert.equal(epubBook.words, 3 + 2);
  assert.equal(epubBook.hasCover, true);
  assert.deepEqual([...(await bookCover(books[0], source)).bytes], [1, 2, 3]);
  assert.equal(pdfBook.words, 100);
  assert.equal(pdfBook.hasCover, false);
});
