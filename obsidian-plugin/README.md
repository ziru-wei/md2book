# MD to Book for Obsidian

A button at the right end of the status bar (and the command "Open MD to Book") that opens the reader in a main tab. The plugin starts the local md2book server on this vault and stops it when the plugin unloads; while the server runs, a stop button next to it stops it (and closes the reader).

Desktop only. Needs Node 20.12+ and `npm install` done once in the repository.

## Install

Symlink this folder into the vault, then enable "MD to Book" under Community plugins:

```bash
ln -s /path/to/md2book/obsidian-plugin /path/to/vault/.obsidian/plugins/md2book
```

With the symlink the plugin finds the repository by itself; otherwise set "md2book folder" in its settings.
