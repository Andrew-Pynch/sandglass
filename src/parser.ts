// Sandglass log parser: turns raw Sandcastle log lines into typed records.
//
// Pure line classifiers (extractBashCommand, classifyCommand, roleForSource,
// classifyLine, shouldShowInCompactMode) are carried forward verbatim from the
// original mcg/starcube `sandcastle-highlight.ts` so existing behavior is preserved.
// On top of them, `LogParser` is a small stateful machine that accumulates
// multi-line structured blocks (`<plan>` / `<promise>`) into single records.

export type CommandFamily =
  | "git"
  | "gh"
  | "bun"
  | "read"
  | "network"
  | "codex"
  | "shell"
  | "other";

export type Severity =
  | "error"
  | "warning"
  | "success"
  | "idle"
  | "section"
  | "none";

export type Role = "planner" | "implementer" | "reviewer" | "merger" | "unknown";

export type CommandClassification = {
  family: CommandFamily;
  prominent: boolean;
};

export type LineClassification = {
  command?: string;
  commandInfo?: CommandClassification;
  role: Role;
  severity: Severity;
  toolCall: boolean;
};

const readCommands = new Set(["cat", "find", "rg", "sed", "tail", "head", "ls"]);
const shellCommands = new Set(["bash", "sh", "zsh"]);

function stripEnvPrefixes(command: string) {
  let remaining = command.trim();

  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(remaining)) {
    const match = remaining.match(
      /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^[:space:]\s]+)\s*/,
    );
    if (!match) break;
    remaining = remaining.slice(match[0].length).trimStart();
  }

  return remaining;
}

function firstWord(command: string) {
  const withoutEnv = stripEnvPrefixes(command);
  return withoutEnv.split(/\s+/)[0] ?? "";
}

function unquoteShellArg(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/'\\''/g, "'");
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replace(/\\(["\\$`])/g, "$1")
      .replace(/\\n/g, "\n");
  }
  return trimmed;
}

export function extractBashCommand(line: string): string | undefined {
  const match = line.match(/^Bash\((.*)\)$/);
  if (!match) return undefined;

  const invocation = match[1]!.trim();
  const shellMatch = invocation.match(
    /^(?:\/[^\s]+\/)?(?:bash|sh|zsh)\s+-lc\s+([\s\S]+)$/,
  );
  if (!shellMatch) return invocation;

  return unquoteShellArg(shellMatch[1]!);
}

export function classifyCommand(command: string): CommandClassification {
  const normalized = stripEnvPrefixes(command);
  const word = firstWord(normalized);
  const lower = normalized.toLowerCase();
  const prominent =
    /^git\s+(merge|commit)\b/.test(lower) ||
    /^gh\s+issue\s+close\b/.test(lower) ||
    /^rm\b/.test(lower) ||
    lower.includes("bun.sh/install") ||
    /^bun\s+(add|install)\b/.test(lower) ||
    /\|\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s*)?(?:bash|sh)\b/.test(
      lower,
    );

  if (word === "git") return { family: "git", prominent };
  if (word === "gh") return { family: "gh", prominent };
  if (word === "bun" || word === "bunx") return { family: "bun", prominent };
  if (word === "codex") return { family: "codex", prominent };
  if (readCommands.has(word)) return { family: "read", prominent };
  if (word === "curl" || word === "wget" || lower.includes("https://")) {
    return { family: "network", prominent };
  }
  if (shellCommands.has(word)) return { family: "shell", prominent };
  return { family: "other", prominent };
}

export function roleForSource(source = ""): Role {
  if (source.includes("planner")) return "planner";
  if (source.includes("implementer")) return "implementer";
  if (source.includes("reviewer")) return "reviewer";
  if (source.includes("merger")) return "merger";
  return "unknown";
}

export function classifyLine(line: string, source = ""): LineClassification {
  const command = extractBashCommand(line);
  let severity: Severity = "none";

  if (
    /(failed|error|exception|failure|rejected|fatal|not found|permission denied)/i.test(
      line,
    )
  ) {
    severity = "error";
  } else if (/(warning|warn|conflict|dirty|nothing to merge)/i.test(line)) {
    severity = "warning";
  } else if (
    /(complete|completed|success|run complete|syncing|fast-forwarded|branches merged|all done)/i.test(
      line,
    )
  ) {
    severity = "success";
  } else if (/\bidle\b/i.test(line)) {
    severity = "idle";
  } else if (
    /(=== Iteration|Sandcastle Run|Planning complete|Execution complete|Run started)/.test(
      line,
    )
  ) {
    severity = "section";
  }

  return {
    command,
    commandInfo: command ? classifyCommand(command) : undefined,
    role: roleForSource(source),
    severity,
    toolCall: Boolean(
      command || /^(Read|Write|Edit|MultiEdit|Grep|Glob)\(/.test(line),
    ),
  };
}

export function shouldShowInCompactMode(line: string): boolean {
  const classification = classifyLine(line);
  const trimmed = line.trim();

  if (trimmed === "") return false;
  if (classification.toolCall) return true;
  if (classification.severity === "error" || classification.severity === "warning")
    return true;
  if (/^<plan>|^<promise>|<\/plan>|<\/promise>/.test(trimmed)) return true;
  if (
    /^(I|I'll|I’m|I'm|The|Since|Both|Merged|Created|Reviewed|Issue|Verification|Commit:)\b/.test(
      trimmed,
    )
  ) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Record model + stateful parser
// ---------------------------------------------------------------------------

export type LifecycleSection =
  | "run-started"
  | "run-summary"
  | "iteration"
  | "setup"
  | "expansion"
  | "agent-started"
  | "agent-stopped"
  | "capturing"
  | "collecting"
  | "run-complete"
  | "context";

export type StructuredTag = "plan" | "promise";

export type PlanIssue = {
  id: string;
  title: string;
  branch: string;
};

export type PlanData = {
  issues: PlanIssue[];
};

export type RawRecord = {
  kind: "raw";
  text: string;
};

export type LifecycleRecord = {
  kind: "lifecycle";
  section: LifecycleSection;
  text: string;
};

export type ToolCallRecord = {
  kind: "tool-call";
  tool: string;
  text: string;
  command?: string;
  commandInfo?: CommandClassification;
};

export type StructuredBlockRecord = {
  kind: "structured-block";
  tag: StructuredTag;
  raw: string[];
  json?: unknown;
  parsed?: PlanData;
};

export type LogRecord =
  | RawRecord
  | LifecycleRecord
  | ToolCallRecord
  | StructuredBlockRecord;

const lifecycleMatchers: Array<[RegExp, LifecycleSection]> = [
  [/^---\s*Run started:/, "run-started"],
  [/^Sandcastle Run\b|^\s+(Agent|Sandbox|Max iterations|Branch):/, "run-summary"],
  [/^(?:===\s*)?Iteration\b/, "iteration"],
  [/^Setting up sandbox/, "setup"],
  [/^Expanding shell expressions/, "expansion"],
  [/^Agent started/, "agent-started"],
  [/^Agent stopped/, "agent-stopped"],
  [/^Capturing session/, "capturing"],
  [/^Collecting commits/, "collecting"],
  [/^Run complete:|^Reached max iterations/, "run-complete"],
  [/^Context window:/, "context"],
];

function lifecycleSection(line: string): LifecycleSection | undefined {
  for (const [pattern, section] of lifecycleMatchers) {
    if (pattern.test(line)) return section;
  }
  return undefined;
}

function toolName(line: string): string | undefined {
  if (/^Bash\(/.test(line)) return "Bash";
  const match = line.match(/^(Read|Write|Edit|MultiEdit|Grep|Glob)\(/);
  return match?.[1];
}

function classifySingleLine(line: string): LogRecord {
  const command = extractBashCommand(line);
  const tool = toolName(line);
  if (tool) {
    return {
      kind: "tool-call",
      tool,
      text: line,
      command,
      commandInfo: command ? classifyCommand(command) : undefined,
    };
  }

  const section = lifecycleSection(line);
  if (section) {
    return { kind: "lifecycle", section, text: line };
  }

  return { kind: "raw", text: line };
}

function openingTag(line: string): StructuredTag | undefined {
  const match = line.match(/^<(plan|promise)>/);
  return match?.[1] as StructuredTag | undefined;
}

function buildStructuredBlock(
  tag: StructuredTag,
  raw: string[],
): StructuredBlockRecord {
  const joined = raw.join("\n");
  const inner = joined.match(
    new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`),
  )?.[1];
  const content = (inner ?? "").trim();

  const record: StructuredBlockRecord = { kind: "structured-block", tag, raw };

  if (content.length > 0) {
    try {
      const json = JSON.parse(content);
      record.json = json;
      if (tag === "plan" && isPlanData(json)) {
        record.parsed = json;
      }
    } catch {
      // Malformed or non-JSON content: keep raw[] as the graceful fallback.
    }
  }

  return record;
}

function isPlanData(value: unknown): value is PlanData {
  if (typeof value !== "object" || value === null) return false;
  const issues = (value as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return false;
  return issues.every(
    (issue) =>
      typeof issue === "object" &&
      issue !== null &&
      "id" in issue &&
      "title" in issue &&
      "branch" in issue,
  );
}

/**
 * Stateful, streaming parser. Feed lines one at a time with `push()`; it returns
 * zero or more completed records. Multi-line `<plan>`/`<promise>` blocks are
 * buffered until their closing tag, then emitted as a single structured-block
 * record. Call `flush()` at end-of-stream to emit any unterminated block as raw.
 */
export class LogParser {
  private openTag: StructuredTag | undefined;
  private buffer: string[] = [];

  push(line: string): LogRecord[] {
    if (this.openTag) {
      this.buffer.push(line);
      if (new RegExp(`</${this.openTag}>`).test(line)) {
        const record = buildStructuredBlock(this.openTag, this.buffer);
        this.openTag = undefined;
        this.buffer = [];
        return [record];
      }
      return [];
    }

    const tag = openingTag(line);
    if (tag) {
      // Inline single-line form: <plan>...</plan> on one line.
      if (new RegExp(`</${tag}>`).test(line)) {
        return [buildStructuredBlock(tag, [line])];
      }
      // Multi-line form: start buffering until the closing tag arrives.
      this.openTag = tag;
      this.buffer = [line];
      return [];
    }

    return [classifySingleLine(line)];
  }

  flush(): LogRecord[] {
    if (!this.openTag) return [];
    // Unterminated block at end-of-stream: surface buffered lines as raw.
    const records = this.buffer.map<RawRecord>((text) => ({ kind: "raw", text }));
    this.openTag = undefined;
    this.buffer = [];
    return records;
  }
}

export function createParser(): LogParser {
  return new LogParser();
}
