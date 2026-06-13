import { describe, expect, test } from "bun:test";
import {
  LogParser,
  createParser,
  type LifecycleSection,
  type LogRecord,
  type StructuredBlockRecord,
} from "../src/parser";

function pushAll(parser: LogParser, lines: string[]): LogRecord[] {
  const out: LogRecord[] = [];
  for (const line of lines) out.push(...parser.push(line));
  out.push(...parser.flush());
  return out;
}

describe("LogParser lifecycle classification", () => {
  test("classifies Sandcastle lifecycle lines", () => {
    const parser = createParser();
    const cases: Array<[string, LifecycleSection]> = [
      ["--- Run started: 2026-06-13T18:44:07.654Z ---", "run-started"],
      ["Sandcastle Run", "run-summary"],
      ["  Agent: planner", "run-summary"],
      ["  Sandbox: docker", "run-summary"],
      ["Iteration 1/1", "iteration"],
      ["Setting up sandbox", "setup"],
      ["Expanding shell expressions", "expansion"],
      ["Agent started", "agent-started"],
      ["Agent stopped", "agent-stopped"],
      ["Capturing session", "capturing"],
      ["Collecting commits", "collecting"],
      ["Run complete: reached 1 iteration(s)", "run-complete"],
      ["Reached max iterations (1).", "run-complete"],
      ["Context window: 22k", "context"],
    ];
    for (const [line, section] of cases) {
      const [record] = parser.push(line);
      expect(record?.kind).toBe("lifecycle");
      expect(record?.kind === "lifecycle" && record.section).toBe(section);
    }
  });
});

describe("LogParser tool calls", () => {
  test("emits a tool-call record for Bash with parsed command", () => {
    const parser = createParser();
    const [record] = parser.push("Bash(/bin/bash -lc 'git status --short')");
    expect(record?.kind).toBe("tool-call");
    if (record?.kind === "tool-call") {
      expect(record.tool).toBe("Bash");
      expect(record.command).toBe("git status --short");
      expect(record.commandInfo?.family).toBe("git");
    }
  });

  test("emits a tool-call record for non-Bash tools", () => {
    const parser = createParser();
    const [record] = parser.push("Read(/etc/hosts)");
    expect(record?.kind).toBe("tool-call");
    expect(record?.kind === "tool-call" && record.tool).toBe("Read");
  });

  test("unknown lines fall back to raw", () => {
    const parser = createParser();
    const [record] = parser.push("some unstructured prose here");
    expect(record?.kind).toBe("raw");
  });
});

describe("LogParser structured blocks", () => {
  test("accumulates a multi-line <plan> block into one record", () => {
    const parser = createParser();
    const records = pushAll(parser, [
      "<plan>",
      '{"issues":[{"id":"32","title":"Add cards:check","branch":"sandcastle/issue-32"},{"id":"34","title":"Room Server","branch":"sandcastle/issue-34"}]}',
      "</plan>",
    ]);
    expect(records).toHaveLength(1);
    const block = records[0] as StructuredBlockRecord;
    expect(block.kind).toBe("structured-block");
    expect(block.tag).toBe("plan");
    expect(block.raw).toHaveLength(3);
    expect(block.parsed?.issues).toHaveLength(2);
    expect(block.parsed?.issues[0]).toEqual({
      id: "32",
      title: "Add cards:check",
      branch: "sandcastle/issue-32",
    });
  });

  test("does not emit a record until the block closes", () => {
    const parser = createParser();
    expect(parser.push("<plan>")).toHaveLength(0);
    expect(parser.push('{"issues":[]}')).toHaveLength(0);
    const closing = parser.push("</plan>");
    expect(closing).toHaveLength(1);
    expect(closing[0]?.kind).toBe("structured-block");
  });

  test("handles inline single-line <plan>", () => {
    const parser = createParser();
    const records = parser.push('<plan>{"issues":[]}</plan>');
    expect(records).toHaveLength(1);
    const block = records[0] as StructuredBlockRecord;
    expect(block.tag).toBe("plan");
    expect(block.parsed?.issues).toHaveLength(0);
  });

  test("parses a <promise>COMPLETE</promise> as a structured block", () => {
    const parser = createParser();
    const records = parser.push("<promise>COMPLETE</promise>");
    expect(records).toHaveLength(1);
    const block = records[0] as StructuredBlockRecord;
    expect(block.tag).toBe("promise");
    // COMPLETE is not JSON: json stays undefined, raw retained.
    expect(block.json).toBeUndefined();
    expect(block.raw).toEqual(["<promise>COMPLETE</promise>"]);
  });

  test("retains raw when block JSON is malformed", () => {
    const parser = createParser();
    const records = pushAll(parser, [
      "<plan>",
      '{"issues":[{"id":"1" oops not json',
      "</plan>",
    ]);
    expect(records).toHaveLength(1);
    const block = records[0] as StructuredBlockRecord;
    expect(block.json).toBeUndefined();
    expect(block.parsed).toBeUndefined();
    expect(block.raw).toHaveLength(3);
  });

  test("flush surfaces an unterminated block as raw lines", () => {
    const parser = createParser();
    expect(parser.push("<plan>")).toHaveLength(0);
    parser.push('{"issues":[]}');
    const flushed = parser.flush();
    expect(flushed).toHaveLength(2);
    expect(flushed.every((r) => r.kind === "raw")).toBe(true);
  });
});
