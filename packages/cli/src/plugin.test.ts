import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("plugin package", () => {
  it("declares skills, hooks, and no MCP server", async () => {
    const manifest = JSON.parse(await fs.promises.readFile(path.resolve("plugin", ".claude-plugin", "plugin.json"), "utf8"));
    expect(manifest.name).toBe("artilens");
    expect(JSON.stringify(manifest).toLowerCase()).not.toContain("mcpservers");
    const hooks = JSON.parse(await fs.promises.readFile(path.resolve("plugin", "hooks", "hooks.json"), "utf8"));
    expect(hooks.hooks.PostToolUse[0].matcher).toBe("Artifact");
  });

  it("keeps skill frontmatter complete and bodies thin", async () => {
    const root = path.resolve("plugin", "skills");
    const files = await skillFiles(root);
    expect(files.length).toBeGreaterThanOrEqual(14);
    for (const file of files) {
      const text = await fs.promises.readFile(file, "utf8");
      const frontmatter = /^---\r?\n([\s\S]+?)\r?\n---/.exec(text)?.[1] ?? "";
      const body = text.replace(/^---\r?\n[\s\S]+?\r?\n---\r?\n?/, "");
      expect(frontmatter, file).toMatch(/^name:/m);
      expect(frontmatter, file).toMatch(/^description:/m);
      expect(frontmatter, file).toMatch(/^allowed-tools:/m);
      expect(body.split(/\r?\n/).length, file).toBeLessThanOrEqual(60);
    }
  });
});

async function skillFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name === "SKILL.md") out.push(full);
    }
  }
  await walk(root);
  return out;
}
