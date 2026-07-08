import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { findFiles, normalizedRelative, readText, trimSnippet, writeText } from "@artilens/core";
export type DocsFindingType = "stale" | "dead-reference" | "missing-script" | "contradiction-candidate" | "duplicate" | "skill-hygiene";

export interface DocsFinding {
  type: DocsFindingType;
  file: string;
  line: number;
  confidence: "high" | "medium" | "low";
  message: string;
  suggestion: string;
}

export interface DocsHealthReport {
  score: number;
  filesScanned: number;
  findings: DocsFinding[];
}

export interface DocsHealthOptions {
  projectDir?: string;
  paths?: string[];
}

export async function analyzeDocsHealth(options: DocsHealthOptions = {}): Promise<DocsHealthReport> {
  const projectDir = options.projectDir ?? process.cwd();
  const files = options.paths?.length
    ? options.paths.map((file) => (path.isAbsolute(file) ? file : path.join(projectDir, file)))
    : await defaultDocFiles(projectDir);
  const scripts = await packageScripts(projectDir);
  const findings: DocsFinding[] = [];
  const sections: { file: string; line: number; heading: string; text: string }[] = [];
  for (const file of files) {
    const rel = normalizedRelative(projectDir, file);
    const text = await readText(file);
    findings.push(...deadReferences(text, rel, file, projectDir, scripts));
    findings.push(...skillHygiene(text, rel));
    findings.push(...staleSignals(rel, file, text, projectDir));
    sections.push(...extractSections(text, rel));
  }
  findings.push(...contradictionCandidates(sections));
  findings.push(...duplicateSections(sections));
  const score = Math.max(0, 100 - findings.filter((f) => f.confidence === "high").length * 10 - findings.filter((f) => f.confidence === "medium").length * 5 - findings.filter((f) => f.confidence === "low").length * 2);
  return { score, filesScanned: files.length, findings: findings.slice(0, 200) };
}

/**
 * Scrubbed data contract for docs-health. DocsHealthReport already holds only
 * findings (type, file, line, confidence, short message/suggestion) -- no raw
 * document text -- so this wrapper only adds the schema tag.
 */
export interface DocsHealthData extends DocsHealthReport {
  schema: "artilens.docs-health.data/v1";
}

export function buildDocsHealthData(report: DocsHealthReport): DocsHealthData {
  return { schema: "artilens.docs-health.data/v1", ...report };
}

/** Write an analyzed DocsHealthReport to a JSON data file (no HTML). */
export async function writeDocsHealthData(report: DocsHealthReport, dataPath: string, projectDir = process.cwd()): Promise<{ data: DocsHealthData; dataPath: string }> {
  const data = buildDocsHealthData(report);
  const resolvedPath = path.isAbsolute(dataPath) ? dataPath : path.join(projectDir, dataPath);
  await writeText(resolvedPath, JSON.stringify(data, null, 2));
  return { data, dataPath: resolvedPath };
}

async function defaultDocFiles(projectDir: string): Promise<string[]> {
  return findFiles(projectDir, (file) => {
    const rel = normalizedRelative(projectDir, file);
    return /(^|\/)(CLAUDE|AGENTS|README|PROGRESS).*\.md$/i.test(rel) || /^\.claude\/rules\/.+\.md$/i.test(rel) || /^\.claude\/skills\/.+SKILL\.md$/i.test(rel) || /^plan.*\.md$/i.test(rel) || /^plan\/.+\.md$/i.test(rel) || /^workflow.*\.md$/i.test(rel) || /^docs\/.+\.md$/i.test(rel);
  });
}

function deadReferences(text: string, rel: string, file: string, projectDir: string, scripts: Set<string>): DocsFinding[] {
  const findings: DocsFinding[] = [];
  const dir = path.dirname(file);
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const match of line.matchAll(/`([^`]+)`|\[.+?\]\(([^)]+)\)/g)) {
      const ref = (match[1] ?? match[2] ?? "").trim();
      if (!ref || /^https?:|^#|^\$|^~/.test(ref)) continue;
      if (/^(npm|pnpm|yarn)\s+run\s+([\w:-]+)/.test(ref)) {
        const script = /run\s+([\w:-]+)/.exec(ref)?.[1] ?? "";
        if (!scripts.has(script)) {
          findings.push(makeFinding("missing-script", rel, index + 1, "high", `Referenced package script does not exist: ${script}`, "Update the command or add the script to package.json."));
        }
      }
      if (/^[\w./\\-]+\.(md|ts|tsx|js|json|yml|yaml|html|css)$/.test(ref)) {
        const target = path.isAbsolute(ref) ? ref : path.resolve(dir, ref);
        const rootTarget = path.resolve(projectDir, ref);
        if (!fs.existsSync(target) && !fs.existsSync(rootTarget)) {
          findings.push(makeFinding("dead-reference", rel, index + 1, "high", `Referenced path does not exist: ${ref}`, "Fix the path or remove the reference."));
        }
      }
    }
  });
  return findings;
}

function skillHygiene(text: string, rel: string): DocsFinding[] {
  if (!/SKILL\.md$/i.test(rel)) return [];
  const findings: DocsFinding[] = [];
  if (!/^---\n[\s\S]+?\n---/m.test(text)) findings.push(makeFinding("skill-hygiene", rel, 1, "high", "SKILL.md is missing frontmatter.", "Add name, description, and allowed-tools frontmatter."));
  if (!/description:\s*/.test(text)) findings.push(makeFinding("skill-hygiene", rel, 1, "medium", "Skill frontmatter has no description.", "Add a concise when-to-use description."));
  const body = text.replace(/^---\n[\s\S]+?\n---\n?/m, "");
  if (body.split(/\r?\n/).length > 60) findings.push(makeFinding("skill-hygiene", rel, 1, "medium", "Skill body exceeds 60 lines.", "Move details into references/ and keep the body thin."));
  return findings;
}

function staleSignals(rel: string, file: string, text: string, projectDir: string): DocsFinding[] {
  const findings: DocsFinding[] = [];
  const lastDoc = git(["log", "-1", "--format=%ct", "--", file], projectDir);
  if (!lastDoc) return findings;
  const ageDays = (Date.now() / 1000 - Number(lastDoc)) / 86400;
  const paths = [...text.matchAll(/`([\w./\\-]+\/)`/g)].map((match) => match[1]);
  for (const referencedPath of paths.slice(0, 20)) {
    const target = path.join(projectDir, referencedPath);
    if (!fs.existsSync(target)) continue;
    const recent = git(["log", "--since=180 days ago", "--format=%H", "--", target], projectDir)
      .split(/\r?\n/)
      .filter(Boolean).length;
    if (ageDays > 180 && recent > 20) {
      findings.push(makeFinding("stale", rel, 1, "medium", `Document is old but referenced path ${referencedPath} changed ${recent} time(s) recently.`, "Review this section for stale instructions."));
    }
  }
  return findings;
}

function extractSections(text: string, file: string): { file: string; line: number; heading: string; text: string }[] {
  const lines = text.split(/\r?\n/);
  const sections: { file: string; line: number; heading: string; text: string }[] = [];
  let current = { file, line: 1, heading: "intro", text: "" };
  lines.forEach((line, index) => {
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      sections.push(current);
      current = { file, line: index + 1, heading: heading[2].toLowerCase(), text: "" };
    } else {
      current.text += `${line}\n`;
    }
  });
  sections.push(current);
  return sections.filter((section) => section.text.trim().length > 40);
}

function contradictionCandidates(sections: { file: string; line: number; heading: string; text: string }[]): DocsFinding[] {
  const findings: DocsFinding[] = [];
  const topics = [
    { key: "test", words: ["test", "vitest", "jest", "pytest"] },
    { key: "format", words: ["format", "prettier", "eslint"] },
    { key: "commit", words: ["commit", "conventional"] },
    { key: "artifact", words: ["artifact", "csp", "external"] }
  ];
  for (const topic of topics) {
    const matching = sections.filter((section) => topic.words.some((word) => section.text.toLowerCase().includes(word)));
    for (let a = 0; a < matching.length; a += 1) {
      for (let b = a + 1; b < matching.length; b += 1) {
        const left = matching[a].text.toLowerCase();
        const right = matching[b].text.toLowerCase();
        if ((/\bmust\b|\brequired\b|\bzorunlu\b/.test(left) && /\bmust not\b|\bforbidden\b|\byasak\b/.test(right)) || (/\bmust not\b|\bforbidden\b|\byasak\b/.test(left) && /\bmust\b|\brequired\b|\bzorunlu\b/.test(right))) {
          findings.push(makeFinding("contradiction-candidate", matching[a].file, matching[a].line, "low", `Potential contradiction with ${matching[b].file}:${matching[b].line} on ${topic.key}.`, "Ask the docs-health skill to verify the candidate lines before editing."));
        }
      }
    }
  }
  return findings.slice(0, 30);
}

function duplicateSections(sections: { file: string; line: number; heading: string; text: string }[]): DocsFinding[] {
  const findings: DocsFinding[] = [];
  for (let a = 0; a < sections.length; a += 1) {
    for (let b = a + 1; b < sections.length; b += 1) {
      const score = jaccard(words(sections[a].text), words(sections[b].text));
      if (score > 0.82) {
        findings.push(makeFinding("duplicate", sections[a].file, sections[a].line, "low", `Highly similar to ${sections[b].file}:${sections[b].line}.`, "Consider merging duplicate guidance."));
      }
    }
  }
  return findings.slice(0, 30);
}

async function packageScripts(projectDir: string): Promise<Set<string>> {
  try {
    const json = JSON.parse(await readText(path.join(projectDir, "package.json")));
    return new Set(Object.keys(json.scripts ?? {}));
  } catch {
    return new Set();
  }
}

function makeFinding(type: DocsFindingType, file: string, line: number, confidence: DocsFinding["confidence"], message: string, suggestion: string): DocsFinding {
  return { type, file, line, confidence, message: trimSnippet(message, 180), suggestion };
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9_-]{4,}/g) ?? []);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  const intersection = [...a].filter((item) => b.has(item)).length;
  return intersection / Math.max(1, new Set([...a, ...b]).size);
}

function git(args: string[], cwd: string): string {
  try {
    return childProcess.execFileSync("git", ["-c", "core.quotepath=false", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "";
  }
}

