import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { captureArtifact, listArtifacts, pruneArtifacts, readText } from "./index.js";

async function tmpProject(): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), "artilens-reg-"));
}

describe("registry edge cases", () => {
  it("deduplicates identical content instead of adding a new version", async () => {
    const dir = await tmpProject();
    const html = "<title>Dup</title><h1>Dup</h1><p>same</p>";
    await captureArtifact({ projectDir: dir, content: html, scope: "test" });
    await captureArtifact({ projectDir: dir, content: html, scope: "test" });
    const items = await listArtifacts(dir);
    expect(items).toHaveLength(1);
    expect(items[0].versions).toHaveLength(1);
  });

  it("keeps meta.versions consistent with disk when keepLast is 0", async () => {
    const dir = await tmpProject();
    await captureArtifact({ projectDir: dir, content: "<title>Z</title><h1>Z</h1><p>a</p>", scope: "test" });
    await captureArtifact({ projectDir: dir, content: "<title>Z</title><h1>Z</h1><p>b</p>", scope: "test" });
    const result = await pruneArtifacts(dir, 0);
    expect(result.removed).toBe(2);
    const items = await listArtifacts(dir);
    // slice(-0) bug would have left versions in meta while deleting the files.
    expect(items[0].versions).toHaveLength(0);
  });

  it("records a git context tag and a source hash per version", async () => {
    const dir = await tmpProject();
    const meta = await captureArtifact({ projectDir: dir, content: "<title>G</title><h1>G</h1><p>x</p>", scope: "custom", tags: ["demo"] });
    const version = meta.versions.at(-1);
    expect(version?.source_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(version?.git).toBeDefined();
    expect(meta.tags).toContain("demo");
  });

  it("writes a human-readable index.md with scope, version, and summary", async () => {
    const dir = await tmpProject();
    await captureArtifact({ projectDir: dir, content: "<title>Idx</title><h1>Idx</h1><p>hello world</p>", scope: "lens", summary: "an index entry" });
    const index = await readText(path.join(dir, ".claude", "artifacts", "index.md"));
    expect(index).toContain("lens");
    expect(index).toContain("an index entry");
  });
});
