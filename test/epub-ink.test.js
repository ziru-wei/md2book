import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyInkOperations, createFileInkStore, createGitHubInkStore, formatInk, inkFileName, validateInkOperations } from "../lib/epub-ink.js";
await import("../static/epub-ink.js");
const { encodePoints, decodePoints, applyOps, stateOf, takeBatch, opKey } = globalThis.epubInk;

const stroke = (id, extra = {}) => ({ id, section: 3, color: "#26324a", size: 2.4,
  page: { key: "[\"tablet\",720,1000,1]", sheet: 2, x: 40.25, y: 80 },
  pts: encodePoints([[0, 0, .4], [1.5, 2.25, .6], [3, 4, .7]]), created: "2026-10-31T00:00:00.000Z", ...extra });
const draw = id => ({ type: "stroke", stroke: stroke(id) });

test("points survive encoding to small integers", () => {
  const points = [[10.25, -3.5, .42], [11, -2.75, .5], [30.5, 7, 1]];
  assert.deepEqual(decodePoints(encodePoints(points)), points);
  assert.ok(encodePoints(points).every(Number.isInteger));
});

test("ink operations can be sent twice; an erased stroke never comes back", () => {
  let data = { strokes: [], erased: [] };
  data = applyInkOperations(data, validateInkOperations({ ops: [draw("s1"), draw("s2")] }));
  assert.equal(data.changed, true);
  assert.equal(applyInkOperations(data, [draw("s1")]).changed, false, "a repeated batch changes nothing");
  data = applyInkOperations(data, [{ type: "erase", id: "s1" }]);
  // The device that drew s1 never heard the answer and sends it again.
  data = applyInkOperations(data, validateInkOperations({ ops: [draw("s1")] }));
  assert.deepEqual(data.strokes.map(s => s.id), ["s2"]);
  assert.deepEqual(data.erased, ["s1"]);
  // The browser's copy follows the same rules.
  const local = applyOps(stateOf(null), [draw("a"), { type: "erase", id: "a" }, draw("a"), draw("b")]);
  assert.deepEqual([...local.strokes.keys()], ["b"]);
});

test("invalid strokes are refused", () => {
  assert.throws(() => validateInkOperations({ ops: [] }));
  assert.throws(() => validateInkOperations({ ops: [{ type: "stroke", stroke: stroke("../x") }] }));
  assert.throws(() => validateInkOperations({ ops: [{ type: "stroke", stroke: stroke("s", { pts: [1, 2] }) }] }));
  assert.throws(() => validateInkOperations({ ops: [{ type: "stroke", stroke: stroke("s", { color: "red" }) }] }));
  assert.throws(() => validateInkOperations({ ops: [{ type: "stroke", stroke: stroke("s", { page: { key: "x", sheet: -1, x: 0, y: 0 } }) }] }));
  assert.equal(inkFileName("Book.json"), "Book.ink.json");
});

test("an outbox batch fits its limit but always takes the first entry", () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({ op: draw("s" + i) }));
  const one = JSON.stringify(entries[0].op).length;
  assert.equal(takeBatch(entries, one * 3.5).length, 3);
  assert.equal(takeBatch(entries, 10).length, 1);
  assert.equal(takeBatch(entries, 1e9, 4).length, 4);
  assert.equal(opKey(draw("s1")), opKey(draw("s1")));
  assert.notEqual(opKey(draw("s1")), opKey({ type: "erase", id: "s1" }));
});

test("cloud ink retries a concurrent commit and keeps the other device's strokes", async () => {
  let data = { strokes: [stroke("other")], erased: [] }, sha = "v1", writes = 0;
  const api = async (url, _token, request) => {
    assert.ok(url.includes("/Book/EPUB%20Notes/Book.ink.json"));
    if (!request) return { sha, encoding: "base64", content: Buffer.from(formatInk(data)).toString("base64") };
    writes++;
    if (writes === 1) {
      data = applyInkOperations(data, [draw("third")]); sha = "v2";
      throw Object.assign(new Error("Conflict"), { status: 409 });
    }
    assert.equal(request.body.sha, "v2");
    data = JSON.parse(Buffer.from(request.body.content, "base64"));
    return {};
  };
  const store = createGitHubInkStore({ owner: "o", repo: "r", branch: "main", token: "t" }, api);
  await store.update("Book.ink.json", { ops: [draw("mine")] });
  assert.deepEqual(data.strokes.map(s => s.id), ["other", "third", "mine"]);
  await store.update("Book.ink.json", { ops: [draw("mine")] });
  assert.equal(writes, 2, "sending a batch again makes no commit");
});

test("a cloud ink file over 1 MB is read from its blob; a missing one is empty", async () => {
  const big = { strokes: [stroke("s1")], erased: [] };
  const store = createGitHubInkStore({ owner: "o", repo: "r", branch: "main", token: "t" }, async url => {
    if (url.includes("/git/blobs/abc")) return { content: Buffer.from(formatInk(big)).toString("base64") };
    return { sha: "abc", encoding: "none", content: "" };
  });
  assert.deepEqual((await store.read("Book.ink.json")).strokes.map(s => s.id), ["s1"]);
  const none = createGitHubInkStore({ owner: "o", repo: "r", branch: "main", token: "t" }, async () => { throw Object.assign(new Error("Missing"), { status: 404 }); });
  assert.deepEqual(await none.read("Book.ink.json"), { strokes: [], erased: [] });
});

test("a local vault keeps a book's handwriting beside its notes, one stroke per line", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "md2book-ink-"));
  const store = createFileInkStore(root);
  await Promise.all([store.update("Book.ink.json", { ops: [draw("s1")] }), store.update("Book.ink.json", { ops: [draw("s2"), { type: "erase", id: "s1" }] })]);
  const file = path.join(root, "Book", "EPUB Notes", "Book.ink.json");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(saved.strokes.map(s => s.id), ["s2"]);
  assert.deepEqual(saved.erased, ["s1"]);
  assert.equal(fs.readFileSync(file, "utf8").split("\n").filter(line => line.startsWith('{"id"')).length, 1);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["Book.ink.json"]);
});
