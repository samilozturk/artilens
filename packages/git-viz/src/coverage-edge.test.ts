import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCoverage } from "./index.js";

async function write(name: string, content: string): Promise<string> {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "artilens-cov-"));
  const file = path.join(tmp, name);
  await fs.promises.writeFile(file, content, "utf8");
  return file;
}

describe("coverage adapters edge cases", () => {
  it("parses istanbul/vitest json summary shape", async () => {
    const file = await write("coverage.json", JSON.stringify({ "src/a.ts": { lines: { total: 10, covered: 8 } }, "src/b.ts": { lines: { total: 4, covered: 1 } } }));
    const report = await parseCoverage(file);
    expect(report.files).toHaveLength(2);
    expect(report.total.lines).toBe(14);
    expect(report.total.covered).toBe(9);
  });

  it("computes a total percentage across files", async () => {
    const file = await write("lcov.info", "SF:src/a.ts\nDA:1,1\nDA:2,1\nDA:3,0\nDA:4,0\nend_of_record\n");
    const report = await parseCoverage(file);
    expect(report.total.pct).toBeCloseTo(50, 5);
  });

  it("treats a file with zero lines as 100% (no division by zero)", async () => {
    const file = await write("lcov.info", "SF:src/empty.ts\nend_of_record\n");
    const report = await parseCoverage(file);
    expect(report.files[0].pct).toBe(100);
    expect(Number.isFinite(report.total.pct)).toBe(true);
  });

  it("handles multiple records and orders totals correctly", async () => {
    const file = await write(
      "lcov.info",
      "SF:src/a.ts\nDA:1,1\nend_of_record\nSF:src/b.ts\nDA:1,0\nDA:2,0\nend_of_record\n"
    );
    const report = await parseCoverage(file);
    expect(report.files).toHaveLength(2);
    expect(report.total.lines).toBe(3);
    expect(report.total.covered).toBe(1);
  });
});
