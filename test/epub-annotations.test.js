import test from "node:test";
import assert from "node:assert/strict";
import { notesFileName, applyHighlightOperation, createGitHubBookmarkStore, validateBookmarkOperation } from "../lib/epub-bookmarks.js";
await import("../static/epub-annotations.js");
const { find } = globalThis.epubAnnotations;

test("a quote is found where its surroundings match", () => {
  const text = "The cat sat. Then the cat ran. The cat slept.";
  const hit = find(text, { quote: "the cat", prefix: "sat. Then ", suffix: " ran. The" });
  assert.equal(text.slice(hit.start, hit.end), "the cat");
  assert.equal(hit.start, text.indexOf("the cat"));
  const third = find(text, { quote: "cat", prefix: "ran. The ", suffix: " slept." });
  assert.equal(third.start, text.lastIndexOf("cat"));
});

test("a quote cut by a page edge matches its visible part", () => {
  const head = find("…and the quick brown", { quote: "the quick brown fox jumps", prefix: "", suffix: "" });
  assert.deepEqual(head, { start: 5, end: 20 });
  const tail = find("fox jumps over", { quote: "the quick brown fox jumps", prefix: "", suffix: "" });
  assert.deepEqual(tail, { start: 0, end: 9 });
  assert.equal(find("nothing here", { quote: "absent text", prefix: "", suffix: "" }), null);
});

test("highlight operations validate, upsert and remove", () => {
  const h = { id: "abc-1", section: 3, quote: "words", prefix: "a ", suffix: " b", note: "" };
  const op = validateBookmarkOperation({ type: "highlight", highlight: h });
  const once = applyHighlightOperation([], op);
  const edited = applyHighlightOperation(once, { ...op, highlight: { ...h, note: "hm" } });
  assert.equal(edited.length, 1);
  assert.equal(edited[0].note, "hm");
  assert.equal(edited[0].created, once[0].created);
  assert.deepEqual(applyHighlightOperation(edited, { type: "unhighlight", id: "abc-1" }), []);
  assert.throws(() => validateBookmarkOperation({ type: "highlight", highlight: { ...h, id: "../x" } }));
  assert.throws(() => validateBookmarkOperation({ type: "highlight", highlight: { ...h, note: "x".repeat(2001) } }));
});

test("cloud highlights are stored beside bookmarks in one file", async () => {
  let saved;
  const store = createGitHubBookmarkStore({ owner: "o", repo: "r", branch: "main", token: "t" }, async (_u, _t, request) => {
    if (!request) throw Object.assign(new Error("Missing"), { status: 404 });
    saved = JSON.parse(Buffer.from(request.body.content, "base64"));
  });
  const result = await store.update("a".repeat(64), { type: "highlight", highlight: { id: "h1", section: 0, quote: "q", note: "n" } });
  assert.equal(result.highlights.length, 1);
  assert.deepEqual(saved.bookmarks, []);
  assert.equal(saved.highlights[0].note, "n");
});

test("notes files sit in the Book folder, named after the book", async () => {
  const books = [{ id: "a".repeat(64), title: "Story: One/Two" }, { id: "b".repeat(64), title: "Same" }, { id: "c".repeat(64), title: "Same" }];
  assert.equal(notesFileName(books[0], books), "Story One Two.json");
  assert.equal(notesFileName(books[1], books), "Same-bbbbbbbb.json");
  let url;
  const store = createGitHubBookmarkStore({ owner: "o", repo: "r", branch: "main", token: "t" }, async (u, _t, request) => {
    if (!request) throw Object.assign(new Error("Missing"), { status: 404 });
    url = u;
  });
  await store.update("a".repeat(64), { type: "unhighlight", id: "x" }, "My Book.json");
  assert.equal(url, "/repos/o/r/contents/Book/EPUB%20Notes/My%20Book.json");
});
