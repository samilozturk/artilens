#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const input = JSON.parse(await readStdin() || "{}");
const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const outDir = path.join(cwd, ".claude", "artilens");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "live.json"), JSON.stringify(input, null, 2));
const pct = input.context_window?.used_percentage ?? 0;
const model = input.model?.display_name || input.model?.id || "model";
process.stdout.write(`[${model}] context ${pct}%`);

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}
