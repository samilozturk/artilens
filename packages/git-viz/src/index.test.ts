import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectGitStatus, parseCoverage, writeCoverageData, writeGitData } from "./index.js";

function git(args: string[], cwd: string): void {
  childProcess.execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function initRepo(): Promise<string> {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "artilens-git-data-"));
  git(["init", "-q"], tmp);
  git(["config", "user.email", "test@example.com"], tmp);
  git(["config", "user.name", "Test"], tmp);
  return tmp;
}

describe("writeGitData", () => {
  it("writes a valid JSON data file with the expected schema and top-level shape", async () => {
    const tmp = await initRepo();
    await fs.promises.writeFile(path.join(tmp, "a.ts"), "export const a = 1;\n", "utf8");
    git(["add", "."], tmp);
    git(["commit", "-q", "-m", "init"], tmp);
    await fs.promises.writeFile(path.join(tmp, "a.ts"), "export const a = 2;\n", "utf8");
    const collected = collectGitStatus(tmp);
    const relative = path.join(".claude", "artilens", "git-status.data.json");
    const { data, dataPath } = await writeGitData(collected, relative, tmp);
    expect(dataPath).toBe(path.join(tmp, relative));
    expect(data.schema).toBe("artilens.git.data/v1");
    const parsed = JSON.parse(await fs.promises.readFile(dataPath, "utf8"));
    expect(parsed.schema).toBe("artilens.git.data/v1");
    expect(Array.isArray(parsed.files)).toBe(true);
    expect(typeof parsed.summary).toBe("string");
  });

  it("honors an absolute dataPath unchanged", async () => {
    const tmp = await initRepo();
    const collected = collectGitStatus(tmp);
    const absolute = path.join(tmp, "out", "git-status.data.json");
    const { dataPath } = await writeGitData(collected, absolute, tmp);
    expect(dataPath).toBe(absolute);
    expect(fs.existsSync(absolute)).toBe(true);
  });

  it("does not leak diff content past the per-command file cap (raw diff dump guard)", async () => {
    const tmp = await initRepo();
    // Create 101 tracked files so the 101st (alphabetically last) falls outside
    // collectDiff's 100-file cap once modified -- its hunk text must not leak.
    const names = Array.from({ length: 101 }, (_, i) => `file${String(i + 1).padStart(3, "0")}.ts`);
    for (const name of names) {
      await fs.promises.writeFile(path.join(tmp, name), "export const value = 1;\n", "utf8");
    }
    git(["add", "."], tmp);
    git(["commit", "-q", "-m", "init"], tmp);
    for (const name of names) {
      const marker = name === "file101.ts" ? "FAKE_SECRET_MARKER_xyz123" : "value";
      await fs.promises.writeFile(path.join(tmp, name), `export const value = "${marker}";\n`, "utf8");
    }
    const collected = collectGitStatus(tmp);
    const { dataPath } = await writeGitData(collected, path.join(tmp, "git-status.data.json"), tmp);
    const raw = await fs.promises.readFile(dataPath, "utf8");
    expect(raw).not.toContain("FAKE_SECRET_MARKER_xyz123");
  });
});

describe("writeCoverageData", () => {
  it("writes a valid JSON coverage data file with no source lines", async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "artilens-coverage-data-"));
    const lcov = path.join(tmp, "lcov.info");
    await fs.promises.writeFile(lcov, "TN:\nSF:src/a.ts\nDA:1,1\nDA:2,0\nend_of_record\n", "utf8");
    const report = await parseCoverage(lcov);
    const { data, dataPath } = await writeCoverageData(report, "coverage.data.json", tmp);
    expect(dataPath).toBe(path.join(tmp, "coverage.data.json"));
    expect(data.schema).toBe("artilens.coverage.data/v1");
    const parsed = JSON.parse(await fs.promises.readFile(dataPath, "utf8"));
    expect(parsed.files[0].file).toBe("src/a.ts");
    expect(parsed.total.lines).toBe(2);
    expect(JSON.stringify(parsed)).not.toContain("DA:");
  });
});

describe("coverage adapters", () => {
  it("parses lcov into a coverage report", async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "artilens-coverage-"));
    const lcov = path.join(tmp, "lcov.info");
    await fs.promises.writeFile(lcov, "TN:\nSF:src/a.ts\nDA:1,1\nDA:2,0\nend_of_record\n", "utf8");
    const report = await parseCoverage(lcov);
    expect(report.total.lines).toBe(2);
    expect(report.total.covered).toBe(1);
  });

  it("parses cobertura-style XML", async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "artilens-cobertura-"));
    const xml = path.join(tmp, "coverage.xml");
    await fs.promises.writeFile(xml, '<coverage><class filename="src/a.py"><lines><line number="1" hits="1"/><line number="2" hits="0"/></lines></class></coverage>', "utf8");
    const report = await parseCoverage(xml);
    expect(report.files[0].pct).toBe(50);
  });
});

