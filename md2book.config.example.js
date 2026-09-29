// Copy to md2book.config.js (next to where you run md2book, or in your
// notes folder) and keep only what you want to change. Every option and
// its default is described in lib/config.js.
export default {
  site: {
    title: "My Notes",        // home page heading
    author: "",               // <meta name="author">
    homePath: "/"             // e.g. "/a1b2c3" to keep the note list unlisted
  },

  publish: {
    // null: every note is published unless it has `publish: false`.
    // "publish": only notes that set `publish: true` (or any value).
    require: null,
    // Optional frontmatter field giving a note a permanent URL.
    idField: "publishID"
  },

  collections: {
    folders: true,            // "travel/kyoto.md" is in collection "travel"
    tagFields: ["tags"],      // frontmatter tags
    inlineTags: true          // #tags in the text
  },

  // "paper": each note on fresh pages, two columns top to bottom.
  // "zine": notes run on one after another, balanced columns.
  layouts: [
    { match: "diary", layout: "zine" },
    { match: /^journal/i, layout: "zine" }
  ],
  defaultLayout: "paper",

  byline: {
    hideOnDateFilenames: false
  },

  // A level-2 heading that keeps the rest of a note private.
  privateHeading: null,

  typography: {
    titleCase: true,
    bookTitleMarks: true      // 《书名》 -> 「书名」 in bold italic
  },

  fonts: {
    adobeKit: null            // an Adobe Fonts web project id
  }
};
