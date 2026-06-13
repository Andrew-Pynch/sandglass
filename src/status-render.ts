// Sandglass status renderer: a compact human table and a stable, ANSI-free JSON
// serialization of a SandcastleRunStatus. The table is deterministic with color
// off (fixed column layout) so it is testable and pipe-friendly; --json is meant
// for side agents and never contains escape codes.

import type {
  AgentLogSummary,
  AgentStatus,
  RunPhase,
  SandcastleIssueStatus,
  SandcastleRunStatus,
} from "./status.ts";

const reset = "\x1b[0m";
const codes = {
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

export type StatusRenderOptions = { color?: boolean };

/** Stable, ANSI-free JSON. Undefined optional fields are omitted by JSON.stringify. */
export function toJsonStatus(status: SandcastleRunStatus): string {
  return JSON.stringify(status, null, 2);
}

function paint(value: string, color: string, enabled: boolean): string {
  return enabled && color ? `${color}${value}${reset}` : value;
}

function statusColor(status: string): string {
  switch (status) {
    case "active":
      return codes.cyan;
    case "complete":
      return codes.green;
    case "failed":
      return codes.red + codes.bold;
    case "no-commits":
      return codes.yellow;
    case "idle":
    case "pending":
    case "not-started":
      return codes.dim;
    default:
      return "";
  }
}

const HEADERS = ["Issue", "Title", "Branch", "Impl", "Review", "Merge", "Result"];

function stageCell(summary: AgentLogSummary | undefined): string {
  return summary?.status ?? "pending";
}

function issueRow(issue: SandcastleIssueStatus): string[] {
  return [
    `#${issue.id}`,
    issue.title ?? "",
    issue.branch ?? "",
    stageCell(issue.implementer),
    stageCell(issue.reviewer),
    stageCell(issue.merge),
    issue.result,
  ];
}

function columnWidths(rows: string[][]): number[] {
  const widths = HEADERS.map((h) => h.length);
  for (const row of rows) {
    row.forEach((cell, i) => {
      if (cell.length > widths[i]!) widths[i] = cell.length;
    });
  }
  return widths;
}

// Cells that should be colored by their agent/issue status (Impl/Review/Merge/Result).
const STATUS_COLUMNS = new Set([3, 4, 5, 6]);

function renderRow(
  row: string[],
  widths: number[],
  color: boolean,
  colorize: boolean,
): string {
  return row
    .map((cell, i) => {
      const padded = i === row.length - 1 ? cell : cell.padEnd(widths[i]!);
      if (colorize && STATUS_COLUMNS.has(i)) {
        // Pad first, then color, so layout stays aligned regardless of color.
        return paint(padded, statusColor(cell), color);
      }
      return padded;
    })
    .join("  ");
}

const PHASE_COLOR: Record<RunPhase, string> = {
  planning: codes.cyan,
  implementing: codes.cyan,
  reviewing: codes.cyan,
  merging: codes.yellow + codes.bold,
  complete: codes.green + codes.bold,
  idle: codes.dim,
  unknown: codes.dim,
};

/** Compact human table: run dir + phase header, an issue grid, interrupt footer, warnings. */
export function renderStatusTable(
  status: SandcastleRunStatus,
  opts: StatusRenderOptions = {},
): string {
  const color = opts.color ?? false;
  const lines: string[] = [];

  lines.push(
    `${paint("Sandcastle run:", codes.bold, color)} ${status.runDir}`,
  );
  lines.push(
    `${paint("Phase:", codes.bold, color)} ${paint(status.phase, PHASE_COLOR[status.phase] ?? "", color)}`,
  );
  lines.push("");

  if (status.issues.length === 0) {
    lines.push(paint("(no issues found in this run)", codes.dim, color));
  } else {
    const rows = status.issues.map(issueRow);
    const widths = columnWidths(rows);
    lines.push(paint(renderRow(HEADERS, widths, color, false), codes.dim, color));
    for (const row of rows) lines.push(renderRow(row, widths, color, true));
  }

  lines.push("");
  const verdict = status.safeToInterrupt.safe ? "YES" : "NO";
  const verdictColor = status.safeToInterrupt.safe ? codes.green : codes.red + codes.bold;
  const reason = status.safeToInterrupt.reason
    ? `  (${status.safeToInterrupt.reason})`
    : "";
  lines.push(
    `${paint("Safe to interrupt:", codes.bold, color)} ${paint(verdict, verdictColor, color)}${paint(reason, codes.dim, color)}`,
  );

  if (status.warnings.length > 0) {
    lines.push("");
    lines.push(paint("Warnings:", codes.yellow + codes.bold, color));
    for (const warning of status.warnings) {
      lines.push(paint(`  ! ${warning}`, codes.yellow, color));
    }
  }

  return lines.join("\n");
}
