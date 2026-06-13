import { describe, expect, test } from "bun:test";
import { createParser } from "../src/parser";
import { renderRecord } from "../src/render";

const NOW = () => "12:00:00";

function pre(source: string) {
  return `12:00:00 ${source.padEnd(34)} `;
}

function renderLine(line: string, source = "sandcastle") {
  const parser = createParser();
  const records = [...parser.push(line), ...parser.flush()];
  return records.flatMap((r) =>
    renderRecord(r, { source, color: false, now: NOW }),
  );
}

describe("renderRecord (no-color, deterministic)", () => {
  test("renders a tool call with Bash rewrite", () => {
    const out = renderLine(
      "Bash(/bin/bash -lc 'git status')",
      "main-merger.log",
    );
    expect(out).toEqual([`${pre("main-merger.log")}Bash: git status`]);
  });

  test("renders a lifecycle line as a single element", () => {
    const out = renderLine("Iteration 1/1", "main-planner.log");
    expect(out).toEqual([`${pre("main-planner.log")}Iteration 1/1`]);
  });

  test("renders a raw severity line", () => {
    const out = renderLine("fatal: permission denied", "main-planner.log");
    expect(out).toEqual([
      `${pre("main-planner.log")}fatal: permission denied`,
    ]);
  });

  test("pretty-prints a parsed <plan> block, keeping raw JSON", () => {
    const parser = createParser();
    const records = [
      ...parser.push("<plan>"),
      ...parser.push(
        '{"issues":[{"id":"32","title":"Add cards:check","branch":"sandcastle/issue-32"}]}',
      ),
      ...parser.push("</plan>"),
    ];
    expect(records).toHaveLength(1);
    const out = renderRecord(records[0]!, {
      source: "main-planner.log",
      color: false,
      now: NOW,
    });
    const p = pre("main-planner.log");
    expect(out).toEqual([
      `${p}<plan>`,
      `${p}  #32 Add cards:check  (sandcastle/issue-32)`,
      `${p}  raw: {"issues":[{"id":"32","title":"Add cards:check","branch":"sandcastle/issue-32"}]}`,
      `${p}</plan>`,
    ]);
  });

  test("renders a non-JSON <promise> block with raw fallback", () => {
    const out = renderLine("<promise>COMPLETE</promise>", "main-planner.log");
    const p = pre("main-planner.log");
    expect(out).toEqual([
      `${p}<promise>`,
      `${p}  COMPLETE`,
      `${p}</promise>`,
    ]);
  });

  test("color output wraps in escape codes; no-color does not", () => {
    const parser = createParser();
    const [record] = parser.push("Iteration 1/1");
    const colored = renderRecord(record!, {
      source: "x",
      color: true,
      now: NOW,
    });
    expect(colored[0]).toContain("\x1b[");
    const plain = renderRecord(record!, {
      source: "x",
      color: false,
      now: NOW,
    });
    expect(plain[0]).not.toContain("\x1b[");
  });
});
