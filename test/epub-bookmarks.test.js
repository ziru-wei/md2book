import test from "node:test";
import assert from "node:assert/strict";
import { applyBookmarkOperation, createGitHubBookmarkStore, validateBookmarkOperation } from "../lib/epub-bookmarks.js";
const id = "a".repeat(64);
const a = { type: "add", cfi: "epubcfi(/6/2!/4/2:0)", label: "First" };
const b = { type: "add", cfi: "epubcfi(/6/4!/4/2:0)", label: "Second" };

test("bookmark operations are idempotent and remove only the selected CFI", () => {
  const first = applyBookmarkOperation([], a);
  assert.deepEqual(applyBookmarkOperation(first, a), first);
  const both = applyBookmarkOperation(first, b);
  assert.deepEqual(applyBookmarkOperation(both, { type: "remove", cfi: b.cfi }), first);
  assert.throws(() => validateBookmarkOperation({ ...a, cfi: "../../secrets" }));
  assert.throws(() => validateBookmarkOperation({ ...a, label: "x".repeat(301) }));
});

test("cloud bookmarks retry concurrent commits and preserve other device changes", async () => {
  let bookmarks = [], sha = "v1", writes = 0;
  const api = async (_url, _token, request) => {
    if (!request) return { sha, content: Buffer.from(JSON.stringify({ bookmarks })).toString("base64") };
    writes++;
    if (writes === 1) {
      bookmarks = applyBookmarkOperation(bookmarks, b);
      sha = "v2";
      throw Object.assign(new Error("Conflict"), { status: 409 });
    }
    assert.equal(request.body.sha, "v2");
    bookmarks = JSON.parse(Buffer.from(request.body.content, "base64")).bookmarks;
    return {};
  };
  const store = createGitHubBookmarkStore({ owner: "owner", repo: "repo", branch: "main", token: "test" }, api);
  const result = await store.update(id, a);
  assert.deepEqual(result.bookmarks.map(b => b.cfi), [b.cfi, a.cfi]);
  assert.equal(writes, 2);
  await store.update(id, a);
  assert.equal(writes, 2, "replaying a successful add creates no commit");
});

test("a new cloud bookmark file is created without SHA; write failures propagate", async () => {
  let write;
  const config = { owner: "owner", repo: "repo", branch: "books", token: "test" };
  const store = createGitHubBookmarkStore(config, async (url, _token, request) => {
    assert.ok(url.includes(`/.md2book/epub/${id}.json`));
    if (!request) throw Object.assign(new Error("Missing"), { status: 404 });
    write = request.body;
  });
  await store.update(id, a);
  assert.equal(write.branch, "books");
  assert.equal(write.sha, undefined);
  const unavailable = createGitHubBookmarkStore(config, async () => { throw Object.assign(new Error("Denied"), { status: 403 }); });
  await assert.rejects(unavailable.update(id, a), /Denied/);
  await assert.rejects(store.read("../bad"), /Invalid book id/);
});
