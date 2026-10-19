// What the home page shows, as plain data (static/home.js draws it):
//   books        the EPUB and PDF files — the library's shelves
//   collections  the folders and tags of published notes that are
//                output — the writing shelves' volumes
//   notes        every published note, newest first
import { rowFor, folderRole } from "./config-core.js";
import { countWords } from "./library.js";

const wordsOf = new WeakMap();

// Words in a note's body (cached on the entry object, which is itself
// replaced whenever the note changes).
function entryWords(entry) {
  if (!wordsOf.has(entry)) {
    wordsOf.set(entry, countWords((entry.bodyHtml || "").replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")));
  }
  return wordsOf.get(entry);
}

const dateOf = entry => entry.updated || entry.created || "";

const topFolder = id => id.includes("/") ? id.slice(0, id.indexOf("/")) : "";

// `paths` says where each page is: { entry(slug), contents(name), book(book), cover(book) }.
//
// A top-level folder is input (its EPUB and PDF files are on the library
// shelves), output (its notes make collections) or neither (see
// folderRole in config-core.js); what is at the top of the vault is both.
export function buildHomeModel({ entries, books, config, paths }) {
  const withNotes = new Set(entries.map(e => topFolder(e.id)).filter(Boolean));
  const roleOf = top => top === "" ? "both" : folderRole(config, top, withNotes.has(top));

  const collections = new Map();
  for (const entry of entries) {
    if (roleOf(topFolder(entry.id)) === "input" || roleOf(topFolder(entry.id)) === null) continue;
    for (const name of entry.tags) {
      if (!collections.has(name)) collections.set(name, { name, layout: rowFor(config, name).layout, notes: 0, words: 0, latest: "", href: paths.contents(name) });
      const c = collections.get(name);
      c.notes++;
      c.words += entryWords(entry);
      if (dateOf(entry) > c.latest) c.latest = dateOf(entry);
    }
  }

  const notes = [...entries].sort((a, b) => dateOf(b).localeCompare(dateOf(a)) || a.id.localeCompare(b.id)).map(entry => ({
    slug: entry.slug,
    title: entry.title,
    date: dateOf(entry),
    collection: entry.tags[0] || null,
    collections: entry.tags,
    href: paths.entry(entry.slug)
  }));

  return {
    books: books.filter(book => { const role = roleOf(topFolder(book.folder ? book.folder + "/" : "")); return role === "input" || role === "both"; }).map(book => ({
      id: book.id,
      title: book.title,
      author: book.author || "",
      fmt: book.fmt,
      words: book.words || 0,
      folder: book.folder,
      href: paths.book(book),
      cover: book.hasCover ? paths.cover(book) : null
    })),
    collections: [...collections.values()].sort((a, b) => a.name.localeCompare(b.name)),
    notes
  };
}
