import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectContextFiles, collectSessionView, collectTodos, writeSessionData } from "./index.js";
import { parseTranscriptFile } from "@artilens/core";

describe("session-viz", () => {
  it("collects transcript and plan todos", async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "artilens-session-"));
    const transcript = path.join(tmp, "session.jsonl");
    await fs.promises.copyFile(path.resolve("fixtures", "transcripts", "simple.jsonl"), transcript);
    await fs.promises.writeFile(path.join(tmp, "PLAN.md"), "- [ ] Ship feature\n- [x] Create plan\n", "utf8");
    const analysis = await parseTranscriptFile(transcript);
    const todos = await collectTodos(analysis, tmp);
    expect(todos.map((todo) => todo.text).join(" ")).toContain("Ship feature");
  });

  it("collects the commands catalog with built-ins", async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "artilens-commands-"));
    const data = await collectSessionView({ kind: "commands", projectDir: tmp });
    expect(data.commands?.map((command) => command.name)).toContain("/compact");
  });

  it("collects the context-files inventory", async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "artilens-context-files-"));
    await fs.promises.writeFile(path.join(tmp, "CLAUDE.md"), "# Test project\n", "utf8");
    const files = await collectContextFiles(
      { fileReads: {}, todos: [], toolCalls: [], messages: [], lineCount: 0, parseErrors: 0, unknownLines: 0, usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, estimatedTokens: 0 }, userPromptTopics: [], subagentPaths: [], modelUsage: {}, lineChanges: { added: 0, removed: 0 } },
      tmp
    );
    expect(files.map((file) => file.file)).toContain("CLAUDE.md");
    expect(files[0]).toMatchObject({ file: "CLAUDE.md", loaded: true, reads: 0, status: "loaded-unused" });
  });

  it("includes plugin/skills SKILL.md files in the context-files inventory (not just .claude/skills)", async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "artilens-context-files-plugin-skills-"));
    await fs.promises.mkdir(path.join(tmp, "plugin", "skills", "demo"), { recursive: true });
    await fs.promises.writeFile(path.join(tmp, "plugin", "skills", "demo", "SKILL.md"), "---\nname: demo\n---\nbody\n", "utf8");
    const files = await collectContextFiles(
      { fileReads: {}, todos: [], toolCalls: [], messages: [], lineCount: 0, parseErrors: 0, unknownLines: 0, usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, estimatedTokens: 0 }, userPromptTopics: [], subagentPaths: [], modelUsage: {}, lineChanges: { added: 0, removed: 0 } },
      tmp
    );
    expect(files.map((file) => file.file)).toContain(path.join("plugin", "skills", "demo", "SKILL.md").replace(/\\/g, "/"));
  });
});

describe("collectSessionView / writeSessionData", () => {
  it("collects a valid data contract per kind and writes it as JSON", async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "artilens-session-data-"));
    await fs.promises.writeFile(path.join(tmp, "PLAN.md"), "- [ ] Ship feature\n- [x] Create plan\n", "utf8");
    const relative = path.join(".claude", "artilens", "session-todos.data.json");
    const { data, dataPath } = await writeSessionData({ kind: "todos", projectDir: tmp, dataPath: relative });
    expect(dataPath).toBe(path.join(tmp, relative));
    expect(data.schema).toBe("artilens.session.data/v1");
    expect(data.kind).toBe("todos");
    const parsed = JSON.parse(await fs.promises.readFile(dataPath, "utf8"));
    expect(parsed.todos.map((todo: { text: string }) => todo.text).join(" ")).toContain("Ship feature");
  });

  it("honors an absolute dataPath unchanged", async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "artilens-session-data-abs-"));
    const absolute = path.join(tmp, "out", "commands.data.json");
    const { dataPath } = await writeSessionData({ kind: "commands", projectDir: tmp, dataPath: absolute });
    expect(dataPath).toBe(absolute);
    expect(fs.existsSync(absolute)).toBe(true);
  });

  it("does not leak raw transcript message text into the todos data contract", async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "artilens-session-scrub-"));
    const transcript = path.join(tmp, "session.jsonl");
    const line = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "FAKE_SECRET_MARKER_xyz123 unrelated chatter" }] }
    });
    await fs.promises.writeFile(transcript, `${line}\n`, "utf8");
    const data = await collectSessionView({ kind: "todos", projectDir: tmp, transcriptPath: transcript });
    expect(JSON.stringify(data)).not.toContain("FAKE_SECRET_MARKER_xyz123");
    expect(Object.keys(data)).not.toContain("agents");
    expect(Object.keys(data)).not.toContain("commands");
  });
});

