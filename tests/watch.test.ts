import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLogDir } from "../src/watch";

const made: string[] = [];

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "sandglass-"));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolveLogDir", () => {
  test("1. honors SANDCASTLE_LOG_DIR (absolute) above all else", () => {
    const cwd = tmp();
    const override = tmp();
    expect(resolveLogDir({ SANDCASTLE_LOG_DIR: override }, cwd)).toBe(override);
  });

  test("1b. resolves a relative SANDCASTLE_LOG_DIR against cwd", () => {
    const cwd = tmp();
    expect(resolveLogDir({ SANDCASTLE_LOG_DIR: "custom/logs" }, cwd)).toBe(
      join(cwd, "custom/logs"),
    );
  });

  test("2. prefers .sandcastle/logs/latest when it exists", () => {
    const cwd = tmp();
    const latest = join(cwd, ".sandcastle/logs/latest");
    mkdirSync(latest, { recursive: true });
    expect(resolveLogDir({}, cwd)).toBe(latest);
  });

  test("3. reads .sandcastle/logs/latest-run.txt when latest is absent", () => {
    const cwd = tmp();
    const logs = join(cwd, ".sandcastle/logs");
    mkdirSync(logs, { recursive: true });
    const runDir = join(cwd, ".sandcastle/logs/runs/run-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(logs, "latest-run.txt"), runDir + "\n");
    expect(resolveLogDir({}, cwd)).toBe(runDir);
  });

  test("4. falls back to .sandcastle/logs", () => {
    const cwd = tmp();
    expect(resolveLogDir({}, cwd)).toBe(join(cwd, ".sandcastle/logs"));
  });
});
