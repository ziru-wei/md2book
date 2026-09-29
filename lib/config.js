import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Everything about a particular site: its name, which notes it
// publishes, how they group into collections and how each collection is
// laid out. Read from md2book.config.js (see md2book.config.example.js),
// found in, in order: $MD2BOOK_CONFIG, the current directory, the notes
// folder. Anything left out keeps the default below.
export const DEFAULTS = {
  site: {
    // Home page heading, and the browser tab title (defaults to title).
    title: "Journal",
    browserTitle: null,
    // <meta name="author">.
    author: "",
    // Where the home page (the list of every note) lives. Set it to
    // something unguessable (e.g. "/a1b2c3") to keep a public deployment
    // from listing every note; single notes and collections keep their
    // own links. The HOME_PATH environment variable overrides it.
    homePath: "/"
  },

  publish: {
    // null: every note is published, except one with `publish: false`
    // in its frontmatter. A field name: only notes that set that field
    // are published.
    require: null,
    // A frontmatter field whose value, when set, makes the note's URL
    // permanent (it survives renaming or moving the file). Without it
    // the URL comes from the file's path.
    idField: "publishID"
  },

  collections: {
    // A note's collections — the groups /contents/<name> shows as one
    // book — come from any of these:
    // its top-level folder ("travel/kyoto.md" -> "travel"),
    folders: true,
    // these frontmatter fields (a list or a comma-separated string),
    tagFields: ["tags"],
    // and #tags written in the text.
    inlineTags: true
  },

  // How each collection is laid out: "paper" (each note starts a fresh
  // page, two columns filled top to bottom, references pinned to the
  // last page) or "zine" (notes run on one after another, balanced
  // columns, a date under each, references inline). The first rule
  // whose `match` fits the collection's name wins — a string matches
  // the name exactly, a RegExp anywhere in it.
  layouts: [],
  defaultLayout: "paper",

  byline: {
    // Leave out the "written on ... updated ..." line in a collection
    // for notes whose file name is just a date (2026-09-21.md) — the
    // name already says it.
    hideOnDateFilenames: false
  },

  // A heading (any level-2 heading with exactly this text, any case)
  // that marks the rest of a note as private: it and everything after
  // it are never published. null: none.
  privateHeading: null,

  typography: {
    // Title Case for titles and headings.
    titleCase: true,
    // Chinese book-title marks 《...》 set as 「bold italic」.
    bookTitleMarks: true
  },

  fonts: {
    // An Adobe Fonts (Typekit) web project id to load, e.g. for a CJK
    // serif. Adobe ties a project to its own domains. null: none.
    adobeKit: null
  }
};

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) && !(value instanceof RegExp);
}

function merge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? merge(base[key], value) : value;
  }
  return out;
}

const CONFIG_NAMES = ["md2book.config.js", "md2book.config.mjs"];

export function findConfigFile(notesDir) {
  if (process.env.MD2BOOK_CONFIG) return path.resolve(process.env.MD2BOOK_CONFIG);
  for (const dir of [process.cwd(), notesDir]) {
    for (const name of CONFIG_NAMES) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) return file;
    }
  }
  return null;
}

export async function loadConfig(notesDir) {
  const file = findConfigFile(notesDir);
  let user = {};
  if (file) {
    const mod = await import(pathToFileURL(file).href);
    user = mod.default || mod;
  }
  const config = merge(DEFAULTS, user);
  if (process.env.HOME_PATH) config.site.homePath = process.env.HOME_PATH;
  config.site.browserTitle ||= config.site.title;
  config.file = file;
  return config;
}

// The layout ("paper" or "zine") of collection `name`.
export function layoutOf(config, name) {
  if (!name) return config.defaultLayout;
  for (const rule of config.layouts) {
    const hit = rule.match instanceof RegExp ? rule.match.test(name) : rule.match === name;
    if (hit) return rule.layout;
  }
  return config.defaultLayout;
}
