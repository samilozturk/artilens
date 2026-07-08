import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findFiles,
  findLatestTranscript,
  normalizedRelative,
  parseTranscriptFile,
  readText,
  resolveClaudeConfigDir,
  trimSnippet,
  writeText,
  type TranscriptAnalysis
} from "@artilens/core";
export type SessionViewKind = "agents" | "todos" | "context-files" | "commands";

export interface SessionViewOptions {
  kind: SessionViewKind;
  projectDir?: string;
  transcriptPath?: string;
}

export interface AgentSummary {
  id: string;
  task: string;
  status: string;
  tokens: number;
  source: string;
}

export interface CommandSummary {
  name: string;
  source: string;
  description: string;
  example: string;
}

/**
 * Scrubbed, kind-specific data contract for native-artifact authoring. Carries the
 * aggregated rows the render path would otherwise embed inside kit `table`/`kanban`
 * shapes, without any raw transcript text or tool-call examples.
 */
export interface SessionViewData {
  schema: "artilens.session.data/v1";
  kind: SessionViewKind;
  title: string;
  summary: string;
  agents?: AgentSummary[];
  todos?: { text: string; status: string; source: string }[];
  contextFiles?: { file: string; loaded: boolean; reads: number; bytes: number; status: string }[];
  commands?: CommandSummary[];
  recommendations?: CommandSummary[];
}

/** Collect the pure data for a session view kind, separate from HTML rendering. */
export async function collectSessionView(options: SessionViewOptions): Promise<SessionViewData> {
  const projectDir = options.projectDir ?? process.cwd();
  const transcriptPath = options.transcriptPath ?? (await findLatestTranscript(projectDir));
  const analysis = transcriptPath ? await parseTranscriptFile(transcriptPath) : emptyAnalysis();
  if (options.kind === "agents") {
    const agents = await collectAgents(analysis, projectDir);
    return { schema: "artilens.session.data/v1", kind: "agents", title: "ArtiLens Agents", summary: `${agents.length} agent/task signal(s) detected.`, agents };
  }
  if (options.kind === "todos") {
    const todos = await collectTodos(analysis, projectDir);
    return { schema: "artilens.session.data/v1", kind: "todos", title: "ArtiLens Todos", summary: `${todos.length} todo/plan item(s) detected.`, todos };
  }
  if (options.kind === "context-files") {
    const contextFiles = await collectContextFiles(analysis, projectDir);
    return {
      schema: "artilens.session.data/v1",
      kind: "context-files",
      title: "ArtiLens Context Files",
      summary: `${contextFiles.length} context file(s), ${contextFiles.filter((file) => file.status === "loaded-unused").length} loaded-unused signal(s).`,
      contextFiles
    };
  }
  const { commands, recommendations } = await collectCommands(projectDir);
  return {
    schema: "artilens.session.data/v1",
    kind: "commands",
    title: "ArtiLens Commands",
    summary: `${commands.length} command(s), ${recommendations.length} contextual recommendation(s).`,
    commands,
    recommendations
  };
}

/** Collect a session view's data and write it to a JSON data file (no HTML). */
export async function writeSessionData(options: SessionViewOptions & { dataPath: string }): Promise<{ data: SessionViewData; dataPath: string }> {
  const data = await collectSessionView(options);
  const projectDir = options.projectDir ?? process.cwd();
  const resolvedPath = path.isAbsolute(options.dataPath) ? options.dataPath : path.join(projectDir, options.dataPath);
  await writeText(resolvedPath, JSON.stringify(data, null, 2));
  return { data, dataPath: resolvedPath };
}

export async function collectAgents(analysis: TranscriptAnalysis, projectDir = process.cwd()): Promise<AgentSummary[]> {
  const agents: AgentSummary[] = [];
  for (const tool of analysis.toolCalls) {
    if (/Task|Agent|subagent/i.test(tool.name)) {
      agents.push({
        id: `${tool.name}-${agents.length + 1}`,
        task: tool.examples[0] ?? tool.name,
        status: "observed",
        tokens: Math.ceil((tool.inputBytes + tool.outputBytes) / 4),
        source: "transcript"
      });
    }
  }
  const eventPath = path.join(projectDir, ".claude", "artilens", "events.jsonl");
  if (fs.existsSync(eventPath)) {
    for (const line of fs.readFileSync(eventPath, "utf8").split(/\r?\n/).filter(Boolean)) {
      try {
        const event = JSON.parse(line);
        if (/Subagent|Task/.test(event.event ?? event.hook_event_name ?? "")) {
          agents.push({
            id: event.id ?? `event-${agents.length + 1}`,
            task: trimSnippet(event.payload?.prompt ?? event.payload?.description ?? event.event, 160),
            status: event.event ?? event.hook_event_name ?? "event",
            tokens: 0,
            source: "hook-log"
          });
        }
      } catch {
        // ignored: event logs are best-effort
      }
    }
  }
  return agents;
}

export async function collectTodos(analysis: TranscriptAnalysis, projectDir = process.cwd()): Promise<{ text: string; status: string; source: string }[]> {
  const todos = analysis.todos.map((todo) => ({ ...todo, source: "transcript" }));
  const planFiles = await findFiles(projectDir, (file) => /(^|[/\\])(PLAN|plan|PROGRESS).*\.(md|txt)$/i.test(file));
  for (const file of planFiles.slice(0, 8)) {
    const text = await readText(file);
    for (const match of text.matchAll(/^\s*[-*]\s+\[( |x|X|-)\]\s+(.+)$/gm)) {
      todos.push({
        text: trimSnippet(match[2], 180),
        status: match[1].toLowerCase() === "x" ? "done" : match[1] === "-" ? "skipped" : "todo",
        source: normalizedRelative(projectDir, file)
      });
    }
  }
  return todos;
}

export async function collectContextFiles(analysis: TranscriptAnalysis, projectDir = process.cwd()): Promise<{ file: string; loaded: boolean; reads: number; bytes: number; status: string }[]> {
  const files = await findFiles(projectDir, (file) => {
    const rel = normalizedRelative(projectDir, file);
    return /(^|\/)(CLAUDE|AGENTS)\.md$/i.test(rel) || /^\.claude\/rules\/.+\.md$/i.test(rel) || /^(\.claude|plugin)\/skills\/.+SKILL\.md$/i.test(rel) || /^plan\/.+\.md$/i.test(rel) || /^docs\/.+\.md$/i.test(rel);
  });
  return Promise.all(
    files.map(async (file) => {
      const rel = normalizedRelative(projectDir, file);
      const bytes = Buffer.byteLength(await readText(file), "utf8");
      const reads = analysis.fileReads[file] ?? analysis.fileReads[rel] ?? 0;
      const loaded = /CLAUDE\.md|rules|SKILL\.md/i.test(rel);
      return {
        file: rel,
        loaded,
        reads,
        bytes,
        status: loaded && reads === 0 ? "loaded-unused" : reads > 0 ? "active" : "available"
      };
    })
  );
}

export async function collectCommands(projectDir = process.cwd()): Promise<{ commands: CommandSummary[]; recommendations: CommandSummary[] }> {
  const commands: CommandSummary[] = [
    { name: "/compact", source: "built-in", description: "Compress prior context while preserving instructions.", example: "/compact preserve active files and decisions" },
    { name: "/clear", source: "built-in", description: "Start a fresh session context.", example: "/clear" },
    { name: "/context", source: "built-in", description: "Inspect current context usage.", example: "/context" },
    { name: "/usage", source: "built-in", description: "Inspect usage and limits.", example: "/usage" },
    { name: "/plan", source: "built-in", description: "Use plan mode before a large implementation.", example: "/plan" }
  ];
  const skillRoots = [path.join(projectDir, "plugin", "skills"), path.join(projectDir, ".claude", "skills"), path.join(resolveClaudeConfigDir(), "skills")];
  for (const root of skillRoots) {
    const skillFiles = await findFiles(root, (file) => path.basename(file) === "SKILL.md");
    for (const file of skillFiles) {
      const text = await readText(file);
      const name = /name:\s*([^\n]+)/.exec(text)?.[1]?.trim() ?? path.basename(path.dirname(file));
      const description = /description:\s*>?-\s*([\s\S]*?)(?:\n\w|---)/.exec(text)?.[1]?.replace(/\s+/g, " ").trim() ?? "Skill command";
      commands.push({ name: name.startsWith("/") ? name : `/${name}`, source: normalizedSource(file, projectDir), description, example: name.startsWith("/") ? name : `/${name}` });
    }
  }
  const commandFiles = await findFiles(path.join(projectDir, ".claude", "commands"), (file) => file.endsWith(".md"));
  for (const file of commandFiles) {
    commands.push({ name: `/${path.basename(file, ".md")}`, source: ".claude/commands", description: trimSnippet(await readText(file), 100), example: `/${path.basename(file, ".md")}` });
  }
  const recommendations = recommendCommands(commands, projectDir);
  return { commands, recommendations };
}

function recommendCommands(commands: CommandSummary[], projectDir: string): CommandSummary[] {
  const dirty = git(["status", "--porcelain"], projectDir).trim().length > 0;
  const changedTests = /test|spec/i.test(git(["diff", "--name-only", "HEAD"], projectDir));
  const wanted = new Set<string>();
  if (dirty) {
    wanted.add("/artilens:git");
    wanted.add("/artilens:pr");
  }
  if (changedTests) wanted.add("/artilens:coverage");
  wanted.add("/artilens:lens");
  return commands.filter((command) => wanted.has(command.name));
}

function normalizedSource(file: string, projectDir: string): string {
  if (file.startsWith(projectDir)) return normalizedRelative(projectDir, file);
  if (file.startsWith(os.homedir())) return file.replace(os.homedir(), "~");
  return file;
}

function git(args: string[], cwd: string): string {
  try {
    return childProcess.execFileSync("git", ["-c", "core.quotepath=false", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return "";
  }
}

function emptyAnalysis(): TranscriptAnalysis {
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
    lineChanges: { added: 0, removed: 0 }
  };
}

