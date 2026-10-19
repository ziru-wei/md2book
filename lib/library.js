// The home page's library: the EPUB and PDF files in the vault — what
// each is called, who wrote it, roughly how long it is (which sets how
// thick its spine is) and its cover. Read from the files themselves,
// once per file (and again if the file changes).
import JSZip from "jszip";

export function bookFormat(p) {
  return /\.epub$/i.test(p) ? "epub" : /\.pdf$/i.test(p) ? "pdf" : null;
}

// The books among a vault's attachments, in path order.
export function booksFromAssets(assets, hash) {
  return assets.filter(p => bookFormat(p)).sort((a, b) => a.localeCompare(b)).map(p => {
    const fmt = bookFormat(p);
    return {
      path: p,
      id: hash(fmt + ":" + p),
      fmt,
      folder: p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "",
      title: p.split("/").pop().replace(/\.(epub|pdf)$/i, "")
    };
  });
}

// A file's bytes, from either kind of source (a Node stream with its
// size, or a browser File).
async function readBytes(asset) {
  if (typeof asset.arrayBuffer === "function") return new Uint8Array(await asset.arrayBuffer());
  const chunks = [];
  for await (const chunk of asset.stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const CJK = /[぀-ヿ㐀-鿿가-힯]/g;
const LATIN_WORD = /[A-Za-z0-9À-ɏ]+/g;

// Words in some text: every Chinese / Japanese / Korean character, and
// every run of Latin letters or digits.
export function countWords(text) {
  const cjk = text.match(CJK);
  return (cjk ? cjk.length : 0) + ((text.replace(CJK, " ").match(LATIN_WORD) || []).length);
}

const decode = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, "&").trim();
const tagText = (xml, name) => {
  const m = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, "i").exec(xml);
  return m ? decode(m[1].replace(/<[^>]+>/g, "")) : "";
};
const attr = (tag, name) => { const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag); return m ? decode(m[2] ?? m[3]) : ""; };

function resolveIn(dir, href) {
  const parts = (dir ? dir.split("/") : []).concat(decodeURIComponent(href.split("#")[0]).split("/"));
  const out = [];
  for (const part of parts) { if (part === "..") out.pop(); else if (part && part !== ".") out.push(part); }
  return out.join("/");
}

async function epubDetails(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const container = zip.file("META-INF/container.xml");
  const opfPath = container ? attr((/<rootfile\b[^>]*>/i.exec(await container.async("string")) || [""])[0], "full-path") : "";
  const opf = opfPath && zip.file(opfPath) ? await zip.file(opfPath).async("string") : "";
  const dir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/")) : "";
  const items = [...opf.matchAll(/<item\b[^>]*>/gi)].map(m => ({ id: attr(m[0], "id"), href: attr(m[0], "href"), type: attr(m[0], "media-type"), props: attr(m[0], "properties") }));
  // The cover: the manifest item called "cover-image", or the one the
  // old-style <meta name="cover"> names.
  const coverId = ((/<meta\b[^>]*\bname\s*=\s*["']cover["'][^>]*>/i.exec(opf) || [""])[0]).match(/content\s*=\s*["']([^"']+)["']/i)?.[1];
  const cover = items.find(i => /cover-image/.test(i.props)) || items.find(i => i.id === coverId && /^image\//.test(i.type));
  let words = 0;
  for (const item of items) {
    if (!/x?html/i.test(item.type)) continue;
    const file = zip.file(resolveIn(dir, item.href));
    if (!file) continue;
    const html = await file.async("string");
    words += countWords(decode(html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")));
  }
  return {
    title: tagText(opf, "title"),
    author: tagText(opf, "creator"),
    words,
    cover: cover && zip.file(resolveIn(dir, cover.href))
      ? { type: cover.type, bytes: await zip.file(resolveIn(dir, cover.href)).async("uint8array") }
      : null
  };
}

// What's known of each file already: path -> { key, details }. The key
// (its size and time) says whether the file is the one that was read.
const known = new Map();

async function details(book, source) {
  const asset = await source.readAsset(book.path);
  if (!asset) return { words: 0, author: "", cover: null };
  const key = `${asset.size ?? asset.lastModified ?? ""}:${asset.lastModified ?? ""}`;
  const hit = known.get(book.path);
  if (hit && hit.key === key) {
    if (asset.stream) asset.stream.destroy();
    return hit.details;
  }
  let result;
  try {
    if (book.fmt === "epub") result = await epubDetails(await readBytes(asset));
    else {
      // A pdf's text isn't read: its size stands in for its length.
      if (asset.stream) asset.stream.destroy();
      result = { title: "", author: "", words: Math.round((asset.size ?? 0) / 60), cover: null };
    }
  } catch {
    result = { title: "", author: "", words: 0, cover: null };
  }
  known.set(book.path, { key, details: result });
  return result;
}

// Every book with its author, words and whether it has a cover (the title stays its file's name).
export async function describeBooks(books, source) {
  const out = new Array(books.length);
  let next = 0;
  // A few at a time: each EPUB is read whole.
  await Promise.all(Array.from({ length: Math.min(4, books.length) }, async () => {
    while (next < books.length) {
      const i = next++;
      const d = await details(books[i], source);
      // The title is the file's name, not the title inside the book.
      out[i] = { ...books[i], author: d.author, words: d.words, hasCover: Boolean(d.cover) };
    }
  }));
  return out;
}

// A book's cover image: { type, bytes }, or null.
export async function bookCover(book, source) {
  return (await details(book, source)).cover;
}
