import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { createHtmlDocument, parseTitle, summarizeHtml } from "../html/document.js";
import { ensureDir, pathExists, readText, writeText } from "../util/fs.js";
import { escapeHtml, formatBytes, slugify, stableJson } from "../util/strings.js";

export interface GitContext {
  branch: string | null;
  head: string | null;
  dirty: boolean;
  base?: string | null;
}

export interface ArtifactVersion {
  v: number;
  at: string;
  session_id?: string | null;
  git: GitContext;
  note?: string;
  source_hash: string;
}

export interface ArtifactMeta {
  schema: 1;
  slug: string;
  title: string;
  url: string | null;
  scope: string;
  summary: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  versions: ArtifactVersion[];
}

export interface CaptureArtifactOptions {
  projectDir: string;
  sourcePath?: string;
  content?: string;
  title?: string;
  url?: string | null;
  scope?: string;
  summary?: string;
  tags?: string[];
  sessionId?: string | null;
  note?: string;
}

export function registryRoot(projectDir: string): string {
  return path.join(projectDir, ".claude", "artifacts");
}

export async function captureArtifact(options: CaptureArtifactOptions): Promise<ArtifactMeta> {
  const html = options.content ?? (options.sourcePath ? await readText(options.sourcePath) : "");
  if (!html) throw new Error("No artifact content supplied");
  const title = options.title || parseTitle(html);
  const baseSlug = slugify(title);
  const root = registryRoot(options.projectDir);
  await ensureDir(root);
  const slug = await resolveSlug(root, baseSlug, html);
  const dir = path.join(root, slug);
  await ensureDir(dir);
  const metaPath = path.join(dir, "meta.yaml");
  const existing = (await pathExists(metaPath)) ? parseMeta(await readText(metaPath)) : undefined;
  const hash = crypto.createHash("sha256").update(html).digest("hex");
  if (existing?.versions.some((version) => version.source_hash === hash)) {
    return existing;
  }
  const versionNumber = (existing?.versions.at(-1)?.v ?? 0) + 1;
  const now = new Date().toISOString();
  const meta: ArtifactMeta = existing ?? {
    schema: 1,
    slug,
    title,
    url: options.url ?? null,
    scope: options.scope ?? "custom",
    summary: options.summary || summarizeHtml(html),
    tags: options.tags ?? [],
    created_at: now,
    updated_at: now,
    versions: []
  };
  meta.title = title;
  meta.url = options.url ?? meta.url ?? null;
  meta.scope = options.scope ?? meta.scope;
  meta.summary = options.summary ?? meta.summary ?? summarizeHtml(html);
  meta.tags = options.tags ?? meta.tags ?? [];
  meta.updated_at = now;
  meta.versions.push({
    v: versionNumber,
    at: now,
    session_id: options.sessionId ?? null,
    git: getGitContext(options.projectDir),
    note: options.note,
    source_hash: hash
  });
  await writeText(path.join(dir, `v${String(versionNumber).padStart(3, "0")}.html`), html);
  await writeText(metaPath, YAML.stringify(meta));
  await regenerateRegistry(options.projectDir);
  return meta;
}

export async function listArtifacts(projectDir: string): Promise<ArtifactMeta[]> {
  const root = registryRoot(projectDir);
  if (!(await pathExists(root))) return [];
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  const metas: ArtifactMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(root, entry.name, "meta.yaml");
    if (await pathExists(metaPath)) metas.push(parseMeta(await readText(metaPath)));
  }
  return metas.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export async function regenerateRegistry(projectDir: string): Promise<void> {
  const root = registryRoot(projectDir);
  await ensureDir(root);
  const artifacts = await listArtifacts(projectDir);
  await writeText(path.join(root, "registry.json"), stableJson({ schema: 1, artifacts }));
  await writeText(path.join(root, "index.md"), renderIndex(artifacts));
}

export function renderIndex(artifacts: ArtifactMeta[]): string {
  const lines = [
    "# ArtiLens Artifact Index",
    "",
    "Generated file. Do not edit by hand.",
    ""
  ];
  for (const item of artifacts) {
    const latest = item.versions.at(-1);
    const git = latest?.git.head ? `${latest.git.branch ?? "detached"}@${latest.git.head.slice(0, 7)}` : "no-git";
    lines.push(`- [${item.slug}] ${item.scope} · v${latest?.v ?? 0} · ${item.updated_at} · ${git} — ${item.summary}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function diffArtifactVersions(projectDir: string, slug: string, a: number, b: number): Promise<string> {
  const root = registryRoot(projectDir);
  const leftPath = path.join(root, slug, `v${String(a).padStart(3, "0")}.html`);
  const rightPath = path.join(root, slug, `v${String(b).padStart(3, "0")}.html`);
  const left = await readText(leftPath);
  const right = await readText(rightPath);
  const rows = simpleLineDiff(left, right)
    .slice(0, 1200)
    .map((row) => `<tr><td>${row.kind}</td><td><code>${escapeHtml(row.text)}</code></td></tr>`)
    .join("");
  return createHtmlDocument({
    title: `Artifact diff: ${slug} v${a}..v${b}`,
    body: `<main><div class="al-header"><div><h1 class="al-title">Artifact diff</h1><p class="al-subtitle">${escapeHtml(slug)} v${a} to v${b}</p></div></div><table><tbody>${rows}</tbody></table></main>`
  });
}

export async function annotateArtifact(projectDir: string, slug: string, patch: { summary?: string; tags?: string[] }): Promise<ArtifactMeta> {
  const metaPath = path.join(registryRoot(projectDir), slug, "meta.yaml");
  const meta = parseMeta(await readText(metaPath));
  if (patch.summary) meta.summary = patch.summary;
  if (patch.tags) meta.tags = patch.tags;
  meta.updated_at = new Date().toISOString();
  await writeText(metaPath, YAML.stringify(meta));
  await regenerateRegistry(projectDir);
  return meta;
}

export async function pruneArtifacts(projectDir: string, keepLast: number): Promise<{ removed: number; bytes: number }> {
  const artifacts = await listArtifacts(projectDir);
  let removed = 0;
  let bytes = 0;
  const keep = Math.max(0, Math.floor(keepLast));
  for (const item of artifacts) {
    const dir = path.join(registryRoot(projectDir), item.slug);
    // slice(-0) === slice(0) would keep everything, so compute the stale count
    // explicitly to keep meta.versions consistent with the files left on disk.
    const staleCount = Math.max(0, item.versions.length - keep);
    const stale = item.versions.slice(0, staleCount);
    for (const version of stale) {
      const file = path.join(dir, `v${String(version.v).padStart(3, "0")}.html`);
      if (await pathExists(file)) {
        const stat = await fs.promises.stat(file);
        bytes += stat.size;
        await fs.promises.unlink(file);
        removed += 1;
      }
    }
    item.versions = item.versions.slice(staleCount);
    await writeText(path.join(dir, "meta.yaml"), YAML.stringify(item));
  }
  await regenerateRegistry(projectDir);
  return { removed, bytes };
}

export function getGitContext(cwd: string): GitContext {
  return {
    branch: git(["branch", "--show-current"], cwd) || null,
    head: git(["rev-parse", "--short=12", "HEAD"], cwd) || null,
    dirty: Boolean(git(["status", "--porcelain"], cwd)),
    base: git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], cwd) || null
  };
}

export function parseMeta(text: string): ArtifactMeta {
  return YAML.parse(text) as ArtifactMeta;
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

async function resolveSlug(root: string, baseSlug: string, html: string): Promise<string> {
  for (let index = 0; index < 100; index += 1) {
    const slug = index === 0 ? baseSlug : `${baseSlug}-${index + 1}`;
    const metaPath = path.join(root, slug, "meta.yaml");
    if (!(await pathExists(metaPath))) return slug;
    const meta = parseMeta(await readText(metaPath));
    if (meta.title === parseTitle(html)) return slug;
  }
  return `${baseSlug}-${Date.now()}`;
}

function simpleLineDiff(a: string, b: string): { kind: string; text: string }[] {
  const left = a.split(/\r?\n/);
  const right = b.split(/\r?\n/);
  const max = Math.max(left.length, right.length);
  const rows: { kind: string; text: string }[] = [];
  for (let index = 0; index < max; index += 1) {
    if (left[index] === right[index]) rows.push({ kind: " ", text: left[index] ?? "" });
    else {
      if (left[index] !== undefined) rows.push({ kind: "-", text: left[index] });
      if (right[index] !== undefined) rows.push({ kind: "+", text: right[index] });
    }
  }
  return rows;
}

export function formatPruneSummary(result: { removed: number; bytes: number }): string {
  return `Removed ${result.removed} version(s), reclaimed ${formatBytes(result.bytes)}.`;
}

