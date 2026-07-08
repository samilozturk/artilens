import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  findLatestTranscript,
  parseTranscriptFile,
  totalTranscriptTokens,
  trimSnippet,
  writeText,
  type TranscriptAnalysis
} from "@artilens/core";
export * from "./usage.js";

export interface LensOptions {
  session?: string;
  latest?: boolean;
  outPath?: string;
  projectDir?: string;
  livePath?: string;
}

export interface ContextBreakdown {
  systemPrompt: number;
  systemTools: number;
  memoryFiles: number;
  skills: number;
  messages: number;
}

export interface LensDecision {
  action: "continue" | "compact" | "handoff";
  confidence: "high" | "medium" | "low";
  reason: string;
  preservationPrompt?: string;
}

export interface LensReport {
  transcriptPath?: string;
  analysis: TranscriptAnalysis;
  usedPercentage: number;
  usedPercentageEstimated: boolean;
  maxTokens: number;
  healthScore: number;
  decision: LensDecision;
  handoff: string;
  rereadRatio: number;
  topicDrift: number;
  breakdown: ContextBreakdown;
}

export interface LensToolRow {
  name: string;
  count: number;
  inputBytes: number;
  outputBytes: number;
}

export interface LensFileRow {
  file: string;
  reads: number;
  repeatRead: boolean;
}

/**
 * Scrubbed, aggregated snapshot of a LensReport for native-artifact authoring.
 * Contains no raw transcript text, no tool-call examples, and no file paths beyond
 * the file-read tallies — only counts, names, and ratios the artifact must visualize.
 */
export interface LensData {
  schema: "artilens.lens.data/v1";
  healthScore: number;
  usedPercentage: number;
  usedPercentageEstimated: boolean;
  maxTokens: number;
  decision: LensDecision;
  handoff: string;
  rereadRatio: number;
  topicDrift: number;
  breakdown: ContextBreakdown;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    estimatedTokens: number;
  };
  toolCalls: LensToolRow[];
  fileReads: LensFileRow[];
  parseErrors: number;
  subagentCount: number;
  messageCount: number;
}

/**
 * Build the scrubbed data contract from a full LensReport. Drops raw message text,
 * tool-call examples, user-prompt topics, and subagent paths; keeps only aggregates.
 */
export function buildLensData(report: LensReport, topN = 20): LensData {
  const analysis = report.analysis;
  const toolCalls = analysis.toolCalls.slice(0, Math.min(10, topN)).map((tool) => ({
    name: tool.name,
    count: tool.count,
    inputBytes: tool.inputBytes,
    outputBytes: tool.outputBytes
  }));
  const fileReads = Object.entries(analysis.fileReads)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([file, reads]) => ({ file, reads, repeatRead: reads > 2 }));
  return {
    schema: "artilens.lens.data/v1",
    healthScore: report.healthScore,
    usedPercentage: report.usedPercentage,
    usedPercentageEstimated: report.usedPercentageEstimated,
    maxTokens: report.maxTokens,
    decision: report.decision,
    handoff: report.handoff,
    rereadRatio: report.rereadRatio,
    topicDrift: report.topicDrift,
    breakdown: report.breakdown,
    usage: {
      inputTokens: analysis.usage.inputTokens,
      outputTokens: analysis.usage.outputTokens,
      cacheCreationInputTokens: analysis.usage.cacheCreationInputTokens,
      cacheReadInputTokens: analysis.usage.cacheReadInputTokens,
      estimatedTokens: analysis.usage.estimatedTokens
    },
    toolCalls,
    fileReads,
    parseErrors: analysis.parseErrors,
    subagentCount: analysis.subagentPaths.length,
    messageCount: analysis.messages.length
  };
}

/** Create a lens report and write its scrubbed data contract to a JSON file (no HTML). */
export async function writeLensData(options: LensOptions & { dataPath: string }): Promise<{ report: LensReport; data: LensData; dataPath: string }> {
  const report = await createLensReport(options);
  const data = buildLensData(report);
  const dataPath = path.isAbsolute(options.dataPath)
    ? options.dataPath
    : path.join(options.projectDir ?? process.cwd(), options.dataPath);
  await writeText(dataPath, JSON.stringify(data, null, 2));
  return { report, data, dataPath };
}

export async function createLensReport(options: LensOptions = {}): Promise<LensReport> {
  const projectDir = options.projectDir ?? process.cwd();
  const transcriptPath = options.session
    ? path.isAbsolute(options.session)
      ? options.session
      : path.join(projectDir, options.session)
    : await findLatestTranscript(projectDir);
  if (!transcriptPath) throw new Error("No Claude Code transcript found. Pass --session <path>.");
  const analysis = await parseTranscriptFile(transcriptPath);
  await includeSubagents(analysis);
  const live = readLiveContext(options.livePath ?? path.join(projectDir, ".claude", "artilens", "live.json"));
  const total = totalTranscriptTokens(analysis);
  let maxTokens: number;
  if (live?.context_window?.context_window_size) {
    // Real data from Claude Code's own statusline hook. context_window_size is the
    // raw model window (e.g. 1,000,000), which can be a few % larger than the
    // autocompact-adjusted window /context displays (e.g. 967,000) - still far more
    // accurate than guessing from the model name, and used_percentage below is
    // Claude Code's own pre-calculated figure regardless of this field.
    maxTokens = Number(live.context_window.context_window_size);
  } else {
    const activeModel = analysis.model?.toLowerCase() ?? resolveModelFromConfig(projectDir);
    maxTokens = resolveMaxTokensForModel(activeModel);
  }
  const usedPercentage = live?.context_window?.used_percentage ?? Math.min(99, Math.round((total / maxTokens) * 100));
  const rereadRatio = calculateRereadRatio(analysis);
  const topicDrift = calculateTopicDrift(analysis);
  const healthScore = scoreHealth(usedPercentage, rereadRatio, topicDrift, analysis.parseErrors);
  const decision = decide({ usedPercentage, rereadRatio, topicDrift, analysis });
  const handoff = buildHandoff(analysis, decision);
  const breakdown = await calculateContextBreakdown(projectDir, analysis, maxTokens);
  return {
    transcriptPath,
    analysis,
    usedPercentage,
    usedPercentageEstimated: !live,
    maxTokens,
    healthScore,
    decision,
    handoff,
    rereadRatio,
    topicDrift,
    breakdown
  };
}

export function scoreHealth(usedPercentage: number, rereadRatio: number, topicDrift: number, parseErrors: number): number {
  return Math.max(0, Math.min(100, 100 - Math.max(0, usedPercentage - 40) - rereadRatio * 30 - topicDrift * 25 - parseErrors * 3));
}

export function decide(input: { usedPercentage: number; rereadRatio: number; topicDrift: number; analysis: TranscriptAnalysis }): LensDecision {
  const hotFiles = Object.entries(input.analysis.fileReads)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([file]) => file);
  if (input.usedPercentage >= 75 || input.topicDrift > 0.65) {
    return {
      action: "handoff",
      confidence: input.usedPercentage > 85 ? "high" : "medium",
      reason: input.usedPercentage >= 75 ? "context is above the handoff threshold" : "topic drift is high",
      preservationPrompt: `Start a fresh session with the handoff. Critical files: ${hotFiles.join(", ") || "none detected"}.`
    };
  }
  if (input.usedPercentage >= 50) {
    return {
      action: "compact",
      confidence: "medium",
      reason: "context is in the compact band and topic continuity is acceptable",
      preservationPrompt: `Before /compact, preserve active files (${hotFiles.join(", ") || "none detected"}) and current decisions.`
    };
  }
  return {
    action: "continue",
    confidence: "high",
    reason: "context pressure is low",
    preservationPrompt: undefined
  };
}

export function buildHandoff(analysis: TranscriptAnalysis, decision: LensDecision): string {
  const files = Object.entries(analysis.fileReads)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([file, reads]) => `- ${file} (${reads} read/edit signal)`)
    .join("\n");
  const done = analysis.todos.filter((todo) => /done|completed/i.test(todo.status));
  const open = analysis.todos.filter((todo) => !/done|completed/i.test(todo.status));
  const tools = analysis.toolCalls
    .slice(0, 8)
    .map((tool) => `- ${tool.name}: ${tool.count} call(s), ${tool.inputBytes + tool.outputBytes} bytes`)
    .join("\n");
  const recent = analysis.messages
    .slice(-8)
    .map((message) => `- ${message.role}: ${trimSnippet(message.text, 120)}`)
    .join("\n");
  return `# ArtiLens Handoff

## Recommendation

${decision.action.toUpperCase()}: ${decision.reason}

## Done

${done.map((todo) => `- ${todo.text}`).join("\n") || "- No completed todo records detected."}

## Open Work

${open.map((todo) => `- [${todo.status}] ${todo.text}`).join("\n") || "- No open todo records detected."}

## Critical Files

${files || "- No file activity detected."}

## Expensive Tools

${tools || "- No tool calls detected."}

## Recent Context

${recent || "- No recent messages detected."}
`;
}

function readLiveContext(filePath: string): any | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

export async function includeSubagents(analysis: TranscriptAnalysis): Promise<void> {
  for (const subagentPath of analysis.subagentPaths) {
    try {
      const sub = await parseTranscriptFile(subagentPath);
      analysis.lineCount += sub.lineCount;
      analysis.parseErrors += sub.parseErrors;
      analysis.unknownLines += sub.unknownLines;
      analysis.messages.push(...sub.messages);
      analysis.toolCalls.push(...sub.toolCalls);
      for (const [file, count] of Object.entries(sub.fileReads)) {
        analysis.fileReads[file] = (analysis.fileReads[file] ?? 0) + count;
      }
      analysis.todos.push(...sub.todos);
      analysis.usage.inputTokens += sub.usage.inputTokens;
      analysis.usage.outputTokens += sub.usage.outputTokens;
      analysis.usage.cacheCreationInputTokens += sub.usage.cacheCreationInputTokens;
      analysis.usage.cacheReadInputTokens += sub.usage.cacheReadInputTokens;
      analysis.usage.estimatedTokens += sub.usage.estimatedTokens;
      for (const [subModel, subBucket] of Object.entries(sub.modelUsage)) {
        const bucket = analysis.modelUsage[subModel] ?? {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          estimatedTokens: 0
        };
        bucket.inputTokens += subBucket.inputTokens;
        bucket.outputTokens += subBucket.outputTokens;
        bucket.cacheCreationInputTokens += subBucket.cacheCreationInputTokens;
        bucket.cacheReadInputTokens += subBucket.cacheReadInputTokens;
        analysis.modelUsage[subModel] = bucket;
      }
      analysis.lineChanges.added += sub.lineChanges.added;
      analysis.lineChanges.removed += sub.lineChanges.removed;
    } catch {
      analysis.parseErrors += 1;
    }
  }
}

function calculateRereadRatio(analysis: TranscriptAnalysis): number {
  const counts = Object.values(analysis.fileReads);
  if (counts.length === 0) return 0;
  const repeats = counts.filter((count) => count > 1).reduce((sum, count) => sum + count - 1, 0);
  return repeats / Math.max(1, counts.reduce((sum, count) => sum + count, 0));
}

function calculateTopicDrift(analysis: TranscriptAnalysis): number {
  const topics = analysis.userPromptTopics.filter((item) => item.length > 0);
  if (topics.length < 2) return 0;
  let drift = 0;
  let comparisons = 0;
  for (let index = 1; index < topics.length; index += 1) {
    const prev = new Set(topics[index - 1]);
    const curr = new Set(topics[index]);
    const intersection = [...curr].filter((item) => prev.has(item)).length;
    const union = new Set([...prev, ...curr]).size;
    drift += 1 - intersection / Math.max(1, union);
    comparisons += 1;
  }
  return drift / comparisons;
}

export async function calculateContextBreakdown(projectDir: string, analysis: TranscriptAnalysis, maxTokens = 967000): Promise<ContextBreakdown> {
  const activeInput = analysis.usage.inputTokens + analysis.usage.cacheCreationInputTokens + analysis.usage.cacheReadInputTokens;

  // Constants representing the base Claude Code harness overhead (dynamically calibrated)
  const isLargeContext = maxTokens > 500000;
  const systemPrompt = isLargeContext ? 9500 : 6900;
  const systemTools = isLargeContext ? 11300 : 13600;
  const builtinSkills = isLargeContext ? 8500 : 1400; // Baseline overhead for built-in Claude Code CLI skills

  // Memory Files estimation (CLAUDE.md, AGENTS.md, and rules in .claude/rules/)
  let memoryFilesBytes = 0;
  const memoryCandidates = [
    path.join(projectDir, "CLAUDE.md"),
    path.join(projectDir, "AGENTS.md")
  ];
  for (const candidate of memoryCandidates) {
    try {
      if (fs.existsSync(candidate)) {
        memoryFilesBytes += fs.statSync(candidate).size;
      }
    } catch {}
  }
  const rulesDir = path.join(projectDir, ".claude", "rules");
  try {
    if (fs.existsSync(rulesDir)) {
      const files = fs.readdirSync(rulesDir);
      for (const file of files) {
        if (file.endsWith(".md")) {
          memoryFilesBytes += fs.statSync(path.join(rulesDir, file)).size;
        }
      }
    }
  } catch {}

  // 1 token ≈ 4.8 characters/bytes for standard text and code
  let memoryFiles = Math.round(memoryFilesBytes / 4.8);

  // Skills estimation (.claude/skills/ and plugin/skills/)
  let skillsBytes = 0;
  const skillDirs = [
    path.join(projectDir, ".claude", "skills"),
    path.join(projectDir, "plugin", "skills")
  ];
  for (const dir of skillDirs) {
    try {
      if (fs.existsSync(dir)) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            const skillMd = path.join(fullPath, "SKILL.md");
            if (fs.existsSync(skillMd)) {
              skillsBytes += fs.statSync(skillMd).size;
            }
          } else if (entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".json"))) {
            skillsBytes += fs.statSync(fullPath).size;
          }
        }
      }
    } catch {}
  }
  let skills = Math.round(skillsBytes / 4.8) + builtinSkills;

  let finalSystemPrompt = systemPrompt;
  let finalSystemTools = systemTools;
  let messages = 0;

  const staticSum = systemPrompt + systemTools + memoryFiles + skills;
  if (activeInput === 0) {
    finalSystemPrompt = 0;
    finalSystemTools = 0;
    memoryFiles = 0;
    skills = 0;
  } else if (activeInput < staticSum) {
    const scale = activeInput / staticSum;
    finalSystemPrompt = Math.round(systemPrompt * scale);
    finalSystemTools = Math.round(systemTools * scale);
    memoryFiles = Math.round(memoryFiles * scale);
    skills = Math.round(skills * scale);
  } else {
    messages = activeInput - staticSum;
  }

  return {
    systemPrompt: finalSystemPrompt,
    systemTools: finalSystemTools,
    memoryFiles,
    skills,
    messages
  };
}

export function resolveModelFromConfig(projectDir: string, homeDir: string = os.homedir()): string {
  const paths = [
    path.join(projectDir, ".claude", "settings.local.json"),
    path.join(projectDir, ".claude", "settings.json"),
    path.join(homeDir, ".claude", "settings.json")
  ];

  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, "utf8");
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed.model === "string") {
          return parsed.model.toLowerCase();
        }
      }
    } catch {
      // Ignore errors and try the next file
    }
  }

  return "sonnet";
}

// Claude Code reserves a fixed autocompact buffer (~33K tokens) out of the raw
// 1M-token window that current-generation models (Sonnet, Opus, Fable, Mythos) run —
// confirmed against a live `/context` reading: "404.4k/967k tokens", with
// "Autocompact buffer: 33k tokens" itemized separately. 967000 is the effective
// window Claude Code itself compacts against, not the raw model max_input_tokens
// (1,000,000) — use the smaller, empirically-observed number so this estimate lines
// up with what /context actually shows. Haiku 4.5 is the only current model still
// capped at a 200K raw window.
export function resolveMaxTokensForModel(modelId: string): number {
  return modelId.includes("haiku") ? 200000 : 967000;
}

