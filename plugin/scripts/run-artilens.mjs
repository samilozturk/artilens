import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(scriptDir, "..");
const repoRoot = path.resolve(pluginRoot, "..");

export function runArtilens(args, input) {
  const explicit = process.env.ARTILENS_BIN;
  if (explicit) return spawnSync(explicit, args, { input, encoding: "utf8", shell: true, env: process.env });

  // Bundled into the plugin at build:plugin-bin time (see scripts/build-plugin-bin.mjs).
  // This is what makes hook scripts work after a marketplace install, since only
  // pluginRoot itself is copied to the plugin cache — packages/cli/dist and any
  // repo-root node_modules are not.
  const bundled = path.join(pluginRoot, "bin", "artilens");
  if (fs.existsSync(bundled)) {
    return spawnSync(process.execPath, [bundled, ...args], { input, encoding: "utf8", env: process.env });
  }

  const localJs = path.join(repoRoot, "packages", "cli", "dist", "src", "index.js");
  if (fs.existsSync(localJs)) {
    return spawnSync(process.execPath, [localJs, ...args], { input, encoding: "utf8", env: process.env });
  }

  const localBin = process.platform === "win32"
    ? path.join(repoRoot, "node_modules", ".bin", "artilens.cmd")
    : path.join(repoRoot, "node_modules", ".bin", "artilens");
  if (fs.existsSync(localBin)) {
    return spawnSync(localBin, args, { input, encoding: "utf8", shell: true, env: process.env });
  }

  return spawnSync("artilens", args, { input, encoding: "utf8", shell: true, env: process.env });
}

export function pipeResult(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 0;
}

export function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}
