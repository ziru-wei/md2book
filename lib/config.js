import fs from "node:fs";
import path from "node:path";

// Everything about a particular site: its name, which notes it
// publishes, how they group into collections and how each collection is
// laid out. Read from md2book.settings.json — written by the /settings
// page when md2book runs locally: $MD2BOOK_SETTINGS if set, else the one
// in the notes folder (each folder of notes has its own), or — when the
// notes come from GitHub — the one in the current directory. Anything
// left out keeps the default below.
export const DEFAULTS = {
  site: {
    // Home page heading, and the browser tab title (defaults to title).
    title: "My-Library",
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
    // book — come from folders and tags. A folder collection holds every
    // note anywhere inside it, subfolders included.
    // true: every top-level folder is a collection ("travel/japan/
    // kyoto.md" is in "travel"). A list: only these folders, which can be
    // subfolders (["Journal", "PhD/Papers"]). false: no folders.
    folders: true,
    // Frontmatter fields whose values are tags (a list or a comma-
    // separated string), each mapped to "*" (every tag in it is a
    // collection) or a list of the tags that are.
    tags: { publishTag: "*" },
    // #tags written in the text: false, true (all of them) or a list.
    inlineTags: false
  },

  // How pages look: `note` for a note on its own page, `collection` for
  // any collection, and `rules` for particular collections (each a full
  // row, with `collection` naming it — first match wins).
  //   layout          "paper": each note starts a fresh page, columns
  //                   filled top to bottom, references pinned to the last
  //                   page. "zine": notes run on one after another,
  //                   balanced columns, references inline.
  //   open            where a collection opens: "latest" (the newest
  //                   note's first page) or "first" (the first page).
  //   dropCap         a large first letter on a note's first paragraph.
  //   pageNumbers     "01/09" page numbers.
  //   numberFigures, numberTables, numberHeadings
  //                   "Figure 1.", "Table 1.", "1.2" section numbers.
  //   columns         body text in 1 or 2 columns (phones and the tablet
  //                   layout always use one).
  //   dates           the "written on ..., updated ..." line: "show" or
  //                   "hide".
  //   privateHeading  a level-2 heading with exactly this text (any
  //                   case): it and everything after it are left out.
  layouts: {
    note: {
      layout: "paper",
      dropCap: true,
      pageNumbers: true,
      numberFigures: true,
      numberTables: true,
      numberHeadings: true,
      columns: 2,
      dates: "show",
      privateHeading: ""
    },
    collection: {
      layout: "paper",
      open: "latest",
      dropCap: true,
      pageNumbers: true,
      numberFigures: true,
      numberTables: true,
      numberHeadings: true,
      columns: 2,
      dates: "show",
      privateHeading: ""
    },
    rules: []
  },

  typography: {
    // Title Case for titles and headings.
    titleCase: true,
    // Chinese book-title marks 《...》 set as 「bold italic」.
    bookTitleMarks: true,
    // Characters that split a title into title and subtitle (at the
    // first one found): "Kyoto: In Spring". Empty: never split.
    subtitleSeparators: "/／:：|｜"
  },

  fonts: {
    // An Adobe Fonts (Typekit) web project id to load, e.g. for a CJK
    // serif. Adobe ties a project to its own domains. null: none.
    adobeKit: null
  }
};

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function merge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? merge(base[key], value) : value;
  }
  return out;
}

export const SETTINGS_NAME = "md2book.settings.json";

// The settings file: `notesDir` is the local notes folder, or null when
// the notes come from GitHub.
export function settingsFile(notesDir) {
  const file = process.env.MD2BOOK_SETTINGS
    ? path.resolve(process.env.MD2BOOK_SETTINGS)
    : path.join(notesDir || process.cwd(), SETTINGS_NAME);
  return { file, exists: fs.existsSync(file) };
}

// Whether `value` passes a "*" / true / list rule.
export function allowed(rule, value) {
  if (rule === "*" || rule === true) return true;
  if (Array.isArray(rule)) return rule.some(item => String(item).toLowerCase() === value.toLowerCase());
  return false;
}

// The settings as saved (only what differs from the defaults is needed).
export function readSettings(notesDir) {
  const { file, exists } = settingsFile(notesDir);
  if (!exists) return { file, exists, saved: {} };
  return { file, exists, saved: JSON.parse(fs.readFileSync(file, "utf8")) };
}

// Defaults plus saved settings, as the site uses them.
export function resolveConfig(saved) {
  // A copy, so nothing done to the result changes DEFAULTS.
  const config = merge(structuredClone(DEFAULTS), saved);
  // A tags map replaces the default one rather than adding to it.
  if (saved.collections && saved.collections.tags) config.collections.tags = saved.collections.tags;
  if (process.env.HOME_PATH) config.site.homePath = process.env.HOME_PATH;
  config.site.browserTitle ||= config.site.title;
  return config;
}

export function loadConfig(notesDir) {
  const { file, exists, saved } = readSettings(notesDir);
  const config = resolveConfig(saved);
  config.file = exists ? file : null;
  return config;
}

export function writeSettings(file, saved) {
  fs.writeFileSync(file, JSON.stringify(saved, null, 2) + "\n");
}

// The layout row for collection `name`, or for a note on its own page
// (`name` null): a rule's missing settings come from the collection row.
export function rowFor(config, name) {
  const rows = config.layouts;
  if (name === null || name === undefined) return rows.note;
  const lower = String(name).toLowerCase();
  const rule = (rows.rules || []).find(r => String(r.collection || "").toLowerCase() === lower);
  return rule ? { ...rows.collection, ...rule } : rows.collection;
}
