import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
}

export async function readText(filePath: string): Promise<string> {
  return fs.promises.readFile(filePath, "utf8");
}

export async function writeText(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.promises.writeFile(filePath, content, "utf8");
}

export async function appendJsonl(filePath: string, record: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.promises.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

export function resolveClaudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

export async function findFiles(root: string, predicate: (filePath: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (predicate(full)) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out.sort();
}

export async function newestFile(files: string[]): Promise<string | undefined> {
  const stats = await Promise.all(
    files.map(async (file) => ({ file, stat: await fs.promises.stat(file) }))
  );
  return stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0]?.file;
}

export function projectKeyFromCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

