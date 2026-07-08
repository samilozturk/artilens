#!/usr/bin/env node
// Bundles the compiled CLI (packages/cli/dist) plus all @artilens/* workspace
// packages into one self-contained file inside plugin/bin/. Skills and hooks
// launch it through plugin/scripts/run-artilens.mjs, so marketplace installs do
// not need a global npm package and do not reach outside the plugin cache.
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
