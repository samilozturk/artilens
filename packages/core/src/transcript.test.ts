import { describe, expect, it } from "vitest";
import { minifyHtml, parseTranscriptText, totalTranscriptTokens } from "./index.js";

describe("transcript tool_result attribution", () => {
  it("maps tool_result output bytes back to the originating tool name via tool_use_id", () => {
    const big = "x".repeat(6000);
    const transcript = [
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "Grep", input: { pattern: "foo" } }],
          usage: { input_tokens: 10, output_tokens: 5 }
        }
      }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: big }] }
      })
    ].join("\n");
    const analysis = parseTranscriptText(transcript);
    const grep = analysis.toolCalls.find((tool) => tool.name === "Grep");
    expect(grep).toBeDefined();
    expect(grep?.count).toBe(1);
    expect(grep?.outputBytes).toBeGreaterThan(6000);
    // No junk row keyed by the raw tool_use_id should exist.
    expect(analysis.toolCalls.some((tool) => tool.name === "toolu_1")).toBe(false);
  });

  it("falls back to a generic bucket when the tool_use_id was never seen", () => {
    const transcript = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "orphan", content: "abc" }] }
    });
    const analysis = parseTranscriptText(transcript);
    // Unknown id must not crash and must not masquerade as a real tool call.
    expect(analysis.toolCalls.length).toBeGreaterThanOrEqual(1);
    expect(analysis.toolCalls.every((tool) => tool.count === 0 || tool.name !== "orphan")).toBe(true);
  });

  it("aggregates repeated calls of the same tool and counts them", () => {
    const line = (id: string) =>
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: "Read", input: { file_path: "a.ts" } }] } });
    const analysis = parseTranscriptText([line("t1"), line("t2"), line("t3")].join("\n"));
    const read = analysis.toolCalls.find((tool) => tool.name === "Read");
    expect(read?.count).toBe(3);
    expect(analysis.fileReads["a.ts"]).toBe(3);
  });

  it("estimates tokens by bytes when usage is absent and prefers usage when present", () => {
    const withUsage = parseTranscriptText(
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "hi", usage: { input_tokens: 100, output_tokens: 50 } } })
    );
    expect(withUsage.usage.inputTokens).toBe(100);
    expect(withUsage.usage.estimatedTokens).toBe(0);
    const noUsage = parseTranscriptText(JSON.stringify({ type: "assistant", message: { role: "assistant", content: "hello world" } }));
    expect(noUsage.usage.estimatedTokens).toBeGreaterThan(0);
    expect(totalTranscriptTokens(noUsage)).toBe(noUsage.usage.estimatedTokens);
  });

  it("overwrites usage metrics with the last turn's usage and accumulates estimated tokens after the last turn", () => {
    const transcript = [
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "turn 1", usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 50 } } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "new user prompt" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "turn 2", usage: { input_tokens: 20, output_tokens: 8, cache_creation_input_tokens: 110, cache_read_input_tokens: 60 } } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "another user prompt" } })
    ].join("\n");
    const analysis = parseTranscriptText(transcript);
    expect(analysis.usage.inputTokens).toBe(20);
    expect(analysis.usage.outputTokens).toBe(8);
    expect(analysis.usage.cacheCreationInputTokens).toBe(110);
    expect(analysis.usage.cacheReadInputTokens).toBe(60);
    expect(analysis.usage.estimatedTokens).toBeGreaterThan(0);
  });

  it("scrubs secrets from message snippets", () => {
    const analysis = parseTranscriptText(
      JSON.stringify({ type: "user", message: { role: "user", content: "key sk-abcdefghijklmnopqrstuvwxyz012345 here" } })
    );
    expect(JSON.stringify(analysis.messages)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
    expect(JSON.stringify(analysis.messages)).toContain("REDACTED");
  });

  it("survives empty input and CRLF line endings", () => {
    expect(parseTranscriptText("").lineCount).toBe(0);
    const crlf = parseTranscriptText(
      `${JSON.stringify({ type: "user", message: { role: "user", content: "a" } })}\r\n${JSON.stringify({ type: "assistant", message: { role: "assistant", content: "b" } })}`
    );
    expect(crlf.lineCount).toBe(2);
    expect(crlf.parseErrors).toBe(0);
  });

  it("accumulates per-model usage across multiple assistant turns instead of overwriting", () => {
    const transcript = [
      JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-sonnet-5", content: "turn 1", usage: { input_tokens: 10, output_tokens: 5 } } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-sonnet-5", content: "turn 2", usage: { input_tokens: 20, output_tokens: 8 } } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-haiku-4-5", content: "turn 3", usage: { input_tokens: 3, output_tokens: 1 } } })
    ].join("\n");
    const analysis = parseTranscriptText(transcript);
    expect(analysis.modelUsage["claude-sonnet-5"]).toEqual({
      inputTokens: 30,
      outputTokens: 13,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      estimatedTokens: 0
    });
    expect(analysis.modelUsage["claude-haiku-4-5"]).toEqual({
      inputTokens: 3,
      outputTokens: 1,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      estimatedTokens: 0
    });
    // existing last-value field is untouched by this change
    expect(analysis.usage.inputTokens).toBe(3);
  });

  it("tallies approximate line changes from Write/Edit/MultiEdit tool_use inputs", () => {
    const transcript = [
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "a.ts", content: "line1\nline2\nline3" } }] }
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: "b.ts", old_string: "old1\nold2", new_string: "new1\nnew2\nnew3" } }] }
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t3", name: "MultiEdit", input: { file_path: "c.ts", edits: [{ old_string: "x", new_string: "y1\ny2" }] } }]
        }
      })
    ].join("\n");
    const analysis = parseTranscriptText(transcript);
    // Write content (3 lines) + Edit new_string (3 lines) + MultiEdit new_string (2 lines)
    expect(analysis.lineChanges.added).toBe(3 + 3 + 2);
    // Edit old_string (2 lines) + MultiEdit old_string (1 line)
    expect(analysis.lineChanges.removed).toBe(2 + 1);
  });

  it("does not overcount a trailing newline as an extra line", () => {
    const transcript = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "a.ts", content: "line1\nline2\nline3\n" } }] }
    });
    const analysis = parseTranscriptText(transcript);
    // Real file content ending in a newline (the common case) is still 3 lines, not 4.
    expect(analysis.lineChanges.added).toBe(3);
  });

  it("does not tally line changes for unrelated tools", () => {
    const transcript = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } }] }
    });
    const analysis = parseTranscriptText(transcript);
    expect(analysis.lineChanges).toEqual({ added: 0, removed: 0 });
  });

  it("extracts the model name from the last assistant message in transcript lines", () => {
    const transcript = [
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-haiku-4-5-20251001",
          content: []
        }
      })
    ].join("\n");
    const analysis = parseTranscriptText(transcript);
    expect(analysis.model).toBe("claude-haiku-4-5-20251001");
  });
});

describe("minifyHtml whitespace shielding", () => {
  it("preserves indentation inside <pre> blocks", () => {
    const html = minifyHtml("<div>  a  b  </div><pre>line1\n    indented\n        deeper</pre>");
    expect(html).toContain("\n    indented");
    expect(html).toContain("\n        deeper");
    // Outside <pre>, redundant whitespace is still collapsed.
    expect(html).not.toContain("a  b");
  });

  it("preserves embedded JSON and multi-space content inside <script>", () => {
    const json = '{\n  "a": 1,\n  "b": 2\n}';
    const html = minifyHtml(`<body><script type="application/json">${json}</script></body>`);
    expect(html).toContain('"a": 1');
    expect(html).toContain('"b": 2');
  });

  it("does not corrupt visible numbers surrounded by spaces", () => {
    const html = minifyHtml("<p>step 3 done and 42 items</p>");
    expect(html).toContain("step 3 done and 42 items");
  });

  it("leaves no shield markers or null bytes in the output", () => {
    const html = minifyHtml("<div>x</div><pre>y</pre><script>var z=1;</script>");
    expect(html.includes(String.fromCharCode(0))).toBe(false);
    expect(html).toContain("<pre>y</pre>");
    expect(html).toContain("<script>var z=1;</script>");
  });
});
