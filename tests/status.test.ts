import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  issueIdFromSource,
  parseDuration,
  readRunStatus,
} from "../src/status";

const made: string[] = [];

function tmpRun(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "sandglass-status-"));
  made.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

function setMtime(dir: string, name: string, when: Date) {
  utimesSync(join(dir, name), when, when);
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-06-13T21:00:00.000Z");
const now = () => NOW;
const recent = new Date(NOW.getTime() - 10_000); // 10s ago — within stale window
const stale = new Date(NOW.getTime() - 10 * 60_000); // 10m ago — past stale window

const PLANNER_PLAN = [
  "--- Run started: 2026-06-13T20:51:32.288Z ---",
  "Sandcastle Run",
  "  Agent: planner",
  "Agent started",
  "<plan>",
  '{"issues":[{"id":"6","title":"Implement card: Poke","branch":"sandcastle/issue-6"},{"id":"11","title":"Implement card: Thundersurge","branch":"sandcastle/issue-11"}]}',
  "</plan>",
  "Agent stopped",
  "Run complete: reached 1 iteration(s) without completion signal.",
  "",
].join("\n");

const IMPL_ACTIVE = [
  "--- Run started: 2026-06-13T20:51:58.840Z ---",
  "Iteration 1/100",
  "Agent started",
  "Bash(/bin/bash -lc 'git status --short --branch')",
  "I'll implement the card now and add a golden test.",
  "",
].join("\n");

const IMPL_COMPLETE_NOCOMMITS = [
  "--- Run started: 2026-06-13T20:51:58.840Z ---",
  "Iteration 1/100",
  "Agent started",
  "Bash(/bin/bash -lc 'bun run test')",
  "Implemented and committed on sandcastle/issue-11.",
  "<promise>COMPLETE</promise>",
  "Agent stopped",
  "No commits to sync out",
  "No commits to sync out done (0.0s)",
  "Collecting commits",
  "Agent signaled completion after 1 iteration(s).",
  "Run complete: agent finished after 1 iteration(s).",
  "Context window: 514k",
  "",
].join("\n");

const REVIEWER_IDLE = [
  "--- Run started: 2026-06-13T20:55:00.000Z ---",
  "Iteration 1/100",
  "Agent started",
  "I'm reviewing the diff now.",
  "Bash(/bin/bash -lc 'bun test')",
  "",
].join("\n");

const MERGER_CONFLICT = [
  "--- Run started: 2026-06-13T21:00:00.000Z ---",
  "Agent started",
  "I'll merge the branches in order, validating after each merge.",
  "Bash(/bin/bash -lc 'git merge sandcastle/issue-13 --no-edit')",
  "issue-13 conflicts in packages/engine/src/index.ts; resolving now.",
  "",
].join("\n");

const MERGER_CLOSED = [
  "--- Run started: 2026-06-13T21:00:00.000Z ---",
  "Agent started",
  "Bash(/bin/bash -lc 'git merge sandcastle/issue-6 --no-edit')",
  "issue-6 fast-forwarded cleanly with no conflicts.",
  'Bash(/bin/bash -lc \'gh issue close 6 --comment "Completed by Sandcastle"\')',
  "Issue 6 is closed.",
  "<promise>COMPLETE</promise>",
  "Agent stopped",
  "Agent signaled completion after 1 iteration(s).",
  "Run complete: agent finished after 1 iteration(s).",
  "",
].join("\n");

describe("readRunStatus — plan parsing", () => {
  test("extracts planned issues (id/title/branch) from the planner <plan>", async () => {
    const dir = tmpRun({ "main-planner.log": PLANNER_PLAN });
    setMtime(dir, "main-planner.log", recent);

    const status = await readRunStatus({ dir, now });

    expect(status.issues.map((i) => i.id)).toEqual(["6", "11"]);
    const poke = status.issues.find((i) => i.id === "6");
    expect(poke?.title).toBe("Implement card: Poke");
    expect(poke?.branch).toBe("sandcastle/issue-6");
  });

  test("a planned issue with no implementer log is pending", async () => {
    const dir = tmpRun({ "main-planner.log": PLANNER_PLAN });
    setMtime(dir, "main-planner.log", recent);

    const status = await readRunStatus({ dir, now });

    expect(status.issues.find((i) => i.id === "11")?.result).toBe("pending");
    expect(status.issues.find((i) => i.id === "11")?.implementer).toBeUndefined();
  });
});

describe("readRunStatus — agent liveness", () => {
  test("a recently-updated implementer with no completion is active → phase implementing", async () => {
    const dir = tmpRun({
      "main-planner.log": PLANNER_PLAN,
      "sandcastle-issue-6-implementer.log": IMPL_ACTIVE,
    });
    setMtime(dir, "main-planner.log", recent);
    setMtime(dir, "sandcastle-issue-6-implementer.log", recent);

    const status = await readRunStatus({ dir, now });

    const poke = status.issues.find((i) => i.id === "6")!;
    expect(poke.implementer?.status).toBe("active");
    expect(poke.result).toBe("active");
    expect(status.phase).toBe("implementing");
  });

  test("a completed implementer with no commits is complete → result no-commits", async () => {
    const dir = tmpRun({
      "main-planner.log": PLANNER_PLAN,
      "sandcastle-issue-11-implementer.log": IMPL_COMPLETE_NOCOMMITS,
    });
    setMtime(dir, "main-planner.log", recent);
    setMtime(dir, "sandcastle-issue-11-implementer.log", recent);

    const status = await readRunStatus({ dir, now });

    const thunder = status.issues.find((i) => i.id === "11")!;
    expect(thunder.implementer?.status).toBe("complete");
    expect(thunder.implementer?.promise).toBe("COMPLETE");
    expect(thunder.result).toBe("no-commits");
  });

  test("a stale reviewer with no completion is idle", async () => {
    const dir = tmpRun({
      "main-planner.log": PLANNER_PLAN,
      "sandcastle-issue-11-implementer.log": IMPL_COMPLETE_NOCOMMITS,
      "sandcastle-issue-11-reviewer.log": REVIEWER_IDLE,
    });
    setMtime(dir, "main-planner.log", stale);
    setMtime(dir, "sandcastle-issue-11-implementer.log", stale);
    setMtime(dir, "sandcastle-issue-11-reviewer.log", stale);

    const status = await readRunStatus({ dir, now });

    expect(
      status.issues.find((i) => i.id === "11")?.reviewer?.status,
    ).toBe("idle");
    expect(status.phase).toBe("idle");
  });
});

describe("readRunStatus — merger attribution", () => {
  test("an active merger mid-conflict → phase merging, unsafe to interrupt", async () => {
    const dir = tmpRun({
      "main-planner.log": PLANNER_PLAN,
      "main-merger.log": MERGER_CONFLICT,
    });
    setMtime(dir, "main-planner.log", stale);
    setMtime(dir, "main-merger.log", recent);

    const status = await readRunStatus({ dir, now });

    expect(status.phase).toBe("merging");
    expect(status.safeToInterrupt.safe).toBe(false);
    expect(status.safeToInterrupt.reason).toContain("issue-13");
  });

  test("a merger that closed an issue marks that issue complete", async () => {
    const dir = tmpRun({
      "main-planner.log": PLANNER_PLAN,
      "main-merger.log": MERGER_CLOSED,
    });
    setMtime(dir, "main-planner.log", stale);
    setMtime(dir, "main-merger.log", recent);

    const status = await readRunStatus({ dir, now });

    const poke = status.issues.find((i) => i.id === "6")!;
    expect(poke.merge?.status).toBe("complete");
    expect(poke.result).toBe("complete");
  });

  // Real repos differ: MCG prefixes (main-merger.log, sandcastle-issue-N-...),
  // Starcube does not (merger.log, planner.log, issue-N-...). Role + issue id come
  // from substrings, so both layouts must resolve identically.
  test("handles unprefixed Starcube-style filenames", async () => {
    const dir = tmpRun({
      "planner.log": PLANNER_PLAN,
      "issue-6-implementer.log": IMPL_COMPLETE_NOCOMMITS,
      "merger.log": MERGER_CLOSED,
    });
    setMtime(dir, "planner.log", stale);
    setMtime(dir, "issue-6-implementer.log", stale);
    setMtime(dir, "merger.log", recent);

    const status = await readRunStatus({ dir, now });

    const poke = status.issues.find((i) => i.id === "6")!;
    expect(poke.implementer?.status).toBe("complete");
    expect(poke.merge?.status).toBe("complete");
    expect(poke.result).toBe("complete");
  });
});

describe("readRunStatus — robustness", () => {
  test("a malformed log is classified unknown and recorded as a warning, without throwing", async () => {
    const dir = tmpRun({
      "main-planner.log": PLANNER_PLAN,
      "sandcastle-issue-99-implementer.log": "  garbage ??? not a real log\nrandom",
    });
    setMtime(dir, "main-planner.log", recent);
    setMtime(dir, "sandcastle-issue-99-implementer.log", recent);

    const status = await readRunStatus({ dir, now });

    const log = status.logs.find((l) => l.issueId === "99");
    expect(log?.status).toBe("unknown");
    expect(status.warnings.some((w) => w.includes("issue-99"))).toBe(true);
  });

  test("a missing log directory yields a warning and an empty run, no throw", async () => {
    const status = await readRunStatus({
      dir: join(tmpdir(), "sandglass-does-not-exist-xyz"),
      now,
    });

    expect(status.issues).toEqual([]);
    expect(status.warnings.length).toBeGreaterThan(0);
    expect(status.phase).toBe("unknown");
  });
});

describe("status helpers", () => {
  test("issueIdFromSource pulls the issue number from a per-issue filename", () => {
    expect(issueIdFromSource("sandcastle-issue-14-implementer.log")).toBe("14");
    expect(issueIdFromSource("main-planner.log")).toBeUndefined();
  });

  test("parseDuration understands s / m / ms / bare-seconds", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("2m")).toBe(120_000);
    expect(parseDuration("1500ms")).toBe(1_500);
    expect(parseDuration("120")).toBe(120_000);
    expect(parseDuration("nonsense")).toBeUndefined();
  });
});
