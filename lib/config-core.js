// The site settings themselves — defaults, merging, layout rows —
// with nothing that touches the file system, so the browser reader
// (web/) uses them as they are. lib/config.js reads and writes the file.

// Everything about a particular site: its name, which notes it
// publishes, how they group into collections and how each collection is
// laid out. Read from md2book.settings.json in the md2book folder (or
// $MD2BOOK_SETTINGS) — written by the /settings page when md2book runs
// locally, and deployed along with the code. Anything left out keeps the
// default below.
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

  // How pages look: `collection` for every collection, and `rules` for
  // particular collections (each a full row, with `collection` naming
  // it). A note opened on its own follows its collection (see
  // rowForNote below).
  //   layout          "paper": each note starts a fresh page, columns
  //                   filled top to bottom, references pinned to the last
  //                   page. "zine": notes run on one after another,
  //                   balanced columns, references inline.
  //   open            where a collection opens: "latest" (the newest
  //                   note's first page) or "first" (the first page).
  //   dropCap         a large first letter on a note's first paragraph.
  //   justify         justified body text, set a paragraph at a time
  //                   with Justif (even spacing, hyphenation).
  //   multiplyImages  images blend into the paper (multiply), so white
  //                   backgrounds take on the paper's tone.
  //   pageNumbers     "01/09" page numbers.
  //   numberFigures, numberTables, numberHeadings
  //                   "Figure 1.", "Table 1.", "1.2" section numbers.
  //   columns         how a desktop browser opens the page: 2, the
  //                   two-column book page; 1, the one-column tablet-style
  //                   spread (the \ key switches for the visit). Phones
  //                   and tablets are unaffected.
  //   dates           the "written on ..., updated ..." line: "show" or
  //                   "hide".
  //   privateHeading  a level-2 heading with exactly this text (any
  //                   case): it and everything after it are left out.
  //   showThrough     "力透纸背": the page on the back of each page shows
  //                   through, faintly and mirrored, as in a printed book.
  //   letterpress     letters as if printed into the paper: edges a touch
  //                   uneven, a faint impression around them.
  //                   (How strong each is: `paper` below.)
  //   applyToAll      (rules only) the collection's notes use this row
  //                   when opened on their own, whatever other
  //                   collections they are in. No note may be in two
  //                   such collections (the settings page won't save it).
  layouts: {
    collection: {
      layout: "paper",
      open: "latest",
      dropCap: true,
      justify: false,
      multiplyImages: true,
      pageNumbers: true,
      numberFigures: true,
      numberTables: true,
      numberHeadings: true,
      columns: 2,
      dates: "show",
      privateHeading: "",
      showThrough: false,
      letterpress: false
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

  // How strong the paper effects are, from 0 to 100, wherever a layout
  // row turns them on (showThrough, letterpress above).
  paper: {
    showThroughStrength: 50,
    letterpressStrength: 50
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

// Whether `value` passes a "*" / true / list rule.
export function allowed(rule, value) {
  if (rule === "*" || rule === true) return true;
  if (Array.isArray(rule)) return rule.some(item => String(item).toLowerCase() === value.toLowerCase());
  return false;
}

// Defaults plus saved settings, as the site uses them.
export function resolveConfig(saved) {
  // A copy, so nothing done to the result changes DEFAULTS.
  const config = merge(structuredClone(DEFAULTS), saved);
  // A tags map replaces the default one rather than adding to it.
  if (saved.collections && saved.collections.tags) config.collections.tags = saved.collections.tags;
  // Single notes follow their collections now; an older file's own
  // single-note row is dropped.
  delete config.layouts.note;
  if (typeof process !== "undefined" && process.env.HOME_PATH) config.site.homePath = process.env.HOME_PATH;
  config.site.browserTitle ||= config.site.title;
  return config;
}

const sameName = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();

function ruleFor(config, name) {
  return (config.layouts.rules || []).find(r => sameName(r.collection, name)) || null;
}

// The layout row for collection `name` (or, with no name, the row for
// every collection): a rule's missing settings come from the collection
// row.
export function rowFor(config, name) {
  const rule = name === null || name === undefined ? null : ruleFor(config, name);
  return rule ? { ...config.layouts.collection, ...rule } : config.layouts.collection;
}

// The layout row for a note opened on its own, which is in collections
// `names`: the row of one of them set to apply to all its notes; else
// the row they all share (a single collection, or several without rules
// of their own); else — collections laid out differently, or none — the
// row for every collection.
export function rowForNote(config, names) {
  const forced = (config.layouts.rules || []).find(r => r.applyToAll && names.some(n => sameName(n, r.collection)));
  if (forced) return rowFor(config, forced.collection);
  const rules = new Set(names.map(n => ruleFor(config, n)));
  return rules.size === 1 ? rowFor(config, names[0]) : rowFor(config, null);
}
