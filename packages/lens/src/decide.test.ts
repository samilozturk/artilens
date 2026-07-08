import { describe, expect, it } from "vitest";
import { buildHandoff, decide, scoreHealth } from "./index.js";
import type { TranscriptAnalysis } from "@artilens/core";

function analysis(partial: Partial<TranscriptAnalysis> = {}): TranscriptAnalysis {
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
    ...partial
  };
}

describe("lens decision engine bands", () => {
  it("recommends continue below 50%", () => {
    const d = decide({ usedPercentage: 30, rereadRatio: 0, topicDrift: 0, analysis: analysis() });
    expect(d.action).toBe("continue");
    expect(d.confidence).toBe("high");
  });

  it("recommends compact in the 50-74% band with stable topic", () => {
    const d = decide({ usedPercentage: 60, rereadRatio: 0.1, topicDrift: 0.1, analysis: analysis() });
    expect(d.action).toBe("compact");
    expect(d.preservationPrompt).toBeTruthy();
  });

  it("recommends handoff at exactly the 75% threshold", () => {
    const d = decide({ usedPercentage: 75, rereadRatio: 0, topicDrift: 0, analysis: analysis() });
    expect(d.action).toBe("handoff");
  });

  it("recommends handoff on high topic drift even at low context", () => {
    const d = decide({ usedPercentage: 20, rereadRatio: 0, topicDrift: 0.9, analysis: analysis() });
    expect(d.action).toBe("handoff");
    expect(d.reason).toContain("drift");
  });

  it("includes critical hot files in the handoff preservation prompt", () => {
    const d = decide({
      usedPercentage: 80,
      rereadRatio: 0,
      topicDrift: 0,
      analysis: analysis({ fileReads: { "src/a.ts": 5, "src/b.ts": 2 } })
    });
    expect(d.preservationPrompt).toContain("src/a.ts");
  });
});

describe("lens health score", () => {
  it("is high for a healthy session and low for a stressed one", () => {
    expect(scoreHealth(20, 0, 0, 0)).toBeGreaterThan(90);
    expect(scoreHealth(95, 0.6, 0.8, 5)).toBeLessThan(40);
  });

  it("clamps to the 0-100 range", () => {
    expect(scoreHealth(200, 1, 1, 50)).toBeGreaterThanOrEqual(0);
    expect(scoreHealth(0, 0, 0, 0)).toBeLessThanOrEqual(100);
  });
});

describe("lens handoff document", () => {
  it("renders done, open work, critical files, and expensive tools sections", () => {
    const a = analysis({
      fileReads: { "src/x.ts": 3 },
      todos: [
        { text: "ship feature", status: "completed" },
        { text: "write docs", status: "todo" }
      ],
      toolCalls: [{ name: "Grep", inputBytes: 100, outputBytes: 5000, count: 4, examples: [] }],
      messages: [{ index: 0, role: "user", text: "hello", bytes: 5 }]
    });
    const doc = buildHandoff(a, decide({ usedPercentage: 80, rereadRatio: 0, topicDrift: 0, analysis: a }));
    expect(doc).toContain("ship feature");
    expect(doc).toContain("write docs");
    expect(doc).toContain("src/x.ts");
    expect(doc).toContain("Grep");
    expect(doc).toContain("HANDOFF");
  });
});
