import fs from "node:fs";
import path from "node:path";
import { findFiles, newestFile, resolveClaudeConfigDir } from "../util/fs.js";
import { scrubSecrets, trimSnippet, unique } from "../util/strings.js";

export interface TranscriptUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  estimatedTokens: number;
}

export interface ToolCallSummary {
  id?: string;
  name: string;
  inputBytes: number;
  outputBytes: number;
  count: number;
  examples: string[];
}

export interface TranscriptMessageSummary {
  index: number;
  timestamp?: string;
  role: string;
  type?: string;
  text: string;
  bytes: number;
}

export interface TranscriptAnalysis {
  sourcePath?: string;
  lineCount: number;
  parseErrors: number;
  unknownLines: number;
  messages: TranscriptMessageSummary[];
  usage: TranscriptUsage;
  toolCalls: ToolCallSummary[];
  fileReads: Record<string, number>;
  todos: { text: string; status: string }[];
  userPromptTopics: string[][];
  subagentPaths: string[];
  model?: string;
  modelUsage: Record<string, TranscriptUsage>;
  lineChanges: { added: number; removed: number };
}

export async function findLatestTranscript(cwd = process.cwd(), env = process.env): Promise<string | undefined> {
  const configDir = resolveClaudeConfigDir(env);
  const projectsDir = path.join(configDir, "projects");
  const all = await findFiles(projectsDir, (file) => file.endsWith(".jsonl"));
  if (all.length === 0) return undefined;
  const projectKey = cwd.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const preferred = all.filter((file) => file.includes(projectKey));
  return newestFile(preferred.length > 0 ? preferred : all);
}

export async function parseTranscriptFile(filePath: string): Promise<TranscriptAnalysis> {
  const text = await fs.promises.readFile(filePath, "utf8");
  const analysis = parseTranscriptText(text);
  analysis.sourcePath = filePath;
  const subDir = path.join(path.dirname(filePath), "subagents");
  analysis.subagentPaths = await findFiles(subDir, (file) => file.endsWith(".jsonl"));
  return analysis;
}

export function parseTranscriptText(text: string): TranscriptAnalysis {
  const usage: TranscriptUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    estimatedTokens: 0
  };
  const messages: TranscriptMessageSummary[] = [];
  const toolMap = new Map<string, ToolCallSummary>();
  const idToName = new Map<string, string>();
  const fileReads: Record<string, number> = {};
  const todos: { text: string; status: string }[] = [];
  const userPromptTopics: string[][] = [];
  const modelUsage: Record<string, TranscriptUsage> = {};
  const lineChanges = { added: 0, removed: 0 };
  let parseErrors = 0;
  let unknownLines = 0;
  let model: string | undefined;
  const lines = text.split(/\r?\n/).filter(Boolean);

  lines.forEach((line, index) => {
    let item: any;
    try {
      item = JSON.parse(line);
    } catch {
      parseErrors += 1;
      return;
    }
    const message = item.message ?? item;
    if (message?.model && typeof message.model === "string") {
      model = message.model;
    }
    const content = message.content ?? item.content;
    const role = message.role ?? item.type ?? "unknown";
    const usageRecord = message.usage ?? item.usage;
    const textContent = extractText(content);
    const bytes = Buffer.byteLength(line, "utf8");
    if (usageRecord) {
      usage.inputTokens = Number(usageRecord.input_tokens ?? 0);
      usage.outputTokens = Number(usageRecord.output_tokens ?? 0);
      usage.cacheCreationInputTokens = Number(usageRecord.cache_creation_input_tokens ?? 0);
      usage.cacheReadInputTokens = Number(usageRecord.cache_read_input_tokens ?? 0);
      usage.estimatedTokens = 0;
      const usageModel = message?.model && typeof message.model === "string" ? message.model : model;
      if (usageModel) {
        const bucket = modelUsage[usageModel] ?? {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          estimatedTokens: 0
        };
        bucket.inputTokens += Number(usageRecord.input_tokens ?? 0);
        bucket.outputTokens += Number(usageRecord.output_tokens ?? 0);
        bucket.cacheCreationInputTokens += Number(usageRecord.cache_creation_input_tokens ?? 0);
        bucket.cacheReadInputTokens += Number(usageRecord.cache_read_input_tokens ?? 0);
        modelUsage[usageModel] = bucket;
      }
    } else {
      usage.estimatedTokens += Math.ceil(bytes / 4);
    }
    if (role !== "unknown" || textContent) {
      messages.push({
        index,
        timestamp: item.timestamp,
        role,
        type: item.type,
        text: trimSnippet(textContent, 200),
        bytes
      });
    } else {
      unknownLines += 1;
    }
    if (role === "user" && textContent) {
      userPromptTopics.push(extractPathTokens(textContent));
    }
    for (const block of Array.isArray(content) ? content : []) {
      if (block?.type === "tool_use") {
        const name = String(block.name ?? "unknown");
        if (block.id) idToName.set(String(block.id), name);
        const inputBytes = Buffer.byteLength(JSON.stringify(block.input ?? {}), "utf8");
        const current = toolMap.get(name) ?? { name, inputBytes: 0, outputBytes: 0, count: 0, examples: [] };
        current.inputBytes += inputBytes;
        current.count += 1;
        if (current.examples.length < 3) current.examples.push(trimSnippet(JSON.stringify(block.input ?? {}), 120));
        toolMap.set(name, current);
        extractFilesFromTool(name, block.input, fileReads);
        extractTodos(block.input, todos);
        extractLineChanges(name, block.input, lineChanges);
      }
      if (block?.type === "tool_result") {
        const outputBytes = Buffer.byteLength(JSON.stringify(block.content ?? ""), "utf8");
        // Real transcripts key tool_result blocks by tool_use_id only; map it back
        // to the originating tool name so output bytes land on the right row.
        const mapped = block.tool_use_id ? idToName.get(String(block.tool_use_id)) : undefined;
        const key = mapped ?? block.name ?? block.tool_name ?? "tool_result";
        const current = toolMap.get(String(key)) ?? { name: String(key), inputBytes: 0, outputBytes: 0, count: 0, examples: [] };
        current.outputBytes += outputBytes;
        toolMap.set(String(key), current);
      }
    }
  });

  return {
    lineCount: lines.length,
    parseErrors,
    unknownLines,
    messages,
    usage,
    toolCalls: [...toolMap.values()].sort((a, b) => b.inputBytes + b.outputBytes - (a.inputBytes + a.outputBytes)),
    fileReads,
    todos,
    userPromptTopics,
    modelUsage,
    lineChanges,
    subagentPaths: [],
    model
  };
}

export function totalTranscriptTokens(analysis: TranscriptAnalysis): number {
  const usage = analysis.usage;
  return usage.inputTokens + usage.outputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens + usage.estimatedTokens;
}

export function extractText(content: unknown): string {
  if (typeof content === "string") return scrubSecrets(content);
  if (Array.isArray(content)) {
    return scrubSecrets(
      content
        .map((block) => {
          if (typeof block === "string") return block;
          if (block?.type === "text") return block.text ?? "";
          if (block?.type === "tool_result") return block.content ?? "";
          return "";
        })
        .filter(Boolean)
        .join("\n")
    );
  }
  return "";
}

function extractPathTokens(text: string): string[] {
  return unique([...text.matchAll(/[\w./\\-]+\.(?:ts|tsx|js|jsx|json|md|css|html|yml|yaml)/g)].map((match) => match[0]));
}

function extractFilesFromTool(name: string, input: any, fileReads: Record<string, number>): void {
  const keys = ["file_path", "path", "notebook_path"];
  if (!["Read", "Edit", "Write", "MultiEdit", "NotebookRead", "NotebookEdit"].includes(name)) return;
  for (const key of keys) {
    const file = input?.[key];
    if (typeof file === "string") fileReads[file] = (fileReads[file] ?? 0) + 1;
  }
}

function countLines(text: string): number {
  if (!text) return 0;
  const normalized = text.replace(/\r?\n$/, "");
  if (!normalized) return 0;
  return normalized.split(/\r?\n/).length;
}

/**
 * Tallies approximate lines added/removed from Write/Edit/MultiEdit tool_use
 * inputs, read here (before the parser's examples get trimmed to 120-char
 * snippets) so the count reflects the full input, not a truncated preview.
 * This is a line-count derived from tool payloads, not a real diff.
 */
function extractLineChanges(name: string, input: any, lineChanges: { added: number; removed: number }): void {
  if (name === "Write") {
    if (typeof input?.content === "string") lineChanges.added += countLines(input.content);
    return;
  }
  if (name === "Edit") {
    if (typeof input?.new_string === "string") lineChanges.added += countLines(input.new_string);
    if (typeof input?.old_string === "string") lineChanges.removed += countLines(input.old_string);
    return;
  }
  if (name === "MultiEdit") {
    for (const edit of Array.isArray(input?.edits) ? input.edits : []) {
      if (typeof edit?.new_string === "string") lineChanges.added += countLines(edit.new_string);
      if (typeof edit?.old_string === "string") lineChanges.removed += countLines(edit.old_string);
    }
  }
}

function extractTodos(input: any, todos: { text: string; status: string }[]): void {
  const values = Array.isArray(input?.todos) ? input.todos : Array.isArray(input?.tasks) ? input.tasks : [];
  for (const value of values) {
    const text = value.content ?? value.text ?? value.title;
    if (text) todos.push({ text: trimSnippet(text, 160), status: String(value.status ?? "unknown") });
  }
}

