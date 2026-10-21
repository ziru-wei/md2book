// The home page: the library's shelves (EPUB / PDF), the writing shelves
// (a volume per output collection), the latest notes, a search and the
// list of every note. The data is embedded by lib/render.js (renderHomePage).
//
// The 3D books are after simpleshelf (https://github.com/kat3samsin/simpleshelf,
// MIT): a spine that turns to show its cover, a thickness set by length.
(function () {
  "use strict";
  // The server tells the page to reload when notes or settings change. While the
  // settings panel is open that would close it on every change, so it waits
  // (the page is reloaded when the panel is closed). The page's own script
  // that listens comes after this one, so the guard goes around EventSource.
  if (window.EventSource) {
    const Native = window.EventSource;
    window.EventSource = class extends Native {
      addEventListener(type, listener, options) {
        if (type === "reload") {
          const inner = listener;
          listener = function (event) { if (!window.md2bookHoldReload) return inner.call(this, event); };
        }
        return super.addEventListener(type, listener, options);
      }
    };
  }
  const D = JSON.parse(document.getElementById("home-data").textContent);
  const root = document.getElementById("home");
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  // The language of the settings page (it sets the choice), else the browser's.
  let lang = "en";
  try { lang = localStorage.getItem("md2book-settings-lang") || (navigator.language.startsWith("zh") ? "zh" : "en"); } catch { /* storage unavailable */ }
  const two = n => String(n).padStart(2, "0");
  // Months in the formal (大写) numerals, as on a cheque or a title page.
  const ZH_MON = ["壹月", "貳月", "參月", "肆月", "伍月", "陸月", "柒月", "捌月", "玖月", "拾月", "拾壹月", "拾貳月"];
  const TEXT = {
    en: {
      library: "Input", writing: "Output", leaves: "Single notes", allNotes: "All notes", back: "Back", all: "All", unfiled: "unfiled",
      search: "Search notes and books", settings: "Settings", close: "Close", notes: "Notes", books: "Books",
      opening: "Opening", opened: "Open",
      steps: { epub: ["Opening the book", "Downloading the file", "Reading the contents", "Laying out the pages"], vol: ["Gathering the notes", "Loading fonts and images", "Laying out the pages"] },
      none: q => `Nothing matches “${q}”.`,
      empty: e => `No published notes yet${e.require ? `. Add ${e.require}: ... to a note's frontmatter to publish it` : ""} (source: ${e.source}).`,
      mon: m => MON[m], date: (m, d, y) => `${MON[m]} ${two(d)}${y ? ", " + y : ""}`, month: (m, y) => `${MON[m]} ${y}`
    },
    zh: {
      library: "输入", writing: "输出", leaves: "单篇笔记", allNotes: "全部笔记", back: "返回", all: "全部", unfiled: "未归档",
      search: "搜索笔记和书", settings: "设置", close: "关闭", notes: "笔记", books: "书",
      opening: "正在打开", opened: "已打开",
      steps: { epub: ["打开书页", "下载文件", "读取目录", "排版"], vol: ["读取笔记", "加载字体和图片", "排版"] },
      none: q => `没有找到“${q}”。`,
      empty: e => `还没有已发布的笔记${e.require ? `。在笔记的 frontmatter 里加上 ${e.require}: ... 即可发布` : ""}（来源：${e.source}）。`,
      mon: m => ZH_MON[m], date: (m, d, y) => `${ZH_MON[m]} ${two(d)}${y ? ", " + y : ""}`, month: (m, y) => `${ZH_MON[m]} ${y}`
    }
  }[lang === "zh" ? "zh" : "en"];
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  const S = { folded: (() => { try { return localStorage.getItem("md2book-home-singles-folded") === "1"; } catch { return false; } })(), view: "home", tab: "library", open: null, filter: {}, q: "", sopen: false, allf: null, hits: null, reading: null };

  const esc = s => String(s ?? "").replace(/[&<>"]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[m]);
  const hash = s => { let h = 7; for (const c of String(s)) h = (h * 31 + c.codePointAt(0)) >>> 0; return h; };
  const ARROW = '<svg class="ic s" viewBox="0 0 24 24"><path d="M7 7h10v10"/><path d="M7 17 17 7"/></svg>';
  const ICON = {
    search: '<svg class="ic" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
    gear: '<svg class="ic" viewBox="0 0 24 24"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>',
    back: '<svg class="ic" viewBox="0 0 24 24"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>'
  };

  // ---- dates: "Oct 18", with the year when it isn't this one ----
  const thisYear = new Date().getFullYear();
  function parseDate(s) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
  function dlabel(s, withYear) {
    const d = parseDate(s);
    if (!d) return "";
    return TEXT.date(d.getMonth(), d.getDate(), withYear && d.getFullYear() !== thisYear ? d.getFullYear() : 0);
  }

  // A note's date. In a list newest first, only the latest note of each month
  // carries its month; the rest are blank there (kept as space, so days line up).
  function dcell(n, prev, withYear) {
    const d = parseDate(n.date);
    if (!d) return '<span class="d"></span>';
    const p = prev && parseDate(prev.date);
    if (p && p.getFullYear() === d.getFullYear() && p.getMonth() === d.getMonth()) return `<span class="d"><span style="visibility:hidden">${TEXT.mon(d.getMonth())}</span> ${two(d.getDate())}</span>`;
    return `<span class="d">${dlabel(n.date, withYear)}</span>`;
  }

  // A newest-first list in `cols` columns, each column showing its first note's month.
  function columnsHtml(list, cols, row) {
    const per = Math.ceil(list.length / cols);
    return Array.from({ length: cols }, (_, c) => list.slice(c * per, (c + 1) * per)).filter(l => l.length)
      .map(l => `<div>${l.map((n, i) => row(n, l[i - 1])).join("")}</div>`).join("");
  }

  // ---- books ----
  const PAL = [["#2f3d4f", "#e8ebee"], ["#6b2f33", "#f0e3e0"], ["#b9a67c", "#2a2418"], ["#4d5a4a", "#e9ede6"], ["#d9d3c3", "#2b2b2b"], ["#2b2d30", "#e6e6e6"], ["#8a5a3c", "#f5ebe0"], ["#7d8a95", "#14181b"], ["#a69f93", "#1f1d19"], ["#3a4a45", "#dce6e2"]];
  const spineColor = b => SPINES[hash(b.title) % SPINES.length];
  const SPINES = ["#3b4a57", "#5a3a3e", "#46533f", "#6b5b45", "#3f4a4e", "#554a5e", "#2f3b3a", "#4d4f58"];
  const FOIL = "#e4d8b8";

  // A book's size. Its height is a random (but fixed) 150-208px. Its thickness
  // follows its length, the square root of its words: a short paper is a slim
  // booklet, a long novel a brick, nothing hairline or absurd (a collection's
  // volume is a little slimmer). A title or author too long for the height wraps
  // onto more columns, and the spine is thick enough to hold them.
  const run = (t, cjk, lat) => [...t].reduce((n, c) => n + (/[\u3000-\u9fff\uff00-\uffef]/.test(c) ? cjk : lat), 0);
  // `text` cut to fit `cap` px of a column's length (with an ellipsis).
  const cut = (text, cjk, lat, cap) => {
    let n = 0, out = "";
    for (const c of text) { n += run(c, cjk, lat); if (n > cap) return out.trimEnd() + "…"; out += c; }
    return text;
  };
  function size(b) {
    if (b.dims) return b.dims;
    const vol = b.kind === "vol";
    const h = 150 + hash(b.title + "h") % 59, room = h - 30;
    // At most three columns of title and two of author, however long they are.
    b.shownTitle = cut(b.title, 12.4, 6.6, room * 3 - 16);
    b.shownAuthor = vol || !b.author ? "" : cut(b.author, 10, 5.3, room * 2 - 12);
    const titleCols = Math.max(1, Math.ceil(run(b.shownTitle, 12.4, 6.6) / room));
    const authorCols = b.shownAuthor ? Math.max(1, Math.ceil(run(b.shownAuthor, 10, 5.3) / room)) : 0;
    const byLength = vol ? Math.max(22, Math.min(50, Math.round(10 + 0.055 * Math.sqrt(b.words)))) : Math.max(26, Math.min(70, Math.round(12 + 0.085 * Math.sqrt(b.words))));
    return (b.dims = { h, room, w: Math.max(byLength, titleCols * 15 + authorCols * 12 + 10) });
  }
  const thickness = b => size(b).w;
  // The space after a book: a little, never the same twice; collections stand further apart.
  const gapOf = b => b.kind === "vol" ? 22 + hash(b.title + "g") % 10 : 11 + hash(b.title + "g") % 8;

  // A book's spine colour: the palette colour that covers most of its cover
  // (worked out once the cover has loaded, and remembered), else one by its title.
  let spineOf = {};
  try { spineOf = JSON.parse(localStorage.getItem("md2book-home-spines-2")) || {}; } catch { /* no storage */ }
  const book = b => ({ kind: "book", id: "b:" + b.id, title: b.title, author: b.author, words: b.words, href: b.href, cover: b.cover, fmt: b.fmt, c: PAL[spineOf[b.id] ?? hash(b.title) % PAL.length] });
  const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  // Darker by a little: a cover drawn here, not the book's own, sits a touch below its spine.
  const shade = (h, k) => "#" + hex(h).map(v => Math.round(v * k).toString(16).padStart(2, "0")).join("");
  // Hue (0-360) and saturation of a colour.
  function hueOf([r, g, b]) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (!d) return { h: 0, s: 0 };
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return { h: (h * 60 + 360) % 360, s: d / max };
  }
  // The palette colour nearest in hue (never in lightness) to most of the cover;
  // greys, whites and blacks have no hue and don't count. -1: no colour to go by.
  function dominant(img) {
    const size = 40, canvas = document.createElement("canvas");
    canvas.width = size; canvas.height = Math.round(size * img.naturalHeight / img.naturalWidth) || size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data, count = PAL.map(() => 0);
    const palHue = PAL.map(p => hueOf(hex(p[0])));
    let colourful = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] < 128) continue;
      const { h, s } = hueOf([px[i], px[i + 1], px[i + 2]]), v = Math.max(px[i], px[i + 1], px[i + 2]) / 255;
      if (s < 0.18 || v < 0.15) continue;
      colourful++;
      let best = -1, dist = Infinity;
      palHue.forEach((p, k) => { if (p.s < 0.08) return; const d = Math.min(Math.abs(p.h - h), 360 - Math.abs(p.h - h)); if (d < dist) { dist = d; best = k; } });
      if (best >= 0) count[best]++;
    }
    return colourful < px.length / 4 * 0.04 ? -1 : count.indexOf(Math.max(...count));
  }
  function paintFromCovers() {
    D.books.forEach(b => {
      if (!b.cover || spineOf[b.id] !== undefined) return;
      const img = new Image();
      img.onload = () => {
        try { const k = dominant(img); if (k < 0) return; spineOf[b.id] = k; localStorage.setItem("md2book-home-spines-2", JSON.stringify(spineOf)); } catch { return; }
        const [bg, fg] = PAL[spineOf[b.id]];
        const el = root.querySelector(`.ss-book[data-id="${CSS.escape("b:" + b.id)}"]`);
        if (!el) return;
        const spine = el.querySelector(".ss-spine"), cover = el.querySelector(".ss-cover");
        spine.style.backgroundColor = bg; spine.style.color = fg; cover.style.borderColor = bg;
      };
      img.src = b.cover;
    });
  }
  const volume = c => ({ kind: "vol", id: "v:" + c.name, title: c.name.split("/").pop(), name: c.name, words: c.words, href: c.href, layout: c.layout });

  // A cover when there's no image: type on a coloured card (black cloth for a collection).
  function coverArt(b) {
    const vol = b.kind === "vol";
    const [c, f] = vol ? [shade(spineColor(b), .86), FOIL] : [shade(b.c[0], .86), b.c[1]];
    const x = vol ? 26 : 18, room = 170 - x - 14, t = b.title, cjk = /[\u3400-\u9fff]/.test(t);
    // The title in the largest type (17px down to 11px) whose words each fit
    // the cover's width; a word longer than that is broken.
    const width = (str, fs) => [...str].reduce((n, c) => n + (/[\u3000-\u9fff\uff00-\uffef]/.test(c) ? fs : fs * 0.62), 0);
    const wrap = fs => {
      const out = []; let cur = "";
      for (const w of (cjk ? [...t] : t.split(" "))) {
        const sep = cjk ? "" : " ";
        if (width(w, fs) > room) {
          for (const ch of w) { if (width(cur + ch, fs) > room && cur) { out.push(cur); cur = ch; } else cur += ch; }
        } else if (width(cur + sep + w, fs) > room && cur) { out.push(cur); cur = w; } else cur = cur ? cur + sep + w : w;
      }
      out.push(cur);
      return out;
    };
    let fs = 17, lines = wrap(fs);
    while (fs > 11 && (lines.length > 4 || t.split(" ").some(w => width(w, fs) > room))) { fs--; lines = wrap(fs); }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="170" height="240" viewBox="0 0 170 240"><rect width="170" height="240" fill="${c}"/>${vol ? `<rect x="8" y="8" width="154" height="224" fill="none" stroke="${f}" stroke-opacity=".35"/>` : ""}${lines.map((l, i) => `<text x="${x}" y="${(vol ? 70 : 44) + i * Math.round(fs * 1.3)}" font-family="Georgia,'Songti SC',serif" font-size="${fs}" font-weight="600" fill="${f}">${esc(l)}</text>`).join("")}<text x="${x}" y="224" font-family="Georgia,serif" font-size="11" fill="${f}" opacity=".7">${esc(vol ? b.layout : b.author)}</text></svg>`;
    return "data:image/svg+xml;utf8," + encodeURIComponent(svg).replace(/'/g, "%27").replace(/\(/g, "%28").replace(/\)/g, "%29");
  }
  const cssUrl = u => "url('" + u.replace(/['()]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase()) + "')";

  // Every book on the shelves, by id (for opening one).
  const items = new Map();
  function bookEl(b) {
    const { w, h, room } = size(b), gap = gapOf(b), vol = b.kind === "vol";
    const [bg, fg] = vol ? [spineColor(b), FOIL] : b.c;
    const inner = vol
      ? `<span class="ss-title" style="max-height:${room}px">${esc(b.shownTitle)}</span>`
      : `<span class="ss-title" style="max-height:${room}px">${esc(b.shownTitle)}</span>${b.shownAuthor ? `<span class="ss-au" style="max-height:${room}px">${esc(b.shownAuthor)}</span>` : ""}${b.progress > 0 && b.progress < 1 ? '<i class="ss-rib"></i>' : ""}`;
    const cover = cssUrl(b.cover || coverArt(b));
    items.set(b.id, b);
    return `<a class="ss-book ${S.open === b.id ? "open" : ""} ${S.reading === b.id ? "taken" : ""}" data-id="${esc(b.id)}" href="${esc(b.href)}" style="width:${w}px;height:${h}px;margin-right:${gap}px">
      <div class="ss-3d"><div class="ss-spine ${vol ? "out" : ""}" style="background-color:${bg};color:${fg}">${inner}</div><div class="ss-cover" style="background-image:${cover};border-color:${bg}"></div></div></a>`;
  }

  // ---- shelves: one per folder that holds books, however deep the folders go ----
  const N = (name, items = [], kids = []) => ({ name, items, kids });
  function insert(top, path, item) {
    let node = top;
    for (const seg of path) { let kid = node.kids.find(k => k.name === seg); if (!kid) node.kids.push(kid = N(seg)); node = kid; }
    node.items.push(item);
  }
  function shelvesOf(node, path = [], out = []) {
    if (node.items.length) out.push({ path, items: node.items });
    node.kids.forEach(k => shelvesOf(k, [...path, k.name], out));
    return out;
  }
  const total = node => shelvesOf(node).reduce((n, s) => n + s.items.length, 0);

  // Folders with only a few books share one case, each tagged with its name.
  function casesOf(paths) {
    const tops = new Map();
    for (const [path, item] of paths) {
      const key = path[0] || "";
      if (!tops.has(key)) tops.set(key, N(key));
      insert(tops.get(key), path.slice(1), item);
    }
    const nodes = [...tops.values()].sort((a, b) => a.name.localeCompare(b.name));
    const big = nodes.filter(n => total(n) > 6), few = nodes.filter(n => total(n) <= 6);
    const merged = N("");
    few.forEach(n => { if (n.name) merged.kids.push(n); else { merged.items.push(...n.items); merged.kids.push(...n.kids); } });
    return [...big, ...(few.length ? [merged] : [])];
  }

  function chunkRows(items, avail) {
    const rows = []; let row = [], used = 0;
    for (const b of items) { const w = thickness(b) + gapOf(b); if (used + w > avail && row.length) { rows.push(row); row = []; used = 0; } row.push(b); used += w; }
    if (row.length) rows.push(row);
    return rows;
  }

  function drawerHtml(v) {
    const notes = D.notes.filter(n => (n.collections || []).includes(v.name));
    // A centred year where the year changes: the newest year needs none, the
    // dates under a year don't repeat it.
    let year = notes.length ? (parseDate(notes[0].date) || new Date(thisYear, 0, 1)).getFullYear() : thisYear;
    const items = notes.map((n, i) => {
      const y = (parseDate(n.date) || new Date(thisYear, 0, 1)).getFullYear();
      const head = y !== year ? `<li class="yr">${y}</li>` : "";
      year = y;
      return head + `<li><a class="it" href="${esc(n.href)}">${dcell(n, notes[i - 1])}<span class="t">${esc(n.title)}</span></a></li>`;
    }).join("");
    return `<div class="drawer"><a class="dh" href="${esc(v.href)}"><span>${esc(v.title)}</span>${ARROW}</a>
      <div class="dlw"><div class="dl"><ul>${items}</ul></div></div></div>`;
  }

  // A shelf is never wider than this, however wide the page: more books wrap onto another shelf.
  const SHELF_MAX = 700;
  // Space between the groups of a shelf (a divider stands in the middle of it).
  const SEP = 88;
  function caseHtml(node, pageWidth, filterable) {
    const avail = Math.min(pageWidth, SHELF_MAX);
    const shelves = shelvesOf(node);
    if (!shelves.length) return "";
    const name = node.name, filter = S.filter[name];
    const vis = filter ? shelves.filter(s => s.path.join("/").startsWith(filter)) : shelves;
    // Filter chips only where there are enough shelves to filter (Input, with
    // folders inside folders): Output's books are few and carry their own names.
    const chips = filterable && shelves.length > 2 ? (() => {
      const paths = new Set();
      shelves.forEach(s => s.path.forEach((_, i) => paths.add(s.path.slice(0, i + 1).join("/"))));
      return `<span class="chips"><button class="chip ${!filter ? "on" : ""}" data-case="${esc(name)}" data-f="">${TEXT.all}</button>${[...paths].map(p => { const d = p.split("/").length - 1; return `<button class="chip ${filter === p ? "on" : ""}" data-case="${esc(name)}" data-f="${esc(p)}">${esc(p.split("/").pop())}${d ? `<span class="d">${"›".repeat(d)}</span>` : ""}</button>`; }).join("")}</span>`;
    })() : "";

    // Each folder's books are a group; groups share boards, apart by a divider, labelled by path.
    const groups = vis.flatMap(s => chunkRows(s.items, avail).map((c, i) => ({ path: s.path, items: c, label: i === 0 })));
    groups.forEach(g => {
      g.lab = g.label && (g.path.length || shelves.length > 1) ? (g.path.length ? g.path.slice(-2).join(" › ") : name) : "";
      // A volume alone under a label that only repeats its own spine needs no label.
      const last = g.path.length ? g.path[g.path.length - 1] : name;
      if (g.items.length === 1 && g.items[0].kind === "vol" && g.items[0].title === last) g.lab = "";
      g.lw = g.lab ? Math.ceil(g.lab.length * 8 + 6) : 0;
    });
    const gw = g => Math.max(g.lw, g.items.reduce((n, b) => n + thickness(b) + gapOf(b), 0));
    const rows = []; let cur = [], used = 0;
    groups.forEach(g => { const w = gw(g) + (cur.length ? SEP : 0); if (used + w > avail && cur.length) { rows.push(cur); cur = []; used = 0; } cur.push(g); used += w; });
    if (cur.length) rows.push(cur);
    const frameW = Math.max(...rows.map(r => r.reduce((n, g) => n + gw(g), 0) + SEP * (r.length - 1))) + 120;
    const rowsHtml = rows.map(row => {
      const open = row.flatMap(g => g.items).find(b => S.open === b.id);
      return `<div class="shelf"><div class="row">${row.map((g, gi) => `<div class="grp ${gi ? "sep" : ""}" style="min-width:${g.lw}px">${g.items.map(bookEl).join("")}${g.lab ? `<span class="tag">${esc(g.lab).replace(/ › /g, "<i>›</i>")}</span>` : ""}</div>`).join("")}</div><div class="board"></div>${open && open.kind === "vol" ? drawerHtml(open) : ""}</div>`;
    }).join("");
    return `<div class="case"><div class="case-head">${name ? `<h3>${esc(name)}</h3>` : ""}${chips}</div><div class="frame" style="width:${frameW}px">${rowsHtml}</div></div>`;
  }

  // ---- single notes: the last 30 days, a part of Output that folds ----
  // A newest-first list as one list per month.
  function byMonth(list) {
    const out = [];
    list.forEach(n => {
      const d = parseDate(n.date), key = d ? d.getFullYear() + "-" + d.getMonth() : "";
      if (!out.length || out[out.length - 1].key !== key) out.push(Object.assign([], { key }));
      out[out.length - 1].push(n);
    });
    return out;
  }
  function leavesHtml(width) {
    const since = new Date(); since.setDate(since.getDate() - 30);
    const recent = D.notes.filter(n => { const d = parseDate(n.date); return d && d >= since; });
    if (!recent.length) return "";
    const open = !S.folded;
    return `<div class="zone-head"><button type="button" class="subhead" data-fold aria-expanded="${open}"><span class="bs">\\</span>${TEXT.leaves}<span class="tri">${open ? "▼" : "▶"}</span></button><a class="alllink" href="#" data-all>${TEXT.allNotes} ${ARROW}</a></div>
      <div class="lv-list" style="margin-top:22px" ${open ? "" : "hidden"}>${byMonth(recent).map(l => `<div>${l.map((n, i) => `<a class="it" href="${esc(n.href)}">${dcell(n, l[i - 1])}<span>${esc(n.title)}</span><span class="c">${esc(n.collection || "")}</span></a>`).join("")}</div>`).join("")}</div>`;
  }

  // ---- all notes, by month ----
  function allHtml(width) {
    const cols = [...new Set(D.notes.map(n => n.collection || ""))].sort();
    const list = D.notes.filter(n => S.allf === null || (n.collection || "") === S.allf);
    const years = list.some(n => { const d = parseDate(n.date); return d && d.getFullYear() !== thisYear; });
    const ncols = Math.max(1, Math.min(2, Math.floor((width + 44) / 420)));
    const body = columnsHtml(list, ncols, (n, prev) => `<a class="it" href="${esc(n.href)}">${dcell(n, prev, true)}<span>${esc(n.title)}</span><span class="c">${esc(n.collection || "")}</span></a>`);
    return `<div class="chips all-chips"><button class="chip ${S.allf === null ? "on" : ""}" data-allf="*">${TEXT.all}</button>${cols.map(c => `<button class="chip ${S.allf === c ? "on" : ""}" data-allf="${esc(c)}">${esc(c || TEXT.unfiled)}</button>`).join("")}</div><div class="all-list ${years ? "has-years" : ""}" style="grid-template-columns:repeat(${ncols},1fr)">${body}</div>`;
  }

  // ---- search: notes (title, or text by the server) and books ----
  function searchHtml() {
    const q = S.q.trim().toLowerCase();
    if (!q) return "";
    const hi = t => { const i = t.toLowerCase().indexOf(q); return i < 0 ? esc(t) : esc(t.slice(0, i)) + "<mark>" + esc(t.slice(i, i + q.length)) + "</mark>" + esc(t.slice(i + q.length)); };
    const notes = D.notes.filter(n => n.title.toLowerCase().includes(q) || (S.hits && S.hits.has(n.slug))).slice(0, 8);
    const books = D.books.filter(b => (b.title + " " + b.author).toLowerCase().includes(q)).slice(0, 5);
    return (notes.length ? `<h6>${TEXT.notes}</h6>` + notes.map(n => `<a class="it" href="${esc(n.href)}"><span class="d">${dlabel(n.date, true)}</span><span>${hi(n.title)}</span><span class="c">${esc(n.collection || "")}</span></a>`).join("") : "")
      + (books.length ? `<h6>${TEXT.books}</h6>` + books.map(b => `<a class="it" href="${esc(b.href)}"><span class="d">${esc(b.fmt)}</span><span>${hi(b.title)}</span><span class="c">${esc(b.author)}</span></a>`).join("") : "")
      || `<div class="none">${esc(TEXT.none(S.q))}</div>`;
  }
  function updateSearch() {
    const sr = document.getElementById("sr");
    if (!sr) return;
    const html = searchHtml();
    sr.innerHTML = html;
    sr.classList.toggle("on", Boolean(html));
  }
  let searchTimer = 0, asked = 0;
  function askServer() {
    clearTimeout(searchTimer);
    const q = S.q.trim();
    if (!q || !D.searchPath) { S.hits = null; return; }
    searchTimer = setTimeout(() => {
      const n = ++asked;
      fetch(D.searchPath + "?q=" + encodeURIComponent(q)).then(r => r.json()).then(slugs => { if (n === asked && Array.isArray(slugs)) { S.hits = new Set(slugs); updateSearch(); } }).catch(() => {});
    }, 150);
  }

  // ---- the page ----
  function render() {
    const avail = Math.min(920, root.clientWidth || window.innerWidth - 48) - 58;
    const links = (D.links || []).map(l => `<a class="alllink" href="${esc(l.href)}" title="${esc(l.title || "")}">${esc(l.text)}</a>`).join("");
    const tools = `<div class="tools">${links}<div class="sbox ${S.q || S.sopen ? "open" : ""}"><input id="q" type="text" placeholder="${TEXT.search}" autocomplete="off" value="${esc(S.q)}" /><button class="ib" data-search aria-label="${TEXT.search}">${ICON.search}</button></div>
      ${D.settingsPath ? (D.floatingSettings ? `<button class="ib gearb" data-settings aria-label="${TEXT.settings}">${ICON.gear}</button>` : `<a class="ib gearb" href="${esc(D.settingsPath)}" aria-label="${TEXT.settings}">${ICON.gear}</a>`) : ""}
      <div class="sr" id="sr"></div></div>`;
    if (S.view === "all") {
      root.innerHTML = `<header class="top"><a class="back" href="#" data-back>${ICON.back}${TEXT.back}</a>${tools}</header>${allHtml(avail + 58)}`;
      updateSearch();
      return;
    }
    const lib = casesOf(D.books.map(b => [b.folder ? b.folder.split("/") : [], book(b)])).map(n => caseHtml(n, avail, true)).join("");
    // A collection is a book on a shelf; those with no folder above them come
    // first, then one group per folder (named under it), apart by a divider.
    const outRoot = N("");
    D.collections.forEach(c => insert(outRoot, c.name.split("/").slice(0, -1), volume(c)));
    const out = caseHtml(outRoot, avail, false);
    if (!lib && !out && !D.notes.length) {
      root.innerHTML = `<header class="top"><div class="brand">${esc(D.title)}</div>${tools}</header><p class="empty">${esc(TEXT.empty(D.empty))}</p>`;
      updateSearch();
      return;
    }
    if (!lib) S.tab = "writing";
    root.innerHTML = `<header class="top"><div class="brand">${esc(D.title)}</div>${tools}</header>
      ${lib && out ? `<div class="seg"><button data-tab="library" class="${S.tab === "library" ? "on" : ""}">#${TEXT.library}</button><button data-tab="writing" class="${S.tab === "writing" ? "on" : ""}">#${TEXT.writing}</button></div>` : ""}
      ${lib ? `<section class="zone" id="sec-library"><h2 class="kicker">#${TEXT.library}</h2>${lib}</section>` : ""}
      <section class="zone" id="sec-writing">${out ? `<h2 class="kicker">#${TEXT.writing}</h2>${out}` : ""}${out ? '<div style="height:56px"></div>' : ""}${leavesHtml(avail + 58)}</section>`;
    updateSearch();
    paintFromCovers();
    requestAnimationFrame(() => {
      // When Output is already in view at the top of the page, there is nothing to jump to.
      const seg = root.querySelector(".seg"), writing = document.getElementById("sec-writing");
      if (seg && writing) seg.hidden = writing.getBoundingClientRect().top + scrollY + 40 < innerHeight;
      const d = root.querySelector(".drawer"), bk = root.querySelector(".ss-book.open");
      if (d && bk) { const sh = d.parentElement.getBoundingClientRect(); d.style.setProperty("--dl", Math.max(0, Math.min(bk.getBoundingClientRect().left - sh.left, sh.width - 244)) + "px"); }
    });
  }

  // ---- settings: a panel floating over the page ----
  let panel = null;
  function openSettings() {
    if (!panel) {
      panel = document.createElement("div");
      panel.className = "h-settings";
      panel.innerHTML = `<div class="panel"><button class="x" aria-label="${TEXT.close}"><svg viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button><iframe title="${TEXT.settings}"></iframe></div>`;
      panel.addEventListener("click", e => { if (e.target === panel || e.target.closest(".x")) closeSettings(); });
      document.body.appendChild(panel);
    }
    window.md2bookHoldReload = true;
    panel.querySelector("iframe").src = D.settingsPath;
    panel.classList.add("on");
  }
  // What the settings changed shows on the page: reload it.
  function closeSettings() { panel.classList.remove("on"); location.reload(); }
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      if (opening && !opening.revealed) closeReader();
      else if (panel && panel.classList.contains("on")) closeSettings();
      else if (e.target.id === "q") { S.q = ""; S.sopen = false; render(); }
    }
  });

  // ---- events ----
  document.addEventListener("input", e => { if (e.target.id === "q") { S.q = e.target.value; S.hits = null; updateSearch(); askServer(); } });
  root.addEventListener("click", e => {
    const t = e.target;
    if (t.closest("[data-search]")) { const open = t.closest(".sbox").classList.contains("open") && !S.q; S.sopen = !open; if (open) S.q = ""; render(); if (S.sopen) document.getElementById("q").focus(); return; }
    if (t.closest("[data-settings]")) { openSettings(); return; }
    if (t.closest("[data-fold]")) {
      S.folded = !S.folded;
      try { localStorage.setItem("md2book-home-singles-folded", S.folded ? "1" : "0"); } catch { /* no storage */ }
      render();
      return;
    }
    const tb = t.closest("[data-tab]");
    if (tb) { const sec = document.getElementById("sec-" + tb.dataset.tab); if (sec) window.scrollTo({ top: sec.getBoundingClientRect().top + scrollY - 16, behavior: "smooth" }); return; }
    const cs = t.closest("[data-case]");
    if (cs) { S.filter[cs.dataset.case] = cs.dataset.f || null; render(); return; }
    if (t.closest("[data-all]")) { e.preventDefault(); S.view = "all"; S.q = ""; S.allf = null; render(); window.scrollTo(0, 0); return; }
    if (t.closest("[data-back]")) { e.preventDefault(); S.view = "home"; render(); return; }
    const af = t.closest("[data-allf]");
    if (af) { S.allf = af.dataset.allf === "*" ? null : af.dataset.allf; render(); return; }
    // A volume opens its notes first; the second click opens the book itself.
    const bk = t.closest(".ss-book");
    if (bk && bk.dataset.id.startsWith("v:") && S.open !== bk.dataset.id) { e.preventDefault(); S.open = bk.dataset.id; render(); return; }
    // An EPUB's click, and a volume's second, open the book here (see openBook).
    const item = bk && items.get(bk.dataset.id);
    if (item && openable(e, item)) { e.preventDefault(); openBook(item); }
  });
  document.addEventListener("click", e => {
    const t = e.target;
    if (S.open && !t.closest(".drawer, .ss-book")) { S.open = null; render(); }
    if (S.q && !t.closest(".sr, .sbox")) { S.q = ""; S.sopen = false; render(); }
  });
  // The segments are anchors to the stacked sections; the one in view is lit.
  function spy() {
    if (S.view !== "home") return;
    const secs = ["library", "writing"].map(k => document.getElementById("sec-" + k)).filter(Boolean);
    if (secs.length < 2) return;
    let cur = secs[0].id.slice(4);
    secs.forEach(x => { if (x.getBoundingClientRect().top <= innerHeight * .45) cur = x.id.slice(4); });
    if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) cur = secs[secs.length - 1].id.slice(4);
    if (cur !== S.tab) { S.tab = cur; document.querySelectorAll(".seg button").forEach(b => b.classList.toggle("on", b.dataset.tab === cur)); }
  }
  window.addEventListener("scroll", spy, { passive: true });
  let resizeTimer;
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 150); });

  // ---- opening a book ----
  // The reader loads unseen in a frame over the page. Meanwhile the book hops
  // on its shelf; once the reader has its file, the book's cover rises over
  // the blurred page and breathes; when the first spread is ready the cover
  // settles on it if that page is the cover, else fades as the reader shows. A
  // toaster says which step it is on (static/reader-opening.js tells it).
  // Each step a reader reports, as the number of the step now under way; the
  // cover shows from step `cover` on.
  const OPENING = {
    epub: { at: { arrived: 1, download: 1, open: 2, layout: 3 }, cover: 2 },
    vol: { at: { arrived: 1, prepare: 1, layout: 2 }, cover: 2 }
  };
  const COVER_RATIO = 170 / 240;
  const homeTitle = document.title;
  let opening = null;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const px = r => ({ left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
  // Moves (and sizes) `el` to rectangle `r`.
  function moveTo(el, r, options) {
    const from = px(el.getBoundingClientRect());
    Object.assign(el.style, px(r));
    return el.animate([from, px(r)], options).finished;
  }
  // The double click on the reader's background finds the way back from here.
  if (/^https?:$/.test(location.protocol)) {
    try { localStorage.setItem("md2book-home-path", location.pathname); } catch { /* storage unavailable */ }
  }

  function openable(e, b) {
    if (opening || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
    if (b.kind !== "vol" && b.fmt !== "epub") return false;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
    // The browser version shows each page in a frame of its own, and follows links itself.
    try { if (window.parent !== window && window.parent.md2book) return false; } catch { /* another site's frame */ }
    return true;
  }

  async function openBook(b) {
    const kind = b.kind === "vol" ? "vol" : "epub", plan = OPENING[kind];
    const o = opening = { b, kind, step: 0, ready: null, wake: null, float: null, revealed: false, pushed: false };
    // Waits until `test()` holds (forever, if the opening is called off).
    const until = test => new Promise(resolve => {
      const check = () => { if (opening === o) { if (test()) resolve(); else o.wake = check; } };
      check();
    });
    window.md2bookHoldReload = true;
    if (S.open) { S.open = null; render(); }
    const el = root.querySelector(`.ss-book[data-id="${CSS.escape(b.id)}"]`);
    el.classList.add("hop");
    // The cover's shape, for when it rises.
    o.src = b.cover || coverArt(b);
    o.ratio = Promise.race([wait(1500).then(() => COVER_RATIO), new Promise(resolve => {
      const img = new Image();
      img.onload = () => resolve(img.naturalWidth / img.naturalHeight || COVER_RATIO);
      img.onerror = () => resolve(COVER_RATIO);
      img.src = o.src;
    })]);
    o.veil = document.createElement("div");
    o.veil.className = "h-veil";
    o.frame = document.createElement("iframe");
    Object.assign(o.frame, { className: "h-reader", name: "md2book-reader", title: b.title, src: b.href });
    o.frame.addEventListener("load", () => frameLoaded(o));
    o.toast = document.createElement("div");
    o.toast.className = "h-toast";
    o.toast.setAttribute("role", "status");
    o.toast.innerHTML = `<div class="t"><span>${esc(TEXT.opening)} · ${esc(b.title)}</span><span class="n"></span></div><div class="s"><span class="spin"></span><span class="l"></span></div><div class="bar">${TEXT.steps[kind].map(() => "<i></i>").join("")}</div>`;
    document.body.append(o.veil, o.frame, o.toast);
    showStep(o);
    requestAnimationFrame(() => o.toast.classList.add("on"));

    // The cover rises on the reader's word (see reader-opening.js), never on a
    // timer: the reader may hold the thread just after.
    await until(() => o.step >= plan.cover || o.ready);
    o.float = await lift(o, el);
    await until(() => o.ready);
    await land(o);
  }

  function showStep(o) {
    // Ready, the last step is done; "Open" once the reader is on screen.
    const steps = TEXT.steps[o.kind], done = o.revealed, step = o.ready ? steps.length - 1 : o.step;
    o.toast.querySelector(".n").textContent = `${Math.min(step + 1, steps.length)} / ${steps.length}`;
    o.toast.querySelector(".l").textContent = done ? TEXT.opened : steps[step] + "…";
    o.toast.querySelectorAll(".bar i").forEach((bar, k) => bar.classList.toggle("on", Boolean(o.ready) || k < step));
    o.toast.classList.toggle("done", done);
  }

  window.addEventListener("message", e => {
    const o = opening, d = e.data;
    if (!o || e.origin !== location.origin || e.source !== o.frame.contentWindow || !d || d.md2book !== "opening") return;
    if (d.step === "close") { leaveReader(); return; }
    if (d.step === "ready" || d.step === "failed") o.ready = o.ready || { rect: d.rect || null, cover: Boolean(d.cover) };
    else o.step = Math.max(o.step, OPENING[o.kind].at[d.step] ?? 0);
    showStep(o);
    if (o.wake) o.wake();
  });

  function frameLoaded(o) {
    if (opening !== o) return;
    // A link followed inside the reader: the address and title follow it.
    if (o.revealed) {
      try {
        const w = o.frame.contentWindow;
        history.replaceState(history.state, "", w.location.pathname + w.location.search + w.location.hash);
        document.title = w.document.title;
      } catch { /* left this site */ }
      return;
    }
    // A page with no reader in it says nothing: show it as it is.
    setTimeout(() => {
      if (opening !== o || o.step || o.ready) return;
      o.ready = { rect: null, cover: false };
      showStep(o);
      if (o.wake) o.wake();
    }, 300);
  }

  // From the book on its shelf to its cover, small, over the blurred page.
  async function lift(o, el) {
    const b = o.b, src = o.src, r = el.getBoundingClientRect();
    const ratio = await o.ratio;
    const float = document.createElement("div");
    float.className = "h-cover";
    float.innerHTML = `<div class="face" style="background-image:${cssUrl(src)}"></div>`;
    const h = Math.min(innerHeight * .42, 340), w = h * ratio;
    const to = { left: (innerWidth - w) / 2, top: (innerHeight - h) / 2 - 14, width: w, height: h };
    Object.assign(float.style, px(to));
    document.body.append(float);
    el.classList.remove("hop");
    el.classList.add("taken");
    S.reading = b.id;
    o.veil.classList.add("on");
    // By transform alone, so it keeps moving while the reader holds the thread.
    const from = `translate(${r.left - to.left}px, ${r.top - to.top}px) scale(${r.height * COVER_RATIO / w}, ${r.height / h})`;
    float.classList.add("breathing");
    await float.animate([{ transform: from, opacity: 0 }, { opacity: 1, offset: .25 }, { transform: "none", opacity: 1 }], { duration: 750, easing: "cubic-bezier(.2, .75, .25, 1)" }).finished;
    return float;
  }

  // A book opening on its cover (an EPUB not read yet): the cover settles on
  // the reader's page, which is that cover. Anything else (a book with a
  // reading position, a collection) shows its page straight away, the cover
  // fading as it does.
  async function land(o) {
    const { rect, cover } = o.ready, float = o.float;
    o.veil.classList.add("on", "dark");
    if (rect && cover) {
      float.classList.remove("breathing");
      float.classList.add("landing");
      await moveTo(float, rect, { duration: 950, easing: "cubic-bezier(.45, 0, .2, 1)" });
      if (opening !== o) return;
      o.frame.classList.add("on");
      await wait(350);
    } else {
      o.frame.classList.add("on");
      await float.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 450, easing: "ease-out", fill: "forwards" }).finished;
    }
    if (opening !== o) return;
    float.remove();
    o.float = null;
    o.revealed = true;
    showStep(o);
    setTimeout(() => o.toast.classList.remove("on"), 700);
    history.pushState({ md2bookReader: true }, "", o.b.href);
    o.pushed = true;
    try { document.title = o.frame.contentDocument.title; } catch { /* left this site */ }
    o.frame.contentWindow.focus();
  }

  // Back to the shelves: Back, a double click on the reader's background, or
  // Escape while the book is still opening.
  function leaveReader() { if (opening && opening.pushed) history.back(); else closeReader(); }
  function closeReader() {
    const o = opening;
    if (!o) return;
    opening = null;
    S.reading = null;
    window.md2bookHoldReload = false;
    o.frame.classList.remove("on");
    o.veil.classList.remove("on", "dark");
    o.toast.classList.remove("on");
    if (o.float) o.float.remove();
    root.querySelectorAll(".ss-book.taken, .ss-book.hop").forEach(el => el.classList.remove("taken", "hop"));
    document.title = homeTitle;
    window.focus();
    setTimeout(() => { o.frame.remove(); o.veil.remove(); o.toast.remove(); }, 650);
  }
  window.addEventListener("popstate", () => {
    if (opening && opening.pushed) closeReader();
    // Forward again, to a book closed here: open it as a page of its own.
    else if (history.state && history.state.md2bookReader) location.reload();
  });

  render();
  spy();
})();
