import { describe, expect, test } from "bun:test";
import { renderStatusTable, toJsonStatus } from "../src/status-render";
import type { SandcastleRunStatus } from "../src/status";

const BASE: SandcastleRunStatus = {
  runDir: "/home/andrew/work/mcg/.sandcastle/logs/runs/2026-06-13T18-28-44-342Z",
  generatedAt: "2026-06-13T21:00:00.000Z",
  phase: "implementing",
  safeToInterrupt: { safe: true, reason: "no merge in progress" },
  issues: [
    {
      id: "6",
      title: "Implement card: Poke",
      branch: "sandcastle/issue-6",
      implementer: { source: "sandcastle-issue-6-implementer.log", role: "implementer", status: "active" },
      result: "active",
    },
    {
      id: "11",
      title: "Implement card: Thundersurge",
      branch: "sandcastle/issue-11",
      implementer: { source: "sandcastle-issue-11-implementer.log", role: "implementer", status: "complete" },
      reviewer: { source: "sandcastle-issue-11-reviewer.log", role: "reviewer", status: "active" },
      result: "active",
    },
  ],
  logs: [],
  warnings: [],
};

describe("toJsonStatus", () => {
  test("round-trips the status model and contains no ANSI escapes", () => {
    const json = toJsonStatus(BASE);
    expect(json).not.toContain("\x1b");
    expect(JSON.parse(json)).toEqual(BASE);
  });

  test("omits undefined optional fields", () => {
    const json = toJsonStatus(BASE);
    expect(json).not.toContain("latestRunCompletedAt");
  });
});

describe("renderStatusTable", () => {
  test("renders header, phase, a row per issue, and the interrupt footer", () => {
    const out = renderStatusTable(BASE, { color: false });
    expect(out).toContain("Sandcastle run:");
    expect(out).toContain(BASE.runDir);
    expect(out).toContain("Phase: implementing");
    expect(out).toContain("#6");
    expect(out).toContain("Implement card: Poke");
    expect(out).toContain("sandcastle/issue-11");
    expect(out).toContain("Safe to interrupt: YES");
  });

  test("uses pending for stages with no log, and the issue's stage statuses", () => {
    const out = renderStatusTable(BASE, { color: false });
    const poke = out.split("\n").find((l) => l.includes("#6"))!;
    // impl active, review + merge not started yet -> pending
    expect(poke).toContain("active");
    expect(poke).toContain("pending");
  });

  test("surfaces an unsafe verdict with its reason", () => {
    const unsafe: SandcastleRunStatus = {
      ...BASE,
      phase: "merging",
      safeToInterrupt: {
        safe: false,
        reason: "merger is resolving a conflict on sandcastle/issue-13",
      },
    };
    const out = renderStatusTable(unsafe, { color: false });
    expect(out).toContain("Safe to interrupt: NO");
    expect(out).toContain("issue-13");
  });

  test("contains no ANSI escapes when color is disabled", () => {
    expect(renderStatusTable(BASE, { color: false })).not.toContain("\x1b");
  });

  test("lists warnings when present", () => {
    const warned: SandcastleRunStatus = {
      ...BASE,
      warnings: ["Could not classify log: weird.log"],
    };
    const out = renderStatusTable(warned, { color: false });
    expect(out).toContain("weird.log");
  });
});
