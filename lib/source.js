import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { IGNORED_DIR_RE, isMarkdown } from "./vault-files.js";
import { SETTINGS_NAME } from "./config-core.js";

import { createFileBookmarkStore, createGitHubBookmarkStore } from "./epub-bookmarks.js";

const GITHUB_API = "https://api.github.com";

function githubConfigFromEnv() {
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;
  if (!owner || !repo || !token) return null;

  return {
    owner,
    repo,
    token,
    branch: process.env.GITHUB_BRANCH || "main",
    notesDir: process.env.EPUB_NOTES_DIR || undefined,
    dirs: (process.env.GITHUB_DIRS || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)
  };
}

async function githubApi(apiPath, token, { method = "GET", body } = {}) {
  const res = await fetch(`${GITHUB_API}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const error = new Error(`GitHub API ${apiPath} failed: ${res.status} ${await res.text()}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

// Every source has the same shape:
//   listAll()        -> { notes: [{ id, version }], assets: [path] }
//                       (ids and paths relative to the vault, "/"-separated)
//   readFile(id)     -> the note's Markdown
//   readAsset(path)  -> { stream, size } for an attachment
// A GitHub source also keeps the site's settings in the repo, as
// md2book.settings.json at its top (the browser reader reads the same
// file from a folder): listAll() says which version of it there is
// (`settings`, its blob sha, or null), readSettings(version) reads it
// and writeSettings(saved) commits a new one.
function createGitHubSource(config) {
  const rawUrl = p =>
    `https://raw.githubusercontent.com/${config.owner}/${config.repo}/${config.branch}/${p.split("/").map(encodeURIComponent).join("/")}`;
  const inDirs = p => config.dirs.length === 0 ||
    config.dirs.some(dir => p === dir || p.startsWith(`${dir}/`));
  // The settings file as last listed or written.
  let settingsSha = null;

  return {
    bookmarks: createGitHubBookmarkStore(config, githubApi),
    label: `github:${config.owner}/${config.repo}@${config.branch}`,
    liveReload: false,

    // One API call (the recursive Git Trees endpoint) for the whole repo.
    // Notes come from the configured directories only; attachments from
    // anywhere, since Obsidian keeps them wherever its settings say.
    async listAll() {
      const tree = await githubApi(
        `/repos/${config.owner}/${config.repo}/git/trees/${config.branch}?recursive=1`,
        config.token
      );
      const blobs = tree.tree.filter(item => item.type === "blob" && !IGNORED_DIR_RE.test(item.path));
      const settings = blobs.find(item => item.path === SETTINGS_NAME);
      settingsSha = settings ? settings.sha : null;
      return {
        notes: blobs
          .filter(item => isMarkdown(item.path) && inDirs(item.path))
          .map(item => ({ id: item.path, version: item.sha })),
        assets: blobs.filter(item => !isMarkdown(item.path)).map(item => item.path),
        settings: settingsSha
      };
    },

    settingsLabel: `${config.owner}/${config.repo} → ${SETTINGS_NAME}`,

    // By blob sha, not raw.githubusercontent.com: that serves a file it
    // has seen for a few minutes after it changes.
    async readSettings(version) {
      const blob = await githubApi(`/repos/${config.owner}/${config.repo}/git/blobs/${version}`, config.token);
      return JSON.parse(Buffer.from(blob.content, "base64").toString("utf8"));
    },

    // Commits `saved` as the repo's settings file; returns its version.
    async writeSettings(saved) {
      // Not listed by this instance yet (a fresh one on Vercel): ask
      // GitHub, since replacing a file needs its current sha.
      if (!settingsSha) {
        try {
          settingsSha = (await githubApi(`/repos/${config.owner}/${config.repo}/contents/${SETTINGS_NAME}?ref=${encodeURIComponent(config.branch)}`, config.token)).sha;
        } catch (error) {
          if (error.status !== 404) throw error;
        }
      }
      try {
        const result = await githubApi(`/repos/${config.owner}/${config.repo}/contents/${SETTINGS_NAME}`, config.token, {
          method: "PUT",
          body: {
            message: "md2book settings",
            content: Buffer.from(JSON.stringify(saved, null, 2) + "\n").toString("base64"),
            branch: config.branch,
            ...(settingsSha ? { sha: settingsSha } : {})
          }
        });
        settingsSha = result.content.sha;
        return settingsSha;
      } catch (error) {
        if (error.status === 403 || error.status === 404) {
          throw new Error(`GitHub didn't let md2book save to ${config.owner}/${config.repo}. GITHUB_TOKEN needs "Contents: Read and write" on that repository.`);
        }
        if (error.status === 409) {
          throw new Error(`${SETTINGS_NAME} changed in ${config.owner}/${config.repo} meanwhile. Reload this page and try again.`);
        }
        throw error;
      }
    },

    async readFile(id) {
      const res = await fetch(rawUrl(id), { headers: { Authorization: `token ${config.token}` } });
      if (!res.ok) {
        throw new Error(`Could not fetch "${id}" from GitHub: ${res.status}`);
      }
      return res.text();
    },

    // `range`: {start, end} bytes, passed on to GitHub (answers 206).
    async readAsset(p, range) {
      const headers = { Authorization: `token ${config.token}` };
      if (range) headers.Range = `bytes=${range.start}-${range.end}`;
      const res = await fetch(rawUrl(p), { headers });
      if (!res.ok || !res.body) return null;
      const total = /\/(\d+)$/.exec(res.headers.get("content-range") || "");
      return {
        stream: Readable.fromWeb(res.body),
        size: Number(res.headers.get("content-length")) || null,
        ...(res.status === 206 && total ? { range: { ...range, total: Number(total[1]) } } : {})
      };
    }
  };
}

function createLocalSource(rootDir) {
  return {
    bookmarks: createFileBookmarkStore(rootDir, process.env.EPUB_NOTES_DIR || undefined),
    label: `local:${rootDir}`,
    liveReload: true,
    rootDir,

    async listAll() {
      const notes = [];
      const assets = [];
      // Folder by folder, never into the ignored ones (.git can hold as many
      // files as the notes).
      async function walk(dir) {
        let dirents;
        try { dirents = await fsp.readdir(dir, { withFileTypes: true }); }
        catch { return; }
        await Promise.all(dirents.map(async dirent => {
          const filePath = path.join(dir, dirent.name);
          const rel = path.relative(rootDir, filePath).split(path.sep).join("/");
          if (IGNORED_DIR_RE.test(rel)) return;
          if (dirent.isDirectory()) return walk(filePath);
          if (!dirent.isFile()) return;
          if (isMarkdown(rel)) {
            const stat = await fsp.stat(filePath);
            // The file's own dates, for notes without created/updated.
            notes.push({ id: rel, version: stat.mtimeMs, created: stat.birthtime, updated: stat.mtime });
          } else {
            assets.push(rel);
          }
        }));
      }
      await walk(rootDir);
      // One fixed order, whichever folder is read first.
      notes.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      assets.sort();
      return { notes, assets };
    },

    async readFile(id) {
      return fsp.readFile(path.join(rootDir, id), "utf8");
    },

    async readAsset(p, range) {
      // Only ever called with a path from listAll(); still, never leave
      // the vault.
      const full = path.resolve(rootDir, p);
      if (!full.startsWith(path.resolve(rootDir) + path.sep)) return null;
      try {
        const stat = await fsp.stat(full);
        if (!range) return { stream: fs.createReadStream(full), size: stat.size };
        const end = Math.min(range.end, stat.size - 1);
        return { stream: fs.createReadStream(full, { start: range.start, end }), size: end - range.start + 1,
          range: { start: range.start, end, total: stat.size } };
      } catch {
        return null;
      }
    }
  };
}

// A GitHub-backed source when GITHUB_OWNER/GITHUB_REPO/GITHUB_TOKEN are
// set (a deployment reading notes from a repo), otherwise a local folder.
export function createEntrySource(localDir) {
  const githubConfig = githubConfigFromEnv();
  return githubConfig ? createGitHubSource(githubConfig) : createLocalSource(localDir);
}
