#!/usr/bin/env node
// Bundles the compiled CLI (packages/cli/dist) plus all @artilens/* workspace
// packages into one self-contained file inside plugin/bin/. Claude Code adds a
// plugin's bin/ directory to the Bash tool's PATH while the plugin is enabled,
// so this is what lets skills invoke a bare `artilens` command after the
// plugin is installed from a marketplace, without publishing to npm and
// without the plugin reaching outside its own directory (which the plugin
// cache does not preserve).
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const entry = path.join(repoRoot, "packages/cli/dist/src/index.js");
const outfile = path.join(repoRoot, "plugin/bin/artilens");

if (!fs.existsSync(entry)) {
  console.error(`Missing ${entry} — run "pnpm build" first.`);
  process.exit(1);
}

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  logLevel: "warning"
});

// The compiled entry already starts with its own shebang line, which esbuild
// preserves as-is; adding a banner would duplicate it and break parsing.

fs.chmodSync(outfile, 0o755);
console.log(`Wrote ${path.relative(repoRoot, outfile)} (${(fs.statSync(outfile).size / 1024).toFixed(1)} KiB)`);
