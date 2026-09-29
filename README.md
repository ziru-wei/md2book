# md2book

Read a folder of Markdown notes as a book. Every note is set on fixed
pages in a two-column publication layout, and you turn pages like paper —
by key, trackpad swipe, or finger. An Obsidian vault works as-is: no
plugin, no export step, no build.

- Collections: a folder, a tag or a `#tag` becomes a book of its own.
- Two layouts per collection: **paper** (each note on fresh pages) and
  **zine** (notes running on one after another).
- Obsidian syntax: `[[wikilinks]]`, `![[embedded images]]`, math,
  highlights, CriticMarkup revisions and comments (as margin notes).
- Figures, tables and headings are numbered; links become numbered
  references.
- Desktop, phone and tablet layouts; pinch-zoom; prints one sheet per page.

## Run it on your notes

With Node.js 20.12 or later:

```bash
git clone https://github.com/ziru-wei/md2book.git
cd md2book
npm install
node bin/md2book.js ~/path/to/your/notes
```

This opens `http://localhost:3000`. Edit a note and the page reloads.
`--port 4000` picks another port, `--no-open` doesn't open a browser. Run
it from inside your notes folder and the folder can be left out.

md2book only reads your notes; it never writes to the folder.

## Your notes

Any `.md` file in the folder (and its subfolders) is a note. Nothing is
required in it; these all help:

```md
---
created: 2026-04-02
updated: 2026-04-05
tags: [japan, trips]
---

# Kyoto in Spring

The first `# heading` is the title. A title with ": " or " / " gets a
subtitle on its own line.
```

- **Hidden notes**: `publish: false` in the frontmatter. Folders starting
  with `.` (like `.obsidian`) are skipped.
- **Dates**: `created`/`updated` show in a small byline, and order a
  collection oldest to newest (it opens on the newest note).
- **Links that last**: a note's URL is made from its file path, so
  renaming the file changes it. Give the note a `publishID: anything`
  and the URL stays the same wherever the file moves.

### Collections

`http://localhost:3000` lists every note; press **Space** there to pick a
collection. A note is in a collection named after:

- its top-level folder (`travel/kyoto.md` is in `travel`),
- each entry in its `tags` frontmatter,
- each `#tag` in its text.

`/contents` is every note as one book; `/contents/<name>` is one
collection.

### Writing

- The usual Markdown, plus `==highlight==`.
- `[text](https://…)` shows as `text [1]`, with the source in a
  References list at the end of the note. Repeated URLs share a number.
- `{==REF==}{>>https://…<<}` cites a source as a bare `[1]`; adjacent
  ones, `({==REF==}{>>…<<}, {==REF==}{>>…<<})`, collapse to `[1, 2]`.
- `[[Another note]]`, `[[Another note|shown text]]`, and
  `[text](another%20note.md)` link to other notes. A link to a hidden or
  missing note is plain text.
- Math: `$…$` inline, `$$…$$` on its own lines.
- CriticMarkup shows the finished text: `{--deleted--}` is left out,
  `{++added++}` stays, `{~~old~>new~~}` shows `new`, and `{==text==}`
  shows `text`. A comment on a replacement or a highlight —
  `{==text==}{>>comment<<}` — becomes a numbered note in the page margin,
  level with its line. Headings can have them too.
- Headings are numbered (1, 1.1, …); a first heading called "Abstract"
  isn't.

### Images and tables

`![[image.png]]` finds the image anywhere in the vault, the way Obsidian
does; `![alt](attachments/image.png)` (relative to the note) and web URLs
work too. An image on its own line becomes a numbered figure; a
`(caption)` on the next line is its caption:

```md
![[kyoto.jpg]]
(The Philosopher's Path in April.)
```

Put `//teaser` on the line after an image to show it under the title,
across both columns, or `//span` to put it at the top of the page it
lands on, across both columns. Tables take a caption and `//span` the
same way. Tables are numbered, keep whole rows together, and repeat
their header when they continue on the next column or page.

## Reading

| | Desktop | Phone / tablet |
|---|---|---|
| Turn a page | ← → or A D, or swipe sideways on the trackpad | swipe |
| One page / two pages | `/` | turn the tablet |
| Tablet-style page (bigger type, one column) | `\` | — |
| Contents of a collection | Space | — |

## Settings

Copy `md2book.config.example.js` to `md2book.config.js` — in the folder
you run md2book from, or in your notes folder — and keep what you want to
change: the site's title, which notes are published, where collections
come from, and which collections use the zine layout:

```js
export default {
  site: { title: "Field Notes" },
  layouts: [{ match: "diary", layout: "zine" }]
};
```

Every option is described in `lib/config.js`. Colors, fonts, sizes and
page margins are in `static/journal.css`, marked `CUSTOMIZABLE STYLE`.

## Putting it online

The server is an ordinary Express app (`server.js`); `api/index.js`
wraps it for Vercel. On a server, notes can come from a GitHub repository
instead of a folder — see `.env.example` (`GITHUB_OWNER`, `GITHUB_REPO`,
`GITHUB_TOKEN`, optionally `GITHUB_DIRS`).

- `site.homePath` (or `HOME_PATH`) moves the list of every note to an
  unguessable path; single notes and collections keep working links.
- Images on `raw.githubusercontent.com` are served through the site, so
  the repository's name never reaches readers (`IMAGE_GITHUB_TOKEN` for a
  private one).
- `.vercelignore` keeps `entries/`, `.env` and `node_modules` out of a
  `vercel deploy`.

## How it works

`server.js` turns each note into HTML. In the browser, `static/reader.js`
cuts it into pages: each page's text is a two-column box exactly as tall
as the room left on the page, and whatever the browser pushes past the
second column becomes the next page — so column breaks and page breaks
are the browser's own. Pages are laid out at a fixed size, then scaled to
fit the screen.
