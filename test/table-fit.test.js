// Tests for static/table-fit.js — the parts that don't need a browser:
// splitting text into unbreakable pieces, spotting number columns,
// minimum column widths, and the width search, run against a simple
// model of how text wraps in a cell (a fixed width per character).
import { test } from "node:test";
import assert from "node:assert/strict";
import "../static/table-fit.js";

const {
  tokens, isNumeric, isNumericColumn, columnStats, minimumWidths, balancedWidths, respectMinimums, searchWidths, isImprovement
} = globalThis.md2bookTableFit;

// The model: every character is `CH` pixels wide (CJK characters twice
// that), a line is `LH` pixels tall, cells have `PAD` pixels of padding.
const CH = 6;
const LH = 14;
const PAD = 8;
const FONT = 10;
const CJK = /[　-〿一-鿿＀-￯]/;
const textWidth = text => Array.from(text).reduce((w, c) => w + (CJK.test(c) ? 2 * CH : CH), 0);

// Lines a cell's text takes at `width` (greedy wrapping of its pieces),
// or Infinity if a piece that mustn't break doesn't fit.
function lines(text, width) {
  const room = width - PAD;
  let count = 1;
  let line = 0;
  for (const piece of tokens(text)) {
    let w = textWidth(piece.text);
    if (w > room) {
      if (!piece.url) return Infinity;
      count += Math.ceil(w / room) - 1;
      w = w % room;
    }
    const gap = line && !CJK.test(piece.text) ? CH : 0;
    if (line + gap + w > room) {
      count++;
      line = w;
    } else {
      line += gap + w;
    }
  }
  return count;
}

function model(header, rows, total = Infinity) {
  const columns = header.map((h, j) => ({ header: h, cells: rows.map(r => r[j]), padding: PAD, fontSize: FONT }));
  const measure = widths => {
    let height = 0;
    for (const row of [header, ...rows]) {
      const tallest = Math.max(...row.map((text, j) => lines(text, widths[j])));
      if (!Number.isFinite(tallest)) return null;
      height += tallest * LH;
    }
    // Headers stay within two lines.
    if (header.some((h, j) => lines(h, widths[j]) > 2)) return null;
    return height;
  };
  return { columns, measure, mins: minimumWidths(columns, textWidth, total), stats: columnStats(columns, textWidth) };
}

// What fitTable does, with the model in place of the browser: start from
// the browser's widths or balanced ones, whichever is shorter (balanced
// when within half a line), search on, and keep it if it's better.
function fit(header, rows, total, nativeWidths) {
  const m = model(header, rows, total);
  const fromNative = respectMinimums(nativeWidths, m.mins, total);
  const balanced = balancedWidths(m.stats, m.mins, total);
  const hn = m.measure(fromNative);
  const hb = m.measure(balanced);
  const start = hb !== null && (hn === null || hb <= hn + LH / 2) ? balanced : fromNative;
  const nativeHeight = m.measure(nativeWidths) ?? Infinity;
  const nativeReadable = Number.isFinite(nativeHeight) && nativeWidths.every((w, j) => w >= m.mins[j] - 1.5);
  const result = searchWidths({ start, mins: m.mins, measure: m.measure, step: Math.max(4, Math.round(total * 0.04)) });
  const accepted = isImprovement({ nativeHeight, nativeReadable, height: result.height, lineHeight: LH });
  return { ...m, start, nativeHeight, result, accepted };
}

const sum = a => a.reduce((x, y) => x + y, 0);

test("pieces: words, CJK characters one by one, URLs", () => {
  assert.deepEqual(tokens("two words").map(t => t.text), ["two", "words"]);
  assert.deepEqual(tokens("中文字").map(t => t.text), ["中", "文", "字"]);
  assert.deepEqual(tokens("HCI，还有 model").map(t => t.text), ["HCI", "，", "还", "有", "model"]);
  assert.equal(tokens("https://example.com/a/very/long/path")[0].url, true);
  assert.equal(tokens("short")[0].url, false);
});

test("a definition column isn't starved by a longer examples column", () => {
  // The example that prompted the prose rule: the browser gives Examples
  // most of the width, leaving Definition a word or two per line.
  const header = ["Type", "Affordance", "Definition", "Examples"];
  const rows = [
    ["Highlighter", "Look", "Emphasizes the physical referent itself without introducing new UI.", "Ice cream melting behind the user; passport and keys as the user prepares to leave; which glass of beer at a party is mine."],
    ["Explainer", "Read", "Attaches situated information to the referent or its parts.", "A camera with many modes: each mode on the dial is annotated when the user hesitates, and the user can open any one for detail."],
    ["Utility", "Operate locally", "An interactive tool whose state and results stay within the widget.", "Measurement: a level and edge distances appear on a picture frame held against the wall. Timer: a clamped part carries its own curing countdown (unclamp at 14:20); a freshly painted wall shows when the second coat can go on."]
  ];
  const total = 550;
  const r = fit(header, rows, total, [80, 75, 119, 276]);
  assert.ok(r.stats[2].prose && r.stats[3].prose);
  assert.ok(r.mins[2] >= 20 * CH + PAD, "definitions get at least 20 characters a line");
  assert.equal(r.accepted, true);
  assert.ok(r.result.widths[2] >= 20 * CH + PAD - 0.01);
  assert.ok(r.result.height <= r.nativeHeight, "and the table is no taller");
  assert.ok(r.result.widths[3] >= r.mins[3] - 0.01);
});

test("balanced widths follow the text, capped at one line", () => {
  const m = model(["A", "B"], [["short", "a much longer piece of text in this column than the other"]], 400);
  const w = balancedWidths(m.stats, m.mins, 400);
  assert.ok(Math.abs(sum(w) - 400) < 0.5);
  assert.ok(w[1] > w[0]);
  // "short" fits on one line, so column A doesn't get more than that
  // before the leftover is spread.
  assert.ok(w[0] < 200);
});

test("the search stays within its measurement budget", () => {
  let calls = 0;
  const measure = w => { calls++; return 1000 - w[0] + (w[1] % 7); };
  searchWidths({ start: [100, 100, 100], mins: [10, 10, 10], measure, step: 4 });
  assert.ok(calls <= 60, `${calls} measurements`);
});

test("numbers, amounts, dates and times count as numeric", () => {
  for (const t of ["42", "3.14", "1,234", "-5", "12%", "$9.99", "2026-09-30", "12:30", "(3)", "5年"]) assert.ok(isNumeric(t), t);
  for (const t of ["abc", "Low", "中文", ""]) assert.ok(!isNumeric(t), t);
  assert.ok(isNumericColumn(["1", "2", "3.5", "40%"]));
  assert.ok(!isNumericColumn(["1", "two", "three"]));
});

test("minimums: longest word, whole numbers, capped URLs, one CJK character", () => {
  const { mins } = model(
    ["Name", "Amount", "Link", "说明"],
    [["Extraordinarily", "1,234,567.89", "https://example.com/a/very/long/path/that/goes/on", "很长的中文说明文字"]]
  );
  assert.equal(mins[0], textWidth("Extraordinarily") + PAD);
  assert.equal(mins[1], textWidth("1,234,567.89") + PAD);
  assert.equal(mins[2], 8 * FONT + PAD); // a URL only asks for a fair share
  assert.equal(mins[3], 3 * FONT + PAD); // CJK breaks anywhere: the floor applies
});

test("a short table the browser already sets well keeps its widths", () => {
  const header = ["Type", "Level"];
  const rows = [["Highlighter", "Low"], ["Explainer", "Mid"], ["Utility", "High"]];
  const r = fit(header, rows, 300, [150, 150]);
  assert.equal(r.accepted, false);
});

test("a long text column takes width from short ones", () => {
  const header = ["Type", "Affordance", "Definition"];
  const text = "Emphasizes the physical referent itself without introducing new interface elements to the scene";
  const rows = [["Highlighter", "Look", text], ["Explainer", "Read", text], ["Utility", "Operate", text]];
  const total = 320;
  const r = fit(header, rows, total, [107, 107, 106]);
  assert.equal(r.accepted, true);
  assert.ok(r.result.height < r.nativeHeight);
  assert.ok(r.result.widths[2] > 106, "the text column grew");
  r.result.widths.forEach((w, j) => assert.ok(w >= r.mins[j] - 0.01, `column ${j} kept its minimum`));
  assert.ok(Math.abs(sum(r.result.widths) - total) < 0.5, "widths still add up to the table");
});

test("a numbers column never wraps its numbers", () => {
  const header = ["Item", "Total"];
  const rows = [
    ["A description long enough to want most of the width for itself", "1,234,567.89"],
    ["Another long description that would happily squeeze the numbers", "12,345.00"]
  ];
  const r = fit(header, rows, 260, [130, 130]);
  assert.ok(r.result.widths[1] >= textWidth("1,234,567.89") + PAD - 0.01);
  assert.equal(lines("1,234,567.89", r.result.widths[1]), 1);
});

test("a long URL column is capped instead of taking the table", () => {
  const header = ["Source", "Link"];
  const rows = [["Muse", "https://ai.meta.com/muse/and/a/very/long/path/indeed/that/goes/on/and/on"], ["Satori", "https://doi.org/10.1145/3706598.3714188"]];
  const r = fit(header, rows, 240, [120, 120]);
  assert.ok(r.mins[1] <= 8 * FONT + PAD);
  assert.notEqual(r.result.height, null);
  assert.ok(r.result.widths[0] >= r.mins[0] - 0.01);
});

test("Chinese and mixed tables fit like any other", () => {
  const header = ["类型", "说明"];
  const rows = [
    ["高亮", "强调物理对象本身，而不引入新的界面元素，例如 highlighter 在 AR 中的用法"],
    ["解释", "在对象或其部件上附加情境信息，用户犹豫时显示 explainer"]
  ];
  const r = fit(header, rows, 280, [140, 140]);
  assert.equal(r.accepted, true);
  assert.ok(r.result.widths[1] > r.result.widths[0]);
  assert.ok(r.result.height < r.nativeHeight);
});

test("minimums that can't fit leave the browser's widths alone", () => {
  assert.equal(respectMinimums([100, 100], [150, 150], 200), null);
});

test("the search measures each set of widths once", () => {
  let calls = 0;
  const measure = w => { calls++; return Math.abs(w[0] - 150) + 100; };
  const r = searchWidths({ start: [100, 100], mins: [20, 20], measure, step: 8 });
  assert.equal(r.measured, calls);
});

test("only a clear gain replaces the browser's layout", () => {
  assert.equal(isImprovement({ nativeHeight: 200, nativeReadable: true, height: 195, lineHeight: 14 }), false);
  assert.equal(isImprovement({ nativeHeight: 200, nativeReadable: true, height: 180, lineHeight: 14 }), true);
  assert.equal(isImprovement({ nativeHeight: 200, nativeReadable: false, height: 205, lineHeight: 14 }), true);
  assert.equal(isImprovement({ nativeHeight: 200, nativeReadable: true, height: null, lineHeight: 14 }), false);
  // The browser's own table was wider than allowed (an unbreakable URL):
  // readable widths win even if taller.
  assert.equal(isImprovement({ nativeHeight: 200, nativeReadable: false, nativeOverflows: true, height: 260, lineHeight: 14 }), true);
});
