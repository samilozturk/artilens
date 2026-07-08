import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { TranscriptAnalysis, ToolCallSummary } from "@artilens/core";
import {
  resolveModelPricing,
  estimateLinesChanged,
  groupMcpServers,
  groupSkillUsage,
  buildUsageReport,
  buildUsageData,
  writeUsageData
} from "./usage.js";

function baseAnalysis(overrides: Partial<TranscriptAnalysis> = {}): TranscriptAnalysis {
  return {
    lineCount: 0,
    parseErrors: 0,
    unknownLines: 0,
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, estimatedTokens: 0 },
    toolCalls: [],
    fileReads: {},
    todos: [],
    userPromptTopics: [],
    subagentPaths: [],
    modelUsage: {},
    lineChanges: { added: 0, removed: 0 },
    ...overrides
  };
}

describe("resolveModelPricing", () => {
  it("matches known model families by substring", () => {
    expect(resolveModelPricing("claude-sonnet-5")).toEqual({ inputPerMTok: 3, outputPerMTok: 15 });
    expect(resolveModelPricing("claude-opus-4-8")).toEqual({ inputPerMTok: 5, outputPerMTok: 25 });
    expect(resolveModelPricing("claude-haiku-4-5-20251001")).toEqual({ inputPerMTok: 1, outputPerMTok: 5 });
    expect(resolveModelPricing("claude-fable-5")).toEqual({ inputPerMTok: 10, outputPerMTok: 50 });
  });

  it("returns undefined for an unrecognized model id", () => {
    expect(resolveModelPricing("some-future-model")).toBeUndefined();
  });
});

describe("estimateLinesChanged", () => {
  it("reads the transcript parser's lineChanges tally", () => {
    const analysis = baseAnalysis({ lineChanges: { added: 6, removed: 2 } });
    const result = estimateLinesChanged(analysis);
    expect(result).toEqual({ linesAdded: 6, linesRemoved: 2 });
  });

  it("returns zero for a transcript with no recorded line changes", () => {
    const result = estimateLinesChanged(baseAnalysis());
    expect(result).toEqual({ linesAdded: 0, linesRemoved: 0 });
  });
});

describe("groupMcpServers", () => {
  it("groups tool calls by mcp__<server>__ prefix and computes byte share", () => {
    const toolCalls: ToolCallSummary[] = [
      { name: "mcp__chrome-devtools__take_screenshot", inputBytes: 10, outputBytes: 90, count: 1, examples: [] },
      { name: "mcp__chrome-devtools__click", inputBytes: 5, outputBytes: 5, count: 1, examples: [] },
      { name: "Read", inputBytes: 0, outputBytes: 100, count: 1, examples: [] }
    ];
    const rows = groupMcpServers(toolCalls);
    expect(rows.length).toBe(1);
    expect(rows[0].server).toBe("chrome-devtools");
    expect(rows[0].toolCalls).toBe(2);
    expect(rows[0].bytes).toBe(110);
    expect(rows[0].pctOfToolBytes).toBeCloseTo(110 / 210, 4);
  });

  it("returns an empty array when there are no MCP tool calls", () => {
    expect(groupMcpServers([{ name: "Read", inputBytes: 0, outputBytes: 10, count: 1, examples: [] }])).toEqual([]);
  });

  it("handles server segments that themselves contain underscores (plugin-scoped MCP servers)", () => {
    const toolCalls: ToolCallSummary[] = [
      { name: "mcp__plugin_context-mode_context-mode__ctx_batch_execute", inputBytes: 4, outputBytes: 6, count: 1, examples: [] }
    ];
    const rows = groupMcpServers(toolCalls);
    expect(rows).toEqual([
      { server: "plugin_context-mode_context-mode", toolCalls: 1, bytes: 10, pctOfToolBytes: 1 }
    ]);
  });
});

describe("groupSkillUsage", () => {
  it("detects Skill tool_use invocations and command-name markers", () => {
    const analysis = baseAnalysis({
      messages: [
        { index: 0, role: "user", text: "<command-name>/lens</command-name>", bytes: 30, type: "user" }
      ],
      toolCalls: [
        { name: "Skill", inputBytes: 20, outputBytes: 0, count: 1, examples: [JSON.stringify({ skill: "artilens:lens" })] },
        { name: "Read", inputBytes: 5, outputBytes: 45, count: 3, examples: [] }
      ]
    });
    const rows = groupSkillUsage(analysis);
    const names = rows.map((row) => row.skill);
    expect(names).toContain("artilens:lens");
    expect(names).toContain("/lens");
  });

  it("returns an empty array when no skill or command markers are present", () => {
    expect(groupSkillUsage(baseAnalysis())).toEqual([]);
  });
});

describe("buildUsageReport / buildUsageData", () => {
  it("computes total cost across model rows and flags unknown models as estimates", () => {
    const analysis = baseAnalysis({
      modelUsage: {
        "claude-sonnet-5": { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, estimatedTokens: 0 },
        "some-future-model": { inputTokens: 1_000_000, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, estimatedTokens: 0 }
      }
    });
    const report = buildUsageReport(analysis);
    const sonnetRow = report.modelRows.find((row) => row.model === "claude-sonnet-5")!;
    expect(sonnetRow.costUsd).toBeCloseTo(3 + 15, 5);
    expect(sonnetRow.costIsEstimate).toBe(false);
    const unknownRow = report.modelRows.find((row) => row.model === "some-future-model")!;
    expect(unknownRow.costIsEstimate).toBe(true);
    expect(report.totalCostIsEstimate).toBe(true);

    const data = buildUsageData(report);
    expect(data.schema).toBe("artilens.usage.data/v1");
    expect(data.modelRows.length).toBe(2);
  });

  it("computes zero wallDurationMs and zero lines when the transcript has fewer than two timestamped messages", () => {
    const report = buildUsageReport(baseAnalysis());
    expect(report.wallDurationMs).toBe(0);
    expect(report.linesAdded).toBe(0);
    expect(report.linesRemoved).toBe(0);
    expect(report.totalCostUsd).toBe(0);
    expect(report.totalCostIsEstimate).toBe(false);
  });
});

describe("writeUsageData", () => {
  it("includes subagent transcript token usage in the report, not just the main session", async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "artilens-usage-"));
    const transcript = path.join(tmp, "session.jsonl");
    await fs.promises.writeFile(
      transcript,
      `${JSON.stringify({
        type: "assistant",
        message: { role: "assistant", model: "claude-sonnet-5", content: "hi", usage: { input_tokens: 1_000_000, output_tokens: 0 } }
      })}\n`
    );
    const subagentsDir = path.join(tmp, "subagents");
    await fs.promises.mkdir(subagentsDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(subagentsDir, "sub1.jsonl"),
      `${JSON.stringify({
        type: "assistant",
        message: { role: "assistant", model: "claude-sonnet-5", content: "sub", usage: { input_tokens: 1_000_000, output_tokens: 0 } }
      })}\n`
    );
    const { report } = await writeUsageData({ session: transcript, projectDir: tmp, dataPath: path.join(tmp, "usage.data.json") });
    const sonnetRow = report.modelRows.find((row) => row.model === "claude-sonnet-5");
    expect(sonnetRow?.inputTokens).toBe(2_000_000); // 1M from main session + 1M from the subagent transcript
  });
});

describe("buildUsageReport pricing", () => {
  it("flags unknown-pricing model rows instead of computing a fake cost", () => {
    const report = buildUsageReport(
      baseAnalysis({ modelUsage: { "some-future-model": { inputTokens: 1_000, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, estimatedTokens: 0 } } })
    );
    const row = report.modelRows.find((item) => item.model === "some-future-model");
    expect(row?.costIsEstimate).toBe(true);
    expect(row?.costUsd).toBe(0);
  });
});
