// Sandglass renderer: paints parsed log records with ANSI colors (raw escape
// codes, no dependencies). `formatLogLine` is the single-line compatibility
// wrapper preserved from the original highlighter; `renderRecord` is the
// record-aware path that can expand a parsed <plan> into multiple lines.

import {
  classifyCommand,
  classifyLine,
  extractBashCommand,
  roleForSource,
  type LineClassification,
  type LogRecord,
  type Role,
  type StructuredBlockRecord,
} from "./parser.ts";

const reset = "\x1b[0m";
const colors = {
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
};

const SOURCE_PAD = 34;

export type RenderOptions = {
  source?: string;
  color?: boolean;
  now?: () => string;
};

function paint(value: string, color: string, enabled: boolean) {
  return enabled && color ? `${color}${value}${reset}` : value;
}

function lineColor(classification: LineClassification): string {
  if (classification.commandInfo?.prominent) return colors.red + colors.bold;
  if (classification.commandInfo?.family === "git") return colors.magenta;
  if (classification.commandInfo?.family === "gh") return colors.blue;
  if (classification.commandInfo?.family === "bun") return colors.green;
  if (classification.commandInfo?.family === "read") return colors.dim + colors.cyan;
  if (classification.commandInfo?.family === "network") return colors.yellow;
  if (classification.commandInfo?.family === "codex") return colors.cyan;

  switch (classification.severity) {
    case "error":
      return colors.red + colors.bold;
    case "warning":
      return colors.yellow + colors.bold;
    case "success":
      return colors.green + colors.bold;
    case "idle":
      return colors.yellow + colors.dim;
    case "section":
      return colors.blue + colors.bold;
    default:
      return "";
  }
}

function sourceColor(role: Role): string {
  switch (role) {
    case "planner":
      return colors.blue;
    case "implementer":
      return colors.green;
    case "reviewer":
      return colors.magenta;
    case "merger":
      return colors.yellow;
    default:
      return colors.cyan;
  }
}

function nowDefault() {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

function resolveColor(color?: boolean) {
  return color ?? Boolean(process.stdout.isTTY);
}

function prefix(source: string, role: Role, time: string, color: boolean) {
  const timestamp = paint(time, colors.dim, color);
  const sourceText = paint(source.padEnd(SOURCE_PAD), sourceColor(role), color);
  return `${timestamp} ${sourceText} `;
}

/**
 * Single-line compatibility wrapper. Output is byte-identical to the original
 * highlighter: `timestamp  source(padEnd 34)  message`, with `Bash:` rewriting
 * for tool commands.
 */
export function formatLogLine(options: {
  line: string;
  source?: string;
  color?: boolean;
  now?: () => string;
}): string {
  const source = options.source ?? "sandcastle";
  const color = resolveColor(options.color);
  const now = options.now ?? nowDefault;
  const classification = classifyLine(options.line, source);
  const command = extractBashCommand(options.line);
  const message = command ? `Bash: ${command}` : options.line;
  return (
    prefix(source, classification.role, now(), color) +
    paint(message, lineColor(classification), color)
  );
}

// Lifecycle section -> color. Headers/iterations stand out; bookkeeping dims.
function lifecycleColor(section: string): string {
  switch (section) {
    case "run-started":
    case "run-summary":
    case "iteration":
      return colors.blue + colors.bold;
    case "run-complete":
      return colors.green + colors.bold;
    case "context":
      return colors.dim;
    default:
      return colors.dim;
  }
}

function structuredHeaderColor(tag: string): string {
  return tag === "plan" ? colors.cyan + colors.bold : colors.green + colors.bold;
}

function renderStructuredBlock(
  record: StructuredBlockRecord,
  source: string,
  role: Role,
  time: string,
  color: boolean,
): string[] {
  const pre = prefix(source, role, time, color);
  const header = structuredHeaderColor(record.tag);
  const lines: string[] = [];

  lines.push(pre + paint(`<${record.tag}>`, header, color));

  if (record.parsed) {
    for (const issue of record.parsed.issues) {
      const row = `  #${issue.id} ${issue.title}  (${issue.branch})`;
      lines.push(pre + paint(row, colors.cyan, color));
    }
    const raw = JSON.stringify(record.parsed);
    lines.push(pre + paint(`  raw: ${raw}`, colors.dim, color));
  } else {
    // No parsed plan: preserve the inner content verbatim (the raw fallback),
    // extracted from between the tags so the inline single-line form works too.
    const joined = record.raw.join("\n");
    const inner =
      joined.match(new RegExp(`<${record.tag}>([\\s\\S]*?)</${record.tag}>`))?.[1] ??
      joined;
    for (const l of inner.split("\n")) {
      if (l.trim() === "") continue;
      lines.push(pre + paint(`  ${l.trim()}`, colors.dim, color));
    }
  }

  lines.push(pre + paint(`</${record.tag}>`, header, color));
  return lines;
}

/**
 * Record-aware renderer. Returns an array of output lines (a parsed <plan>
 * expands to a header + one row per issue + a raw line; everything else is a
 * single element). The raw[] of a structured block is never dropped.
 */
export function renderRecord(record: LogRecord, options: RenderOptions = {}): string[] {
  const source = options.source ?? "sandcastle";
  const color = resolveColor(options.color);
  const role = roleForSource(source);
  const time = (options.now ?? nowDefault)();
  const pre = prefix(source, role, time, color);

  switch (record.kind) {
    case "structured-block":
      return renderStructuredBlock(record, source, role, time, color);

    case "tool-call": {
      const message = record.command ? `Bash: ${record.command}` : record.text;
      const classification: LineClassification = {
        command: record.command,
        commandInfo: record.command
          ? classifyCommand(record.command)
          : undefined,
        role,
        severity: "none",
        toolCall: true,
      };
      return [pre + paint(message, lineColor(classification), color)];
    }

    case "lifecycle":
      return [pre + paint(record.text, lifecycleColor(record.section), color)];

    case "raw": {
      const classification = classifyLine(record.text, source);
      return [pre + paint(record.text, lineColor(classification), color)];
    }
  }
}
