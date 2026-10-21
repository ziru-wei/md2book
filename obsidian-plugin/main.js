// MD to Book for Obsidian: a status-bar button (bottom right) that opens the reader in a main
// tab. It starts `bin/md2book.js` (from the repository this plugin lives in)
// on the vault folder, and stops it when Obsidian closes the plugin — or when
// the stop button next to it is clicked.
const { Plugin, ItemView, PluginSettingTab, Setting, setIcon } = require("obsidian");
const { spawn, execFile } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

const VIEW_TYPE = "md2book-reader";
const ICON = "library-big";
const STOP_ICON = "square";
const DEFAULTS = { repoPath: "", nodePath: "", port: 3210, notesPath: "" };

const ping = port => new Promise(resolve => {
  const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 800 }, res => { res.resume(); resolve(true); });
  req.on("error", () => resolve(false));
  req.on("timeout", () => { req.destroy(); resolve(false); });
});

// The md2book server listening on `port` that this plugin did not start (one
// left from before Obsidian reloaded, or started by hand): its process id.
const serverPid = port => new Promise(resolve => {
  if (process.platform === "win32") return resolve(null);
  execFile("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], (error, out) => {
    const pid = Number(String(out || "").trim().split("\n")[0]);
    if (error || !pid) return resolve(null);
    execFile("ps", ["-p", String(pid), "-o", "command="], (e, command) => resolve(!e && /md2book/.test(String(command)) ? pid : null));
  });
});

// Obsidian started from the Dock has a bare PATH: ask a login shell for node.
const findNode = () => new Promise(resolve => {
  if (process.platform === "win32") return resolve("node");
  execFile(process.env.SHELL || "/bin/zsh", ["-lc", "command -v node"], (error, out) => {
    const found = String(out || "").trim().split("\n").pop();
    resolve(!error && found ? found : "/opt/homebrew/bin/node");
  });
});

class ReaderView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "MD to Book"; }
  getIcon() { return ICON; }
  async onOpen() {
    this.contentEl.empty();
    this.contentEl.style.padding = "0";
    this.contentEl.style.overflow = "hidden";
    const status = this.contentEl.createDiv({ text: "Starting MD to Book…" });
    status.style.padding = "1em";
    try {
      const port = await this.plugin.ensureServer();
      status.remove();
      const frame = this.contentEl.createEl("iframe");
      frame.src = `http://localhost:${port}/`;
      frame.style.cssText = "width:100%;height:100%;border:0;";
    } catch (error) {
      status.setText(String(error.message || error));
    }
  }
}

module.exports = class Md2BookPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.registerView(VIEW_TYPE, leaf => new ReaderView(leaf, this));
    this.addCommand({ id: "open", name: "Open MD to Book", callback: () => this.openReader() });
    // The far right of the status bar, after every other plugin's item.
    const item = this.addStatusBarItem();
    item.style.order = "999";
    item.addClass("mod-clickable");
    item.setAttr("aria-label", "MD to Book");
    setIcon(item, ICON);
    item.addEventListener("click", () => this.openReader());
    // Next to it, while the server runs: stop it (and close the reader).
    this.stopItem = this.addStatusBarItem();
    this.stopItem.style.order = "1000";
    this.stopItem.addClass("mod-clickable");
    this.stopItem.setAttr("aria-label", "Stop the MD to Book server");
    setIcon(this.stopItem, STOP_ICON);
    this.stopItem.addEventListener("click", () => this.stopAll());
    this.stopItem.hide();
    this.app.workspace.onLayoutReady(() => this.refreshStop());
    this.addSettingTab(new Md2BookSettings(this.app, this));
  }

  port() { return Number(this.settings.port) || DEFAULTS.port; }

  // The stop button shows while something answers on the port.
  async refreshStop() {
    this.stopItem.toggle(Boolean(this.child) || await ping(this.port()));
  }

  async stopAll() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
    if (this.child) this.stopServer();
    else {
      const pid = await serverPid(this.port());
      if (pid) try { process.kill(pid); } catch { /* gone already */ }
    }
    for (let i = 0; i < 20 && await ping(this.port()); i++) await new Promise(r => setTimeout(r, 150));
    this.refreshStop();
  }

  onunload() { this.stopServer(); }

  async openReader() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (existing) return this.app.workspace.revealLeaf(existing);
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  vaultPath() { return this.app.vault.adapter.getBasePath(); }

  // The md2book folder: the setting, else the repository this plugin is
  // symlinked from (<repo>/obsidian-plugin).
  repoPath() {
    if (this.settings.repoPath) return this.settings.repoPath;
    const dir = path.join(this.vaultPath(), this.app.vault.configDir, "plugins", this.manifest.id);
    try { return path.dirname(fs.realpathSync(dir)); } catch { return ""; }
  }

  async ensureServer() {
    const port = this.port();
    if (this.child || await ping(port)) { this.stopItem.show(); return port; }
    const repo = this.repoPath();
    const script = repo && path.join(repo, "bin", "md2book.js");
    if (!script || !fs.existsSync(script)) {
      throw new Error("MD to Book: set the md2book folder in the plugin's settings (or symlink this plugin from the repository).");
    }
    const node = this.settings.nodePath || await findNode();
    const notes = this.settings.notesPath || this.vaultPath();
    let log = "";
    const child = spawn(node, [script, notes, "--port", String(port), "--no-open"], { cwd: repo });
    this.child = child;
    child.stdout.on("data", d => { log += d; });
    child.stderr.on("data", d => { log += d; });
    child.on("exit", () => { if (this.child === child) { this.child = null; this.refreshStop(); } });
    child.on("error", e => { log += e.message; });
    for (let i = 0; i < 60; i++) {
      if (await ping(port)) { this.stopItem.show(); return port; }
      if (!this.child) throw new Error(`MD to Book did not start:\n${log.trim() || "(no output)"}`);
      await new Promise(r => setTimeout(r, 250));
    }
    this.stopServer();
    throw new Error(`MD to Book did not start in time:\n${log.trim()}`);
  }

  stopServer() {
    if (this.child) { this.child.kill(); this.child = null; }
  }
};

class Md2BookSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl: el, plugin } = this;
    el.empty();
    const field = (name, desc, key, placeholder) => new Setting(el).setName(name).setDesc(desc)
      .addText(text => text.setPlaceholder(placeholder).setValue(String(plugin.settings[key] ?? ""))
        .onChange(async value => { plugin.settings[key] = key === "port" ? Number(value) || DEFAULTS.port : value.trim(); await plugin.saveData(plugin.settings); }));
    field("md2book folder", "Where the md2book repository is. Empty: the repository this plugin is symlinked from.", "repoPath", plugin.repoPath() || "/path/to/md2book");
    field("Node path", "Empty: found through your login shell.", "nodePath", "/opt/homebrew/bin/node");
    field("Port", "Local port for the reader (takes effect after restarting the plugin).", "port", String(DEFAULTS.port));
    field("Notes folder", "Empty: this vault.", "notesPath", plugin.vaultPath());
  }
}
