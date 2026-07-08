#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import {
  annotateArtifact,
  captureArtifact,
  diffArtifactVersions,
  ensureDir,
  formatPruneSummary,
  listArtifacts,
  pathExists,
  pruneArtifacts,
  readText,
  registryRoot,
  stableJson,
  writeText
} from "@artilens/core";

import { writeLensData, writeUsageData } from "@artilens/lens";
import { collectGitCommit, collectGitStatus, collectPr, collectRemoteDiff, parseCoverage, writeCoverageData, writeGitData } from "@artilens/git-viz";
import { writeSessionData, type SessionViewKind } from "@artilens/session-viz";
import { analyzeDocsHealth, writeDocsHealthData } from "@artilens/docs-health";

const program = new Command();

program.name("artilens").description("Claude Code Artifacts companion toolkit").version("0.1.1");

program
  .command("lens")
  .option("--session <path>", "transcript path")
  .option("--latest", "use latest transcript")
  .requiredOption("--data <file>", "write scrubbed data JSON for native-artifact authoring")
  .action(async (options) => {
    const { report, dataPath } = await writeLensData({ session: options.session, latest: options.latest, projectDir: process.cwd(), dataPath: options.data });
    printQuiet(dataPath, `${Math.round(report.healthScore)}/100, ${report.usedPercentage}% context, recommendation ${report.decision.action}`);
  });

program
  .command("usage")
  .option("--session <path>", "transcript path")
  .option("--latest", "use latest transcript")
  .requiredOption("--data <file>", "write scrubbed usage data JSON for native-artifact authoring")
  .action(async (options) => {
    const { report, dataPath } = await writeUsageData({ session: options.session, latest: options.latest, projectDir: process.cwd(), dataPath: options.data });
    printQuiet(dataPath, `$${report.totalCostUsd.toFixed(2)} total${report.totalCostIsEstimate ? " (estimate)" : ""}, ${report.modelRows.length} model(s), ${report.linesAdded}+/${report.linesRemoved}- lines (approx)`);
  });

const git = program.command("git").description("Emit git data for native-artifact authoring");
git.command("status").requiredOption("--data <file>", "write scrubbed git data JSON for native-artifact authoring").action(async (options) => {
  const data = collectGitStatus(process.cwd());
  const { dataPath } = await writeGitData(data, options.data, process.cwd());
  printQuiet(dataPath, data.summary);
});
git.command("commit").argument("[ref]", "commit ref", "HEAD").requiredOption("--data <file>", "write scrubbed git data JSON for native-artifact authoring").action(async (ref, options) => {
  const data = collectGitCommit(ref, process.cwd());
  const { dataPath } = await writeGitData(data, options.data, process.cwd());
  printQuiet(dataPath, data.summary);
});
git.command("remote-diff").option("--base <branch>", "base ref", "@{upstream}").requiredOption("--data <file>", "write scrubbed git data JSON for native-artifact authoring").action(async (options) => {
  const data = collectRemoteDiff(options.base, process.cwd());
  const { dataPath } = await writeGitData(data, options.data, process.cwd());
  printQuiet(dataPath, data.summary);
});
git.command("pr").option("--base <branch>", "base branch", "main").requiredOption("--data <file>", "write scrubbed git data JSON for native-artifact authoring").action(async (options) => {
  const data = collectPr(options.base, process.cwd());
  const { dataPath } = await writeGitData(data, options.data, process.cwd());
  printQuiet(dataPath, data.summary);
});

program
  .command("coverage")
  .requiredOption("--from <file>", "lcov, vitest/jest JSON, or pytest/cobertura XML")
  .requiredOption("--data <file>", "write scrubbed coverage data JSON for native-artifact authoring")
  .action(async (options) => {
    const report = await parseCoverage(options.from);
    const { dataPath } = await writeCoverageData(report, options.data, process.cwd());
    printQuiet(dataPath, `${report.total.pct.toFixed(1)}% total coverage across ${report.files.length} file(s)`);
  });

const session = program.command("session").description("Emit session data for native-artifact authoring");
for (const kind of ["agents", "todos", "context-files", "commands"] as SessionViewKind[]) {
  session
    .command(kind)
    .option("--session <path>", "transcript path")
    .requiredOption("--data <file>", "write scrubbed session data JSON for native-artifact authoring")
    .action(async (options) => {
      const { data, dataPath } = await writeSessionData({ kind, projectDir: process.cwd(), transcriptPath: options.session, dataPath: options.data });
      printQuiet(dataPath, data.summary);
    });
}

program
  .command("docs-health")
  .option("--paths <paths>", "comma-separated paths")
  .option("--no-llm", "accepted for PRD workflow; CLI always runs deterministic stage")
  .option("--json", "print JSON")
  .option("--data <file>", "write scrubbed docs-health data JSON for native-artifact authoring")
  .action(async (options) => {
    const paths = options.paths ? options.paths.split(",").map((item: string) => item.trim()) : undefined;
    const report = await analyzeDocsHealth({ projectDir: process.cwd(), paths });
    if (options.data) {
      const { dataPath } = await writeDocsHealthData(report, options.data, process.cwd());
      printQuiet(dataPath, `${report.score}/100 docs health, ${report.findings.length} finding(s)`);
      return;
    }
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else printQuiet(undefined, `${report.score}/100 docs health, ${report.findings.length} finding(s)`);
  });

const artifacts = program.command("artifacts").description("Manage local artifact registry");
artifacts.command("list").option("--scope <scope>", "filter scope").option("--json", "print JSON").action(async (options) => {
  let items = await listArtifacts(process.cwd());
  if (options.scope) items = items.filter((item) => item.scope === options.scope);
  if (options.json) console.log(JSON.stringify(items, null, 2));
  else {
    const indexPath = path.join(registryRoot(process.cwd()), "index.md");
    if (await pathExists(indexPath)) console.log(await readText(indexPath));
    else console.log("No artifacts yet.");
  }
});
artifacts.command("show").argument("<slug>").action(async (slug) => {
  const metaPath = path.join(registryRoot(process.cwd()), slug, "meta.yaml");
  console.log(await readText(metaPath));
});
artifacts.command("diff").argument("<slug>").argument("<vA>").argument("<vB>").option("--as-artifact", "write HTML diff").option("--out <file>", "output HTML").action(async (slug, vA, vB, options) => {
  const html = await diffArtifactVersions(process.cwd(), slug, Number(vA), Number(vB));
  if (options.asArtifact || options.out) {
    const out = options.out ?? path.join(".claude", "artilens", `${slug}-diff.html`);
    await writeText(out, html);
    printQuiet(out, `diff ${slug} v${vA}..v${vB}`);
  } else {
    console.log(html);
  }
});
artifacts.command("capture").option("--file <file>", "artifact file").option("--title <title>", "title").option("--url <url>", "artifact URL").option("--scope <scope>", "scope", "custom").option("--summary <summary>", "summary").action(async (options) => {
  const meta = await captureArtifact({ projectDir: process.cwd(), sourcePath: options.file, title: options.title, url: options.url ?? null, scope: options.scope, summary: options.summary });
  printQuiet(path.join(registryRoot(process.cwd()), meta.slug), `${meta.slug} v${meta.versions.at(-1)?.v}`);
});
artifacts.command("prune").requiredOption("--keep-last <n>", "versions to keep", numberOption).action(async (options) => {
  const result = await pruneArtifacts(process.cwd(), options.keepLast);
  console.log(formatPruneSummary(result));
});
artifacts.command("annotate").argument("<slug>").option("--summary <summary>").option("--tags <tags>").action(async (slug, options) => {
  const meta = await annotateArtifact(process.cwd(), slug, { summary: options.summary, tags: options.tags?.split(",").map((item: string) => item.trim()) });
  printQuiet(path.join(registryRoot(process.cwd()), meta.slug, "meta.yaml"), `${meta.slug} annotated`);
});

program
  .command("init")
  .option("--optional-hooks", "install optional lens/event/context hooks")
  .option("--gitignore-artifacts", "add .claude/artifacts to .gitignore")
  .action(async (options) => {
    await initProject(process.cwd(), { optionalHooks: options.optionalHooks, gitignoreArtifacts: options.gitignoreArtifacts });
    printQuiet(".claude/settings.json", "ArtiLens project files installed idempotently");
  });

const hook = program.command("hook").description("Internal hook entry points");
hook.command("registry").action(async () => {
  const stdin = await readStdin();
  const output = await runRegistryHook(stdin, process.env.CLAUDE_PROJECT_DIR || process.cwd());
  if (output) process.stdout.write(output);
});
hook.command("event-log").action(async () => {
  const stdin = await readStdin();
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  await ensureDir(path.join(projectDir, ".claude", "artilens"));
  await fs.promises.appendFile(path.join(projectDir, ".claude", "artilens", "events.jsonl"), `${stdin.trim()}\n`, "utf8");
});
hook.command("lens-threshold").action(async () => {
  const stdin = await readStdin();
  const payload = JSON.parse(stdin || "{}");
  const pct = Number(payload?.context_window?.used_percentage ?? payload?.context?.used_percentage ?? 0);
  if (pct >= 80) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: payload.hook_event_name ?? "Stop", systemMessage: `ArtiLens: context is ${pct}%. Consider /artilens:lens or handoff.` } }));
  } else if (pct >= 60) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: payload.hook_event_name ?? "Stop", systemMessage: `ArtiLens: context is ${pct}%. Consider /compact after preserving active decisions.` } }));
  }
});

program.command("doctor").option("--skills", "validate skill frontmatter and body length").action(async (options) => {
  const findings = options.skills ? await validateSkills(process.cwd()) : [];
  if (findings.length > 0) {
    console.log(findings.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("ArtiLens doctor passed.");
  }
});

const argv = process.argv[2] === "--" ? [process.argv[0], process.argv[1], ...process.argv.slice(3)] : process.argv;

program.parseAsync(argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});

async function extractArtifactSource(payload: any, projectDir = process.cwd()): Promise<{ filePath?: string; content?: string; syntheticName?: string } | undefined> {
  const input = payload?.tool_input ?? payload?.input ?? payload ?? {};
  const candidates = [
    input.file_path,
    input.path,
    input.filename,
    input.file,
    input.artifact?.file_path,
    input.artifact?.path
  ].filter((value) => typeof value === "string") as string[];
  for (const candidate of candidates) {
    const resolved = path.isAbsolute(candidate) ? candidate : path.join(projectDir, candidate);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return { filePath: resolved };
  }
  for (const key of ["content", "html", "markdown", "source"]) {
    if (typeof input[key] === "string" && input[key].trim()) {
      return { content: input[key], syntheticName: `inline-artifact.${key === "markdown" ? "md" : "html"}` };
    }
  }
  return undefined;
}

async function runRegistryHook(stdin: string, projectDir: string): Promise<string> {
  try {
    const payload = JSON.parse(stdin || "{}");
    const source = await extractArtifactSource(payload, projectDir);
    if (!source) return "";
    const input = payload.tool_input ?? {};
    const response = payload.tool_response ?? payload.tool_output ?? payload.response ?? {};
    const url = extractUrl(response) ?? extractUrl(payload) ?? null;
    const meta = await captureArtifact({
      projectDir,
      sourcePath: source.filePath,
      content: source.content,
      title: input.title ?? input.name,
      url,
      scope: input.scope ?? "custom",
      sessionId: payload.session_id ?? null
    });
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: `ArtiLens registry captured ${meta.slug} v${meta.versions.at(-1)?.v}.`
      }
    });
  } catch (error) {
    await ensureDir(path.join(projectDir, ".claude", "artilens"));
    await fs.promises.appendFile(path.join(projectDir, ".claude", "artilens", "registry-errors.log"), `${JSON.stringify({ at: new Date().toISOString(), error: String(error) })}\n`, "utf8");
    return "";
  }
}

async function initProject(projectDir: string, options: { optionalHooks?: boolean; gitignoreArtifacts?: boolean }): Promise<void> {
  await ensureDir(path.join(projectDir, ".claude", "rules"));
  await writeText(path.join(projectDir, ".artifactignore"), ".env*\n*.pem\n*.key\nsecrets/**\n");
  const settingsPath = path.join(projectDir, ".claude", "settings.json");
  const settings = (await pathExists(settingsPath)) ? JSON.parse(await readText(settingsPath)) : {};
  settings.hooks ??= {};
  if (options.optionalHooks) {
    const lensThresholdCommand = pluginScriptCommand("lens-threshold-hook.mjs", ["hook", "lens-threshold"]);
    const eventLogCommand = pluginScriptCommand("event-log-hook.mjs", ["hook", "event-log"]);
    settings.hooks.Stop = mergeHook(settings.hooks.Stop, {
      matcher: "*",
      hooks: [{ type: "command", command: lensThresholdCommand }]
    });
    settings.hooks.SubagentStart = mergeHook(settings.hooks.SubagentStart, {
      matcher: "*",
      hooks: [{ type: "command", command: eventLogCommand }]
    });
    settings.hooks.SubagentStop = mergeHook(settings.hooks.SubagentStop, {
      matcher: "*",
      hooks: [{ type: "command", command: eventLogCommand }]
    });
    settings.hooks.InstructionsLoaded = mergeHook(settings.hooks.InstructionsLoaded, {
      matcher: "*",
      hooks: [{ type: "command", command: eventLogCommand }]
    });
  }
  await writeText(settingsPath, `${stableJson(settings)}\n`);
  if (options.gitignoreArtifacts) {
    const gitignore = path.join(projectDir, ".gitignore");
    const current = (await pathExists(gitignore)) ? await readText(gitignore) : "";
    if (!current.includes(".claude/artifacts/")) await writeText(gitignore, `${current.trimEnd()}\n.claude/artifacts/\n`);
  }
}

function mergeHook(existing: any[] | undefined, hookConfig: any): any[] {
  const list = existing ?? [];
  const serialized = JSON.stringify(hookConfig);
  return list.some((item) => JSON.stringify(item) === serialized) ? list : [...list, hookConfig];
}

function pluginScriptCommand(scriptName: string, fallbackArgs: string[]): string {
  const pluginRoot = findRuntimePluginRoot();
  if (!pluginRoot) return `artilens ${fallbackArgs.join(" ")}`;
  return `node "${path.join(pluginRoot, "scripts", scriptName).replace(/\\/g, "/")}"`;
}

function findRuntimePluginRoot(): string | undefined {
  const candidates = [
    process.env.CLAUDE_PLUGIN_ROOT,
    process.argv[1] ? path.resolve(path.dirname(process.argv[1]), "..") : undefined
  ].filter((value): value is string => Boolean(value));

  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "scripts", "run-artilens.mjs")));
}

function extractUrl(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? {});
  return /https:\/\/claude\.ai\/code\/artifact\/[A-Za-z0-9_-]+/.exec(text)?.[0];
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function numberOption(value: string): number {
  return Number(value);
}

function printQuiet(filePath: string | undefined, summary: string): void {
  if (filePath) console.log(filePath);
  console.log(summary);
}

async function validateSkills(projectDir: string): Promise<string[]> {
  const skillFiles = await findSkillFiles(path.join(projectDir, "plugin", "skills"));
  const findings: string[] = [];
  for (const file of skillFiles) {
    const text = await readText(file);
    const frontmatter = /^---\r?\n([\s\S]+?)\r?\n---/.exec(text)?.[1] ?? "";
    const body = text.replace(/^---\r?\n[\s\S]+?\r?\n---\r?\n?/, "");
    for (const field of ["name", "description", "allowed-tools"]) {
      if (!new RegExp(`^${field}:`, "m").test(frontmatter)) findings.push(`${file}: missing ${field}`);
    }
    if (body.split(/\r?\n/).length > 60) findings.push(`${file}: body exceeds 60 lines`);
  }
  return findings;
}

async function findSkillFiles(root: string): Promise<string[]> {
  if (!(await pathExists(root))) return [];
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name === "SKILL.md") files.push(full);
    }
  }
  await walk(root);
  return files;
}

