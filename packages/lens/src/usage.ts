import path from "node:path";
import type { TranscriptAnalysis, ToolCallSummary } from "@artilens/core";
import { findLatestTranscript, parseTranscriptFile, writeText } from "@artilens/core";
import { includeSubagents } from "./index.js";

export interface UsageModelRow {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUsd: number;
  costIsEstimate: boolean;
}

export interface UsageMcpRow {
  server: string;
  toolCalls: number;
  bytes: number;
  pctOfToolBytes: number;
}

export interface UsageSkillRow {
  skill: string;
  invocations: number;
  bytes: number;
  pctOfToolBytes: number;
}

export interface UsageReport {
  totalCostUsd: number;
  totalCostIsEstimate: boolean;
  wallDurationMs: number;
  linesAdded: number;
  linesRemoved: number;
  modelRows: UsageModelRow[];
  mcpServerRows: UsageMcpRow[];
  skillRows: UsageSkillRow[];
  toolCalls: ToolCallSummary[];
  parseErrors: number;
  messageCount: number;
}

export interface UsageData {
  schema: "artilens.usage.data/v1";
  totalCostUsd: number;
  totalCostIsEstimate: boolean;
  wallDurationMs: number;
  linesAdded: number;
  linesRemoved: number;
  modelRows: UsageModelRow[];
  mcpServerRows: UsageMcpRow[];
  skillRows: UsageSkillRow[];
  toolCalls: { name: string; count: number; inputBytes: number; outputBytes: number }[];
  parseErrors: number;
  messageCount: number;
}

const PRICING_TABLE: { match: RegExp; inputPerMTok: number; outputPerMTok: number }[] = [
  { match: /haiku/, inputPerMTok: 1, outputPerMTok: 5 },
  { match: /sonnet/, inputPerMTok: 3, outputPerMTok: 15 },
  { match: /opus/, inputPerMTok: 5, outputPerMTok: 25 },
  { match: /fable|mythos/, inputPerMTok: 10, outputPerMTok: 50 }
];

/** Static per-million-token pricing, matched by model-id substring. Returns undefined for unrecognized models. */
export function resolveModelPricing(modelId: string): { inputPerMTok: number; outputPerMTok: number } | undefined {
  const lower = modelId.toLowerCase();
  const entry = PRICING_TABLE.find((row) => row.match.test(lower));
  return entry ? { inputPerMTok: entry.inputPerMTok, outputPerMTok: entry.outputPerMTok } : undefined;
}

function parseExampleInput(example: string): any {
  try {
    return JSON.parse(example);
  } catch {
    return {};
  }
}

/**
 * Approximate lines added/removed, sourced from the transcript parser's
 * lineChanges tally (computed from full, untrimmed Write/Edit/MultiEdit
 * tool_use inputs) — not a real diff.
 */
export function estimateLinesChanged(analysis: TranscriptAnalysis): { linesAdded: number; linesRemoved: number } {
  return { linesAdded: analysis.lineChanges.added, linesRemoved: analysis.lineChanges.removed };
}

/**
 * Extracts the server segment from an `mcp__<server>__<tool>` tool name.
 * The server segment itself frequently contains underscores (e.g. plugin-
 * scoped servers like `mcp__plugin_context-mode_context-mode__ctx_search`),
 * so this splits on the literal "__" delimiter rather than assuming the
 * server segment is underscore-free.
 */
function extractMcpServerName(toolName: string): string | undefined {
  const parts = toolName.split("__");
  if (parts.length < 3 || parts[0] !== "mcp") return undefined;
  return parts.slice(1, -1).join("__");
}

/** Groups tool calls whose name matches mcp__<server>__<tool>; byte share is an approximate usage-weight proxy, not real token cost. */
export function groupMcpServers(toolCalls: ToolCallSummary[]): UsageMcpRow[] {
  const totalBytes = toolCalls.reduce((sum, tool) => sum + tool.inputBytes + tool.outputBytes, 0);
  const byServer = new Map<string, { toolCalls: number; bytes: number }>();
  for (const tool of toolCalls) {
    const server = extractMcpServerName(tool.name);
    if (!server) continue;
    const current = byServer.get(server) ?? { toolCalls: 0, bytes: 0 };
    current.toolCalls += tool.count;
    current.bytes += tool.inputBytes + tool.outputBytes;
    byServer.set(server, current);
  }
  return [...byServer.entries()]
    .map(([server, value]) => ({
      server,
      toolCalls: value.toolCalls,
      bytes: value.bytes,
      pctOfToolBytes: totalBytes > 0 ? value.bytes / totalBytes : 0
    }))
    .sort((a, b) => b.bytes - a.bytes);
}

/** Detects Skill tool_use invocations and <command-name> markers; byte share is an approximate usage-weight proxy, not exact token attribution. */
export function groupSkillUsage(analysis: TranscriptAnalysis): UsageSkillRow[] {
  const totalBytes = analysis.toolCalls.reduce((sum, tool) => sum + tool.inputBytes + tool.outputBytes, 0);
  const bySkill = new Map<string, { invocations: number; bytes: number }>();

  const skillTool = analysis.toolCalls.find((tool) => tool.name === "Skill");
  if (skillTool) {
    for (const example of skillTool.examples) {
      const input = parseExampleInput(example);
      const name = typeof input.skill === "string" ? input.skill : undefined;
      if (!name) continue;
      const current = bySkill.get(name) ?? { invocations: 0, bytes: 0 };
      current.invocations += 1;
      current.bytes += skillTool.inputBytes + skillTool.outputBytes;
      bySkill.set(name, current);
    }
  }

  const commandPattern = /<command-name>([^<]+)<\/command-name>/g;
  for (const message of analysis.messages) {
    for (const match of message.text.matchAll(commandPattern)) {
      const name = match[1];
      const current = bySkill.get(name) ?? { invocations: 0, bytes: 0 };
      current.invocations += 1;
      current.bytes += message.bytes;
      bySkill.set(name, current);
    }
  }

  return [...bySkill.entries()]
    .map(([skill, value]) => ({
      skill,
      invocations: value.invocations,
      bytes: value.bytes,
      pctOfToolBytes: totalBytes > 0 ? value.bytes / totalBytes : 0
    }))
    .sort((a, b) => b.bytes - a.bytes);
}

export function buildUsageReport(analysis: TranscriptAnalysis): UsageReport {
  const modelRows: UsageModelRow[] = Object.entries(analysis.modelUsage).map(([model, usage]) => {
    const pricing = resolveModelPricing(model);
    const costUsd = pricing
      ? (usage.inputTokens / 1_000_000) * pricing.inputPerMTok +
        (usage.outputTokens / 1_000_000) * pricing.outputPerMTok +
        (usage.cacheCreationInputTokens / 1_000_000) * pricing.inputPerMTok * 1.25 +
        (usage.cacheReadInputTokens / 1_000_000) * pricing.inputPerMTok * 0.1
      : 0;
    return {
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      costUsd,
      costIsEstimate: !pricing
    };
  });

  const timestamps = analysis.messages.map((message) => message.timestamp).filter((value): value is string => Boolean(value));
  const wallDurationMs = timestamps.length >= 2
    ? new Date(timestamps[timestamps.length - 1]).getTime() - new Date(timestamps[0]).getTime()
    : 0;

  const { linesAdded, linesRemoved } = estimateLinesChanged(analysis);

  return {
    totalCostUsd: modelRows.reduce((sum, row) => sum + row.costUsd, 0),
    totalCostIsEstimate: modelRows.some((row) => row.costIsEstimate),
    wallDurationMs: Number.isFinite(wallDurationMs) && wallDurationMs > 0 ? wallDurationMs : 0,
    linesAdded,
    linesRemoved,
    modelRows,
    mcpServerRows: groupMcpServers(analysis.toolCalls),
    skillRows: groupSkillUsage(analysis),
    toolCalls: analysis.toolCalls.slice(0, 10),
    parseErrors: analysis.parseErrors,
    messageCount: analysis.messages.length
  };
}

/** Scrubbed, aggregated snapshot of a UsageReport for native-artifact authoring — no raw message text or file paths. */
export function buildUsageData(report: UsageReport): UsageData {
  return {
    schema: "artilens.usage.data/v1",
    totalCostUsd: report.totalCostUsd,
    totalCostIsEstimate: report.totalCostIsEstimate,
    wallDurationMs: report.wallDurationMs,
    linesAdded: report.linesAdded,
    linesRemoved: report.linesRemoved,
    modelRows: report.modelRows,
    mcpServerRows: report.mcpServerRows,
    skillRows: report.skillRows,
    toolCalls: report.toolCalls.map((tool) => ({
      name: tool.name,
      count: tool.count,
      inputBytes: tool.inputBytes,
      outputBytes: tool.outputBytes
    })),
    parseErrors: report.parseErrors,
    messageCount: report.messageCount
  };
}

export interface UsageOptions {
  session?: string;
  latest?: boolean;
  projectDir?: string;
}

/** Load the latest (or named) transcript and build a full usage report. */
export async function createUsageReport(options: UsageOptions = {}): Promise<UsageReport> {
  const projectDir = options.projectDir ?? process.cwd();
  const transcriptPath = options.session
    ? path.isAbsolute(options.session) ? options.session : path.join(projectDir, options.session)
    : await findLatestTranscript(projectDir);
  if (!transcriptPath) throw new Error("No Claude Code transcript found. Pass --session <path>.");
  const analysis = await parseTranscriptFile(transcriptPath);
  await includeSubagents(analysis);
  return buildUsageReport(analysis);
}

/** Create a usage report and write its scrubbed data contract to a JSON file (no HTML). */
export async function writeUsageData(options: UsageOptions & { dataPath: string }): Promise<{ report: UsageReport; data: UsageData; dataPath: string }> {
  const projectDir = options.projectDir ?? process.cwd();
  const report = await createUsageReport(options);
  const data = buildUsageData(report);
  const dataPath = path.isAbsolute(options.dataPath) ? options.dataPath : path.join(projectDir, options.dataPath);
  await writeText(dataPath, JSON.stringify(data, null, 2));
  return { report, data, dataPath };
}

