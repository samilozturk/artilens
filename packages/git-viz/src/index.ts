import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readText, writeText } from "@artilens/core";

export interface ChangedFile {
  path: string;
  status: string;
  added: number;
  deleted: number;
  risk: "low" | "medium" | "high";
  reasons: string[];
}

export interface GitViewData {
  title: string;
  branch: string;
  head: string;
  aheadBehind?: { ahead: number; behind: number };
  files: ChangedFile[];
  diff: { files: { path: string; hunks: { type: string; text: string }[] }[] };
  commits: { hash: string; subject: string; author?: string; at?: string }[];
  summary: string;
}

export interface CoverageFile {
  file: string;
  lines: number;
  covered: number;
  pct: number;
}

export interface CoverageReport {
  files: CoverageFile[];
  total: CoverageFile;
}

export function collectGitStatus(cwd = process.cwd()): GitViewData {
  const branch = git(["branch", "--show-current"], cwd) || "detached";
  const head = git(["rev-parse", "--short=12", "HEAD"], cwd) || "no-head";
  const statusLines = git(["status", "--porcelain"], cwd).split(/\r?\n/).filter(Boolean);
  const numstat = parseNumstat(git(["diff", "--numstat", "HEAD"], cwd));
  const files = statusLines.map((line) => {
    const file = line.slice(3).trim().replace(/^"|"$/g, "");
    const stats = numstat.get(file) ?? { added: 0, deleted: 0 };
    return riskFile({ path: file, status: line.slice(0, 2).trim() || "M", ...stats });
  });
  return {
    title: "Git Working Tree",
    branch,
    head,
    files,
    diff: collectDiff(cwd, "HEAD"),
    commits: parseLog(git(["log", "--oneline", "--decorate", "-10"], cwd)),
    summary: `${files.length} changed file(s) on ${branch}@${head}`
  };
}

export function collectGitCommit(ref = "HEAD", cwd = process.cwd()): GitViewData {
  const branch = git(["branch", "--show-current"], cwd) || "detached";
  const head = git(["rev-parse", "--short=12", ref], cwd) || ref;
  const numstat = parseNumstat(git(["show", "--numstat", "--format=", ref], cwd));
  const files = [...numstat.entries()].map(([file, stats]) => riskFile({ path: file, status: "M", ...stats }));
  return {
    title: `Git Commit ${head}`,
    branch,
    head,
    files,
    diff: collectDiff(cwd, `${ref}^`, ref),
    commits: parseLog(git(["show", "--no-patch", "--format=%h%x09%s%x09%an%x09%aI", ref], cwd)),
    summary: `${files.length} file(s) changed in ${head}`
  };
}

export function collectRemoteDiff(base = "@{upstream}", cwd = process.cwd()): GitViewData {
  const branch = git(["branch", "--show-current"], cwd) || "detached";
  const head = git(["rev-parse", "--short=12", "HEAD"], cwd) || "no-head";
  const ahead = Number(git(["rev-list", "--count", `${base}..HEAD`], cwd) || 0);
  const behind = Number(git(["rev-list", "--count", `HEAD..${base}`], cwd) || 0);
  const numstat = parseNumstat(git(["diff", "--numstat", `${base}...HEAD`], cwd));
  const files = [...numstat.entries()].map(([file, stats]) => riskFile({ path: file, status: "M", ...stats }));
  return {
    title: `Remote Diff vs ${base}`,
    branch,
    head,
    aheadBehind: { ahead, behind },
    files,
    diff: collectDiff(cwd, `${base}...HEAD`),
    commits: parseLog(git(["log", "--oneline", `${base}..HEAD`], cwd)),
    summary: `${ahead} ahead, ${behind} behind, ${files.length} changed file(s)`
  };
}

export function collectPr(base = "main", cwd = process.cwd()): GitViewData {
  const data = collectRemoteDiff(base, cwd);
  data.title = `PR Walkthrough vs ${base}`;
  data.summary = `${data.files.length} changed file(s), ${data.files.filter((file) => file.risk === "high").length} high-risk file(s)`;
  return data;
}

/**
 * Scrubbed data contract for native-artifact authoring. GitViewData is already an
 * aggregated, per-file/per-commit collection (no raw transcript text); the diff hunks
 * are already capped (400 lines/file, 100 files) by collectDiff, so this wrapper only
 * adds the schema tag rather than re-trimming.
 */
export interface GitData extends GitViewData {
  schema: "artilens.git.data/v1";
}

export function buildGitData(data: GitViewData): GitData {
  return { schema: "artilens.git.data/v1", ...data };
}

/** Write a collected GitViewData (status/commit/remote-diff/pr) to a JSON data file (no HTML). */
export async function writeGitData(data: GitViewData, dataPath: string, projectDir = process.cwd()): Promise<{ data: GitData; dataPath: string }> {
  const gitData = buildGitData(data);
  const resolvedPath = path.isAbsolute(dataPath) ? dataPath : path.join(projectDir, dataPath);
  await writeText(resolvedPath, JSON.stringify(gitData, null, 2));
  return { data: gitData, dataPath: resolvedPath };
}

export async function parseCoverage(filePath: string): Promise<CoverageReport> {
  const text = await readText(filePath);
  if (/^TN:/m.test(text) || /^SF:/m.test(text)) return parseLcov(text);
  if (filePath.endsWith(".xml")) return parseCobertura(text);
  return parseJsonCoverage(text);
}

/**
 * Scrubbed data contract for coverage. CoverageReport already carries only file
 * paths, line/covered counts, and percentages -- no source code lines -- so this
 * wrapper only adds the schema tag.
 */
export interface CoverageData extends CoverageReport {
  schema: "artilens.coverage.data/v1";
}

export function buildCoverageData(report: CoverageReport): CoverageData {
  return { schema: "artilens.coverage.data/v1", ...report };
}

/** Write a parsed CoverageReport to a JSON data file (no HTML, no source lines). */
export async function writeCoverageData(report: CoverageReport, dataPath: string, projectDir = process.cwd()): Promise<{ data: CoverageData; dataPath: string }> {
  const coverageData = buildCoverageData(report);
  const resolvedPath = path.isAbsolute(dataPath) ? dataPath : path.join(projectDir, dataPath);
  await writeText(resolvedPath, JSON.stringify(coverageData, null, 2));
  return { data: coverageData, dataPath: resolvedPath };
}

function collectDiff(cwd: string, base: string, ref?: string): GitViewData["diff"] {
  const args = ref ? ["diff", "--unified=40", `${base}..${ref}`] : ["diff", "--unified=40", base];
  const raw = git(args, cwd);
  const files: { path: string; hunks: { type: string; text: string }[] }[] = [];
  let current: { path: string; hunks: { type: string; text: string }[] } | undefined;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const match = / b\/(.+)$/.exec(line);
      current = { path: match?.[1] ?? "unknown", hunks: [] };
      files.push(current);
      continue;
    }
    if (!current || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) continue;
    if (current.hunks.length > 400) {
      if (current.hunks.at(-1)?.text !== "[diff folded after 400 lines]") current.hunks.push({ type: " ", text: "[diff folded after 400 lines]" });
      continue;
    }
    const type = line.startsWith("+") ? "+" : line.startsWith("-") ? "-" : " ";
    current.hunks.push({ type, text: line });
  }
  return { files: files.slice(0, 100) };
}

function parseNumstat(text: string): Map<string, { added: number; deleted: number }> {
  const map = new Map<string, { added: number; deleted: number }>();
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const [added, deleted, file] = line.split(/\t/);
    map.set(file, { added: Number(added) || 0, deleted: Number(deleted) || 0 });
  }
  return map;
}

function riskFile(file: Omit<ChangedFile, "risk" | "reasons">): ChangedFile {
  const reasons: string[] = [];
  const churn = file.added + file.deleted;
  if (churn > 400) reasons.push("large change");
  if (!/test|spec|fixture/i.test(file.path) && /\.(ts|tsx|js|jsx|py|go|rs)$/.test(file.path)) reasons.push("source without paired test signal");
  if (/package-lock|pnpm-lock|yarn.lock/i.test(file.path)) reasons.push("dependency lockfile");
  const risk: ChangedFile["risk"] = reasons.includes("large change") || reasons.includes("dependency lockfile") ? "high" : reasons.length ? "medium" : "low";
  return { ...file, risk, reasons: reasons.length ? reasons : ["small or non-code change"] };
}

function parseLog(text: string): GitViewData["commits"] {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [hash, subject, author, at] = line.includes("\t") ? line.split("\t") : [line.split(" ")[0], line.split(" ").slice(1).join(" ")];
      return { hash, subject, author, at };
    });
}

function parseLcov(text: string): CoverageReport {
  const files: CoverageFile[] = [];
  let current: Partial<CoverageFile> | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("SF:")) current = { file: line.slice(3), lines: 0, covered: 0, pct: 0 };
    if (line.startsWith("DA:") && current) {
      current.lines = (current.lines ?? 0) + 1;
      const count = Number(line.split(",")[1] ?? 0);
      if (count > 0) current.covered = (current.covered ?? 0) + 1;
    }
    if (line === "end_of_record" && current?.file) {
      current.pct = pct(current.covered ?? 0, current.lines ?? 0);
      files.push(current as CoverageFile);
      current = undefined;
    }
  }
  return withTotal(files);
}

function parseJsonCoverage(text: string): CoverageReport {
  const json = JSON.parse(text);
  const files: CoverageFile[] = [];
  for (const [file, value] of Object.entries<any>(json.coverageMap ?? json)) {
    const total = value.lines?.total ?? value.total?.lines?.total ?? value.lines ?? 0;
    const covered = value.lines?.covered ?? value.total?.lines?.covered ?? value.covered ?? 0;
    if (typeof total === "number") files.push({ file, lines: total, covered, pct: pct(covered, total) });
  }
  return withTotal(files);
}

function parseCobertura(text: string): CoverageReport {
  const files: CoverageFile[] = [];
  for (const match of text.matchAll(/<class[^>]+filename="([^"]+)"[\s\S]*?<\/class>/g)) {
    const block = match[0];
    const lines = [...block.matchAll(/<line\b[^>]*hits="(\d+)"/g)];
    const covered = lines.filter((line) => Number(line[1]) > 0).length;
    files.push({ file: match[1], lines: lines.length, covered, pct: pct(covered, lines.length) });
  }
  return withTotal(files);
}

function withTotal(files: CoverageFile[]): CoverageReport {
  const lines = files.reduce((sum, file) => sum + file.lines, 0);
  const covered = files.reduce((sum, file) => sum + file.covered, 0);
  return { files, total: { file: "TOTAL", lines, covered, pct: pct(covered, lines) } };
}

function pct(covered: number, lines: number): number {
  return lines === 0 ? 100 : (covered / lines) * 100;
}

function git(args: string[], cwd: string): string {
  try {
    return childProcess.execFileSync("git", ["-c", "core.quotepath=false", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 20 * 1024 * 1024
    }).trim();
  } catch {
    return "";
  }
}

