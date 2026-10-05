import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { IGNORED_DIR_RE, isMarkdown } from "./vault-files.js";

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
    dirs: (process.env.GITHUB_DIRS || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)
  };
}

async function githubApi(apiPath, token) {
  const res = await fetch(`${GITHUB_API}${apiPath}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${apiPath} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// Every source has the same shape:
//   listAll()        -> { notes: [{ id, version }], assets: [path] }
//                       (ids and paths relative to the vault, "/"-separated)
//   readFile(id)     -> the note's Markdown
//   readAsset(path)  -> { stream, size } for an attachment
function createGitHubSource(config) {
  const rawUrl = p =>
    `https://raw.githubusercontent.com/${config.owner}/${config.repo}/${config.branch}/${p.split("/").map(encodeURIComponent).join("/")}`;
  const inDirs = p => config.dirs.length === 0 ||
    config.dirs.some(dir => p === dir || p.startsWith(`${dir}/`));

  return {
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
      return {
        notes: blobs
          .filter(item => isMarkdown(item.path) && inDirs(item.path))
          .map(item => ({ id: item.path, version: item.sha })),
        assets: blobs.filter(item => !isMarkdown(item.path)).map(item => item.path)
      };
    },

    async readFile(id) {
      const res = await fetch(rawUrl(id), { headers: { Authorization: `token ${config.token}` } });
      if (!res.ok) {
        throw new Error(`Could not fetch "${id}" from GitHub: ${res.status}`);
      }
      return res.text();
    },

    async readAsset(p) {
      const res = await fetch(rawUrl(p), { headers: { Authorization: `token ${config.token}` } });
      if (!res.ok || !res.body) return null;
      return {
        stream: Readable.fromWeb(res.body),
        size: Number(res.headers.get("content-length")) || null
      };
    }
  };
}

function createLocalSource(rootDir) {
  return {
    label: `local:${rootDir}`,
    liveReload: true,
    rootDir,

    async listAll() {
      let dirents;
      try {
        dirents = await fsp.readdir(rootDir, { withFileTypes: true, recursive: true });
      } catch {
        return { notes: [], assets: [] };
      }

      const notes = [];
      const assets = [];
      for (const dirent of dirents) {
        if (!dirent.isFile()) continue;
        const filePath = path.join(dirent.parentPath ?? dirent.path, dirent.name);
        const rel = path.relative(rootDir, filePath).split(path.sep).join("/");
        if (IGNORED_DIR_RE.test(rel)) continue;
        if (isMarkdown(rel)) {
          const stat = await fsp.stat(filePath);
          // The file's own dates, for notes without created/updated.
          notes.push({ id: rel, version: stat.mtimeMs, created: stat.birthtime, updated: stat.mtime });
        } else {
          assets.push(rel);
        }
      }
      return { notes, assets };
    },

    async readFile(id) {
      return fsp.readFile(path.join(rootDir, id), "utf8");
    },

    async readAsset(p) {
      // Only ever called with a path from listAll(); still, never leave
      // the vault.
      const full = path.resolve(rootDir, p);
      if (!full.startsWith(path.resolve(rootDir) + path.sep)) return null;
      try {
        const stat = await fsp.stat(full);
        return { stream: fs.createReadStream(full), size: stat.size };
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
