import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { captureArtifact, diffArtifactVersions, listArtifacts, parseTranscriptText, pruneArtifacts, readText } from "./index.js";

describe("core transcript parser", () => {
  it("keeps partial results across bad JSON and unknown lines", () => {
    const transcript = [
      JSON.stringify({ type: "user", message: { role: "user", content: "Please edit src/app.ts", usage: { input_tokens: 10, output_tokens: 0 } } }),
      "{bad-json",
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: { file_path: "src/app.ts" } }, { type: "tool_use", name: "TodoWrite", input: { todos: [{ text: "Run tests", status: "todo" }] } }] } })
    ].join("\n");
    const analysis = parseTranscriptText(transcript);
    expect(analysis.parseErrors).toBe(1);
    expect(analysis.fileReads["src/app.ts"]).toBe(1);
    expect(analysis.todos[0].text).toContain("Run tests");
    expect(analysis.usage.inputTokens).toBe(10);
  });
});

describe("core registry", () => {
  it("captures versions, indexes them, diffs them, and prunes", async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "artilens-registry-"));
    await captureArtifact({ projectDir: tmp, content: "<title>Demo</title><h1>Demo</h1><p>one</p>", scope: "test" });
    await captureArtifact({ projectDir: tmp, content: "<title>Demo</title><h1>Demo</h1><p>two</p>", scope: "test" });
    const artifacts = await listArtifacts(tmp);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].versions).toHaveLength(2);
    const diff = await diffArtifactVersions(tmp, "demo", 1, 2);
    expect(diff).toContain("Artifact diff");
    const index = await readText(path.join(tmp, ".claude", "artifacts", "index.md"));
    expect(index).toContain("demo");
    const pruned = await pruneArtifacts(tmp, 1);
    expect(pruned.removed).toBe(1);
  });
});

