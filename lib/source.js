import fs from "node:fs/promises";
import path from "node:path";

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

function createGitHubSource(config) {
  return {
    label: `github:${config.owner}/${config.repo}@${config.branch}`,
    liveReload: false,

    // Lists every Markdown file under the configured directories in one
    // API call (the recursive Git Trees endpoint), instead of walking
    // folders one by one.
    async listFiles() {
      const tree = await githubApi(
        `/repos/${config.owner}/${config.repo}/git/trees/${config.branch}?recursive=1`,
        config.token
      );

      const dirs = config.dirs;
      return tree.tree
        .filter(item =>
          item.type === "blob" &&
          item.path.toLowerCase().endsWith(".md") &&
          (dirs.length === 0 || dirs.some(dir => item.path === dir || item.path.startsWith(`${dir}/`)))
        )
        .map(item => ({ id: item.path, version: item.sha }));
    },

    async readFile(id) {
      const res = await fetch(
        `https://raw.githubusercontent.com/${config.owner}/${config.repo}/${config.branch}/${id.split("/").map(encodeURIComponent).join("/")}`,
        { headers: { Authorization: `token ${config.token}` } }
      );
      if (!res.ok) {
        throw new Error(`Could not fetch "${id}" from GitHub: ${res.status}`);
      }
      return res.text();
    }
  };
}

function createLocalSource(rootDir) {
  return {
    label: `local:${rootDir}`,
    liveReload: true,
    rootDir,

    async listFiles() {
      let dirents;
      try {
        dirents = await fs.readdir(rootDir, { withFileTypes: true, recursive: true });
      } catch {
        return [];
      }

      const files = [];
      for (const dirent of dirents) {
        if (!dirent.isFile() || !dirent.name.toLowerCase().endsWith(".md")) continue;
        const filePath = path.join(dirent.parentPath ?? dirent.path, dirent.name);
        const stat = await fs.stat(filePath);
        files.push({ id: path.relative(rootDir, filePath), version: stat.mtimeMs });
      }
      return files;
    },

    async readFile(id) {
      return fs.readFile(path.join(rootDir, id), "utf8");
    }
  };
}

// Picks a GitHub-backed source when GITHUB_OWNER/GITHUB_REPO/GITHUB_TOKEN
// are set (the Vercel deployment case), otherwise falls back to reading a
// local folder (the plain `npm run dev` case).
export function createEntrySource(localDir) {
  const githubConfig = githubConfigFromEnv();
  return githubConfig ? createGitHubSource(githubConfig) : createLocalSource(localDir);
}
