import { describe, expect, test } from "bun:test";
import {
  classifyCommand,
  classifyLine,
  extractBashCommand,
  shouldShowInCompactMode,
} from "../src/parser";
import { formatLogLine } from "../src/render";

describe("Sandcastle log highlighting", () => {
  test("extracts and de-escapes Bash tool commands", () => {
    expect(extractBashCommand("Bash(/bin/bash -lc 'bun run test')")).toBe(
      "bun run test",
    );
    expect(
      extractBashCommand(
        'Bash(/bin/bash -lc "git branch --all --list \'*sandcastle/issue-1*\'")',
      ),
    ).toBe("git branch --all --list '*sandcastle/issue-1*'");
  });

  test("classifies command families and prominent mutations", () => {
    expect(classifyCommand("git status --short --branch").family).toBe("git");
    expect(classifyCommand("gh issue view 1 --comments").family).toBe("gh");
    expect(classifyCommand("bun run typecheck").family).toBe("bun");
    expect(classifyCommand("sed -n '1,20p' package.json").family).toBe("read");
    expect(
      classifyCommand("curl -fsSL https://bun.sh/install | bash").family,
    ).toBe("network");
    expect(
      classifyCommand("git merge sandcastle/issue-1 --no-edit").prominent,
    ).toBe(true);
    expect(classifyCommand('gh issue close 1 --comment "done"').prominent).toBe(
      true,
    );
    expect(classifyCommand("rm -rf /tmp/sandcastle-test").prominent).toBe(true);
    expect(classifyCommand("bun add -g @openai/codex").prominent).toBe(true);
  });

  test("classifies status keyword lines", () => {
    expect(classifyLine("fatal: bun: command not found").severity).toBe("error");
    expect(classifyLine("Agent idle for 1 minute").severity).toBe("idle");
    expect(classifyLine("Run complete: agent finished").severity).toBe(
      "success",
    );
    expect(classifyLine("Syncing 1 commit to host").severity).toBe("success");
    expect(classifyLine("Branches merged.").severity).toBe("success");
  });

  test("uses stable role colors from source names", () => {
    expect(classifyLine("hello", "main-planner.log").role).toBe("planner");
    expect(classifyLine("hello", "sandcastle-issue-1-implementer.log").role).toBe(
      "implementer",
    );
    expect(classifyLine("hello", "sandcastle-issue-1-reviewer.log").role).toBe(
      "reviewer",
    );
    expect(classifyLine("hello", "main-merger.log").role).toBe("merger");
  });

  test("filters compact mode to agent messages, tool calls, plans, and errors", () => {
    expect(shouldShowInCompactMode("Setting up sandbox")).toBe(false);
    expect(shouldShowInCompactMode("Bash(/bin/bash -lc 'git status')")).toBe(
      true,
    );
    expect(shouldShowInCompactMode('<plan>{"issues":[]}</plan>')).toBe(true);
    expect(shouldShowInCompactMode("fatal: permission denied")).toBe(true);
    expect(shouldShowInCompactMode("I will inspect the issue now.")).toBe(true);
  });

  test("formats deterministic no-color output with readable commands", () => {
    expect(
      formatLogLine({
        line: "Bash(/bin/bash -lc 'git commit -m \"Merge Sandcastle issue branches\"')",
        source: "main-merger.log",
        color: false,
        now: () => "12:34:56",
      }),
    ).toBe(
      '12:34:56 main-merger.log                    Bash: git commit -m "Merge Sandcastle issue branches"',
    );
  });
});
