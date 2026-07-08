import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildLensData,
  calculateContextBreakdown,
  createLensReport,
  resolveMaxTokensForModel,
  resolveModelFromConfig,
  writeLensData
} from "./index.js";

async function fixtureTranscriptWithModel(tmp: string, model: string): Promise<string> {
  const transcript = path.join(tmp, "session.jsonl");
  const line = JSON.stringify({
    type: "assistant",
    message: { role: "assistant", model, content: [{ type: "text", text: "hi" }] }
  });
  await fs.promises.writeFile(transcript, `${line}\n`);
  return transcript;
}

async function fixtureTranscript(): Promise<{ tmp: string; transcript: string }> {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "artilens-lens-"));
  const transcript = path.join(tmp, "session.jsonl");
  await fs.promises.copyFile(path.resolve("fixtures", "transcripts", "simple.jsonl"), transcript);
  return { tmp, transcript };
}

describe("lens", () => {
  it("creates a decision and writes a scrubbed data contract from a transcript", async () => {
    const { tmp, transcript } = await fixtureTranscript();
    const report = await createLensReport({ session: transcript, projectDir: tmp });
    expect(report.healthScore).toBeGreaterThan(0);
    expect(report.decision.action).toBe("continue");
    expect(report.handoff).toContain("Run tests");
    const dataPath = path.join(tmp, "lens.data.json");
    const { dataPath: writtenPath } = await writeLensData({ session: transcript, projectDir: tmp, dataPath });
    // Sidecar is the scrubbed data contract (no raw transcript / analysis object).
    const sidecar = JSON.parse(await fs.promises.readFile(writtenPath, "utf8"));
    expect(sidecar.schema).toBe("artilens.lens.data/v1");
    expect("analysis" in sidecar).toBe(false);
  });
});

describe("calculateContextBreakdown", () => {
  it("scans project files and estimates correct token sizes for memory and skills", async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "artilens-breakdown-"));
    await fs.promises.writeFile(path.join(tmp, "CLAUDE.md"), "x".repeat(100));
    const rulesDir = path.join(tmp, ".claude", "rules");
    await fs.promises.mkdir(rulesDir, { recursive: true });
    await fs.promises.writeFile(path.join(rulesDir, "test-rule.md"), "y".repeat(200));
    const skillsDir = path.join(tmp, ".claude", "skills", "test-skill");
    await fs.promises.mkdir(skillsDir, { recursive: true });
    await fs.promises.writeFile(path.join(skillsDir, "SKILL.md"), "z".repeat(300));

    // Case 1: unscaled path (activeInput >= staticSum of 22026)
    const mockAnalysisUnscaled = {
      lineCount: 1,
      parseErrors: 0,
      unknownLines: 0,
      messages: [],
      userPromptTopics: [],
      subagentPaths: [],
      modelUsage: {},
      lineChanges: { added: 0, removed: 0 },
      toolCalls: [],
      fileReads: {},
      todos: [],
      usage: {
        inputTokens: 5000,
        outputTokens: 50,
        cacheCreationInputTokens: 5000,
        cacheReadInputTokens: 15000,
        estimatedTokens: 0
      }
    };

    const breakdownUnscaled = await calculateContextBreakdown(tmp, mockAnalysisUnscaled, 200000);
    expect(breakdownUnscaled.systemPrompt).toBe(6900);
    expect(breakdownUnscaled.systemTools).toBe(13600);
    expect(breakdownUnscaled.memoryFiles).toBe(63);
    expect(breakdownUnscaled.skills).toBe(1463);
    // Messages = activeInput (25000) - staticSum (22026) = 2974
    expect(breakdownUnscaled.messages).toBe(2974);

    // Case 2: scaled path (activeInput < staticSum)
    const mockAnalysisScaled = {
      lineCount: 1,
      parseErrors: 0,
      unknownLines: 0,
      messages: [],
      userPromptTopics: [],
      subagentPaths: [],
      modelUsage: {},
      lineChanges: { added: 0, removed: 0 },
      toolCalls: [],
      fileReads: {},
      todos: [],
      usage: {
        inputTokens: 1013,
        outputTokens: 50,
        cacheCreationInputTokens: 2000,
        cacheReadInputTokens: 8000,
        estimatedTokens: 0
      }
    };

    const breakdownScaled = await calculateContextBreakdown(tmp, mockAnalysisScaled, 200000);
    // activeInput = 11013 (exactly 50% of staticSum 22026)
    expect(breakdownScaled.systemPrompt).toBe(3450);
    expect(breakdownScaled.systemTools).toBe(6800);
    expect(breakdownScaled.memoryFiles).toBe(32);
    expect(breakdownScaled.skills).toBe(732);
    expect(breakdownScaled.messages).toBe(0);

    // Clean up
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });
});

describe("buildLensData", () => {
  it("carries every mandatory field the artifact must visualize", async () => {
    const { tmp, transcript } = await fixtureTranscript();
    const report = await createLensReport({ session: transcript, projectDir: tmp });
    const data = buildLensData(report);
    expect(data.schema).toBe("artilens.lens.data/v1");
    expect(data.healthScore).toBe(report.healthScore);
    expect(data.usedPercentage).toBe(report.usedPercentage);
    expect(data.usedPercentageEstimated).toBe(report.usedPercentageEstimated);
    expect(data.maxTokens).toBe(report.maxTokens);
    expect(data.decision.action).toBe(report.decision.action);
    expect(data.handoff).toBe(report.handoff);
    expect(typeof data.rereadRatio).toBe("number");
    expect(typeof data.topicDrift).toBe("number");
    expect(data.breakdown.systemPrompt).toBe(report.breakdown.systemPrompt);
    expect(data.usage.inputTokens).toBe(report.analysis.usage.inputTokens);
    expect(Array.isArray(data.toolCalls)).toBe(true);
    expect(Array.isArray(data.fileReads)).toBe(true);
    expect(data.messageCount).toBe(report.analysis.messages.length);
  });

  it("scrubs raw transcript structures (no messages, examples, topics, or paths)", async () => {
    const { tmp, transcript } = await fixtureTranscript();
    const report = await createLensReport({ session: transcript, projectDir: tmp });
    const data = buildLensData(report);
    const keys = Object.keys(data);
    expect(keys).not.toContain("analysis");
    expect(keys).not.toContain("messages");
    expect(keys).not.toContain("userPromptTopics");
    expect(keys).not.toContain("subagentPaths");
    const serialized = JSON.stringify(data);
    // toolCalls[].examples can hold raw tool inputs; they must not leak into the data contract.
    expect(serialized).not.toContain("\"examples\"");
    for (const row of data.toolCalls) {
      expect(Object.keys(row).sort()).toEqual(["count", "inputBytes", "name", "outputBytes"]);
    }
  });

  it("flags repeat-read files", async () => {
    const { tmp, transcript } = await fixtureTranscript();
    const report = await createLensReport({ session: transcript, projectDir: tmp });
    report.analysis.fileReads = { "src/hot.ts": 5, "src/cold.ts": 1 };
    const data = buildLensData(report);
    const hot = data.fileReads.find((row) => row.file === "src/hot.ts");
    const cold = data.fileReads.find((row) => row.file === "src/cold.ts");
    expect(hot?.repeatRead).toBe(true);
    expect(cold?.repeatRead).toBe(false);
  });
});

describe("resolveMaxTokensForModel", () => {
  it("maps Haiku to the 200K window", () => {
    expect(resolveMaxTokensForModel("claude-haiku-4-5-20251001")).toBe(200000);
    expect(resolveMaxTokensForModel("claude-haiku-4-5")).toBe(200000);
  });

  it("maps every other current-generation model to the observed autocompact window (967K)", () => {
    expect(resolveMaxTokensForModel("claude-sonnet-5")).toBe(967000);
    expect(resolveMaxTokensForModel("claude-opus-4-8")).toBe(967000);
    expect(resolveMaxTokensForModel("claude-fable-5")).toBe(967000);
    expect(resolveMaxTokensForModel("sonnet")).toBe(967000);
  });
});

describe("resolveModelFromConfig", () => {
  it("reads the model field from .claude/settings.json", async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "artilens-model-config-"));
    await fs.promises.mkdir(path.join(tmp, ".claude"), { recursive: true });
    await fs.promises.writeFile(path.join(tmp, ".claude", "settings.json"), JSON.stringify({ model: "opus" }));
    expect(resolveModelFromConfig(tmp)).toBe("opus");
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });

  it("falls back to sonnet when no settings file declares a model", async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "artilens-model-config-"));
    // Pass tmp as the home dir too so the lookup stays hermetic and never reads the
    // real ~/.claude/settings.json (which may declare a model on the dev's machine).
    expect(resolveModelFromConfig(tmp, tmp)).toBe("sonnet");
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });

  it("reads the home ~/.claude/settings.json when the project has none", async () => {
    const project = await fs.promises.mkdtemp(path.join(os.tmpdir(), "artilens-proj-"));
    const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "artilens-home-"));
    await fs.promises.mkdir(path.join(home, ".claude"), { recursive: true });
    await fs.promises.writeFile(path.join(home, ".claude", "settings.json"), JSON.stringify({ model: "haiku" }));
    expect(resolveModelFromConfig(project, home)).toBe("haiku");
    await fs.promises.rm(project, { recursive: true, force: true });
    await fs.promises.rm(home, { recursive: true, force: true });
  });
});

describe("createLensReport maxTokens resolution", () => {
  it("uses the transcript's active model to pick maxTokens (Haiku -> 200K)", async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "artilens-maxtokens-"));
    const transcript = await fixtureTranscriptWithModel(tmp, "claude-haiku-4-5-20251001");
    const report = await createLensReport({ session: transcript, projectDir: tmp });
    expect(report.maxTokens).toBe(200000);
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });

  it("uses the transcript's active model to pick maxTokens (Opus -> 967K)", async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "artilens-maxtokens-"));
    const transcript = await fixtureTranscriptWithModel(tmp, "claude-opus-4-8");
    const report = await createLensReport({ session: transcript, projectDir: tmp });
    expect(report.maxTokens).toBe(967000);
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });

  it("prefers live context_window.context_window_size over the model guess", async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "artilens-maxtokens-"));
    const transcript = await fixtureTranscriptWithModel(tmp, "claude-haiku-4-5-20251001");
    const livePath = path.join(tmp, "live.json");
    await fs.promises.writeFile(
      livePath,
      JSON.stringify({ context_window: { context_window_size: 1000000, used_percentage: 12 } })
    );
    const report = await createLensReport({ session: transcript, projectDir: tmp, livePath });
    expect(report.maxTokens).toBe(1000000);
    expect(report.usedPercentage).toBe(12);
    expect(report.usedPercentageEstimated).toBe(false);
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });

  it("ignores a live payload's stale max_tokens field name (real field is context_window_size)", async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "artilens-maxtokens-"));
    const transcript = await fixtureTranscriptWithModel(tmp, "claude-opus-4-8");
    const livePath = path.join(tmp, "live.json");
    await fs.promises.writeFile(livePath, JSON.stringify({ context_window: { max_tokens: 200000 } }));
    const report = await createLensReport({ session: transcript, projectDir: tmp, livePath });
    // max_tokens is not a real statusline field; falls through to the model-based guess (Opus -> 967K).
    expect(report.maxTokens).toBe(967000);
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });
});

describe("calculateContextBreakdown large-context calibration", () => {
  it("uses the large-context overhead constants when maxTokens is at the 967K autocompact window", async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "artilens-breakdown-large-"));
    const mockAnalysis = {
      lineCount: 1,
      parseErrors: 0,
      unknownLines: 0,
      messages: [],
      userPromptTopics: [],
      subagentPaths: [],
      modelUsage: {},
      lineChanges: { added: 0, removed: 0 },
      toolCalls: [],
      fileReads: {},
      todos: [],
      usage: {
        inputTokens: 40000,
        outputTokens: 50,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        estimatedTokens: 0
      }
    };
    const breakdown = await calculateContextBreakdown(tmp, mockAnalysis, 967000);
    expect(breakdown.systemPrompt).toBe(9500);
    expect(breakdown.systemTools).toBe(11300);
    // builtinSkills (8500) folds into skills; no project skills dir here, so skills == builtinSkills.
    expect(breakdown.skills).toBe(8500);
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });
});

describe("writeLensData", () => {
  it("resolves a relative dataPath against projectDir and writes valid JSON", async () => {
    const { tmp, transcript } = await fixtureTranscript();
    const relative = path.join(".claude", "artilens", "lens.data.json");
    const { dataPath } = await writeLensData({ session: transcript, projectDir: tmp, dataPath: relative });
    expect(dataPath).toBe(path.join(tmp, relative));
    const parsed = JSON.parse(await fs.promises.readFile(dataPath, "utf8"));
    expect(parsed.schema).toBe("artilens.lens.data/v1");
  });

  it("honors an absolute dataPath unchanged", async () => {
    const { tmp, transcript } = await fixtureTranscript();
    const absolute = path.join(tmp, "out", "lens.data.json");
    const { dataPath } = await writeLensData({ session: transcript, projectDir: tmp, dataPath: absolute });
    expect(dataPath).toBe(absolute);
    expect(fs.existsSync(absolute)).toBe(true);
  });
});

