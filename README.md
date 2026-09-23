# md2book

A live local Markdown journal app. Every `.md` file in a watched folder
becomes an entry with a portrait, two-column publication layout; `/` lists
all entries.

## Run

```bash
npm install
npm run dev
```

`npm run dev` opens `http://localhost:3000` in your default browser
automatically. Set `NO_OPEN=1` to skip that.

Add, edit, or remove `.md` files anywhere under `entries/` (including
nested subfolders) with `publishID: <anything>` in the frontmatter. The
browser reloads automatically, and the entry list on `/` updates on its
own — no extra registration step.

There is no build step and no PDF pipeline.

## Use another folder

```bash
npm run dev -- path/to/folder
```

or:

```bash
JOURNAL_DIR=path/to/folder npm run dev
```

This is meant to point at your own notes folder — for example a local
clone of a private Git repo where you keep your Markdown notes. The app
only reads from it; nothing here writes back to that folder or to Git.

## Markdown contract

```md
---
publishID: some-stable-id
created: 2026-09-22
updated: 2026-09-22
---

# Journal Title
```

Rules:

- `publishID` is required for the file to appear at all (on the list page or its own URL); missing/blank is skipped. Its value can be anything you want — it's hashed into the file's `/entry/<hash>` URL, and unlike the file's path (which changes if you rename or move the note in Obsidian), it stays put, so the URL never breaks. Pick it once and don't change it.
- the first `# H1` becomes the centered document title and is removed from body flow
- `created`/`updated` and the author (built into the template as `Ziru Wei`) appear as a small italic byline at the bottom of the first page's first column: "This article is written on ‹created›, and updated ‹updated› by ‹author›."
- body content flows continuously through two columns
- `**bold**`, `*italic*`, bullets, blockquotes, and standard Markdown are supported
- `==highlight==` renders as a restrained marker-style highlight
- `[label](url)` renders as `label [N]`
- `%%REF{>>{"author":"...","time":...}@@url<<}%%` renders as a bare `[N]`, with no label; the `author`/`time` metadata is accepted but ignored. This is for citing a source inline without turning any visible text into a link.
- adjacent `%%REF...%%` citations (e.g. written back-to-back as `(%%REF..%%, %%REF..%%)`) collapse into a single group like `[1, 2]` instead of `[1][2]`
- References are generated automatically and pinned to the bottom-right of whichever page ends up being the last one
- repeated URLs reuse the same reference number, whether written as `[label](url)` or `%%REF...%%`

## Images

Normal Markdown images work directly:

```md
![image.png](https://example.com/image.png)

(This figure demonstrates...)
```

A normal image stays at its source position in one column.

To promote an image to a teaser figure:

```md
![image.png](https://example.com/image.png)

//teaser
(This figure demonstrates...)

```

The marker must be the immediately following paragraph and must match exactly, ignoring letter case. The teaser is directly below the title and spans the text area.

If a remote image cannot load, the page shows a local placeholder instead of a broken-image icon.

## Styling

Edit:

```text
static/journal.css
```

Every area intended for visual tuning is marked with:

```css
/* CUSTOMIZABLE STYLE: ... */
```

The easiest global controls are the variables at the top of that file.
