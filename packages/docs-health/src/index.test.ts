import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeDocsHealth, writeDocsHealthData } from "./index.js";

describe("docs-health", () => {
  it("finds missing scripts, dead references, and skill hygiene issues", async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "artilens-docs-"));
    await fs.promises.mkdir(path.join(tmp, ".claude", "skills", "bad"), { recursive: true });
    await fs.promises.writeFile(path.join(tmp, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }), "utf8");
    await fs.promises.writeFile(path.join(tmp, "README.md"), "Run `pnpm run e2e` and see `missing/file.ts`.\n", "utf8");
    await fs.promises.writeFile(path.join(tmp, ".claude", "skills", "bad", "SKILL.md"), "# Missing frontmatter\n", "utf8");
    const report = await analyzeDocsHealth({ projectDir: tmp });
    expect(report.findings.map((finding) => finding.type)).toContain("missing-script");
    expect(report.findings.map((finding) => finding.type)).toContain("dead-reference");
    expect(report.findings.map((finding) => finding.type)).toContain("skill-hygiene");
  });
});

describe("writeDocsHealthData", () => {
  it("writes a valid JSON data file with the expected schema and no raw document text", async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "artilens-docs-data-"));
    await fs.promises.writeFile(path.join(tmp, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }), "utf8");
    await fs.promises.writeFile(path.join(tmp, "README.md"), "Run `pnpm run e2e` FAKE_SECRET_MARKER_xyz123 and see `missing/file.ts`.\n", "utf8");
    const report = await analyzeDocsHealth({ projectDir: tmp });
    const relative = path.join(".claude", "artilens", "docs-health.data.json");
    const { data, dataPath } = await writeDocsHealthData(report, relative, tmp);
    expect(dataPath).toBe(path.join(tmp, relative));
    expect(data.schema).toBe("artilens.docs-health.data/v1");
    const parsed = JSON.parse(await fs.promises.readFile(dataPath, "utf8"));
    expect(Array.isArray(parsed.findings)).toBe(true);
    expect(parsed.findings.map((f: { type: string }) => f.type)).toContain("missing-script");
    expect(JSON.stringify(parsed)).not.toContain("FAKE_SECRET_MARKER_xyz123");
  });

  it("honors an absolute dataPath unchanged", async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "artilens-docs-data-abs-"));
    const report = await analyzeDocsHealth({ projectDir: tmp, paths: [] });
    const absolute = path.join(tmp, "out", "docs-health.data.json");
    const { dataPath } = await writeDocsHealthData(report, absolute, tmp);
    expect(dataPath).toBe(absolute);
    expect(fs.existsSync(absolute)).toBe(true);
  });
});

