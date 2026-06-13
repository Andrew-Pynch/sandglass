// Sandglass run-status: a read-only summary of a Sandcastle run, inferred purely
// from the per-role *.log files (no GitHub, no subprocess, no writes).
//
// The planner log's <plan> block is the master issue list; implementer/reviewer
// logs are per-issue; the merger log is a single file spanning many issues and is
// sliced per-issue here. File mtimes (vs a stale-after window) distinguish an
// active agent from an idle one.

import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  classifyLine,
  createParser,
  roleForSource,
  shouldShowInCompactMode,
  type PlanIssue,
  type Role,
} from "./parser.ts";
import { resolveLogDir, type LogEnv } from "./watch.ts";

export type AgentStatus =
  | "not-started"
  | "active"
  | "idle"
  | "complete"
  | "failed"
  | "unknown";

export type RunPhase =
  | "planning"
  | "implementing"
  | "reviewing"
  | "merging"
  | "complete"
  | "idle"
  | "unknown";

export type IssueResult =
  | "pending"
  | "active"
  | "complete"
  | "no-commits"
  | "failed"
  | "unknown";

export type AgentLogSummary = {
  source: string;
  role: Role;
  status: AgentStatus;
  lastUpdated?: string;
  latestMessage?: string;
  promise?: string;
};

export type SandcastleIssueStatus = {
  id: string;
  title?: string;
  branch?: string;
  implementer?: AgentLogSummary;
  reviewer?: AgentLogSummary;
  merge?: AgentLogSummary;
  result: IssueResult;
  lastUpdated?: string;
  latestMessage?: string;
};

export type SandcastleLogStatus = {
  source: string;
  role: Role;
  issueId?: string;
  status: AgentStatus;
  lastUpdated?: string;
  bytes: number;
};

export type InterruptVerdict = { safe: boolean; reason: string };

export type SandcastleRunStatus = {
  runDir: string;
  generatedAt: string;
  phase: RunPhase;
  safeToInterrupt: InterruptVerdict;
  latestRunStartedAt?: string;
  latestRunCompletedAt?: string;
  issues: SandcastleIssueStatus[];
  logs: SandcastleLogStatus[];
  warnings: string[];
};

export type ReadRunStatusOptions = {
  dir?: string;
  repo?: string;
  env?: LogEnv;
  cwd?: string;
  staleAfterMs?: number;
  now?: () => Date;
};

export const DEFAULT_STALE_AFTER_MS = 120_000;

// ---------------------------------------------------------------------------
// Filename / duration helpers
// ---------------------------------------------------------------------------

/** Extract the issue id from a per-issue log filename, e.g. `sandcastle-issue-11-implementer.log` -> `11`. */
export function issueIdFromSource(source: string): string | undefined {
  return basename(source).match(/issue-(\d+)/)?.[1];
}

/** Parse a human duration (`90s`, `2m`, `1500ms`, `1h`, bare `120` = seconds) into milliseconds. */
export function parseDuration(text: string): number | undefined {
  const match = text.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  switch ((match[2] ?? "s").toLowerCase()) {
    case "ms":
      return value;
    case "m":
      return value * 60_000;
    case "h":
      return value * 3_600_000;
    default:
      return value * 1_000;
  }
}

// ---------------------------------------------------------------------------
// Plan extraction
// ---------------------------------------------------------------------------

/** Parse the planner <plan> block into its issue list (empty if absent/malformed). */
export function parsePlanIssues(content: string): PlanIssue[] {
  const parser = createParser();
  const scan = (records: ReturnType<typeof parser.push>) => {
    for (const record of records) {
      if (
        record.kind === "structured-block" &&
        record.tag === "plan" &&
        record.parsed
      ) {
        return record.parsed.issues;
      }
    }
    return undefined;
  };
  for (const line of content.split("\n")) {
    const found = scan(parser.push(line));
    if (found) return found;
  }
  return scan(parser.flush()) ?? [];
}

// ---------------------------------------------------------------------------
// Per-log summary
// ---------------------------------------------------------------------------

function latestMessage(lines: string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i]!.trim();
    if (trimmed === "") continue;
    if (shouldShowInCompactMode(trimmed)) return trimmed;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i]!.trim();
    if (trimmed !== "") return trimmed;
  }
  return undefined;
}

/**
 * Reduce a single log file's content + mtime to an AgentLogSummary. Completion is
 * signalled by `<promise>COMPLETE</promise>` / `Agent signaled completion` / `Run
 * complete: agent finished`. Failure is role-aware: a planner ending "without
 * completion signal" is normal, not a failure. Liveness (active vs idle) comes
 * from the mtime relative to `staleAfterMs`.
 */
export function summarizeLogFile(
  source: string,
  content: string,
  mtimeMs: number,
  nowMs: number,
  staleAfterMs: number,
): AgentLogSummary {
  const role = roleForSource(source);
  const lines = content.split("\n");
  const promise = /<promise>COMPLETE<\/promise>/.test(content)
    ? "COMPLETE"
    : undefined;

  const completed =
    promise === "COMPLETE" ||
    /Agent signaled completion/.test(content) ||
    /Run complete: agent finished/.test(content);

  const started = /(^|\n)Agent started/.test(content);
  const stale = nowMs - mtimeMs > staleAfterMs;
  const idleLine = /Agent idle for /.test(content);

  // Role-aware failure: only non-planner agents can "fail" by exhausting their
  // iterations without a completion promise.
  const failed =
    role !== "planner" &&
    !completed &&
    (/Run complete: reached \d+ iteration\(s\) without completion/.test(content) ||
      /Reached max iterations/.test(content));

  let status: AgentStatus;
  if (completed) {
    status = "complete";
  } else if (failed) {
    status = "failed";
  } else if (
    role === "planner" &&
    (/Run complete:/.test(content) || /(^|\n)Agent stopped/.test(content))
  ) {
    // The planner has no completion promise; emitting its plan and stopping is
    // its "done" state.
    status = "complete";
  } else if (started && (stale || idleLine)) {
    status = "idle";
  } else if (started) {
    status = "active";
  } else {
    status = "unknown";
  }

  return {
    source: basename(source),
    role,
    status,
    lastUpdated: new Date(mtimeMs).toISOString(),
    latestMessage: latestMessage(lines),
    promise,
  };
}

// ---------------------------------------------------------------------------
// Merger attribution (one file, many issues)
// ---------------------------------------------------------------------------

export type MergeInfo = {
  merged: boolean;
  closed: boolean;
  conflict: boolean;
  lastLine?: string;
};

/**
 * Slice the single merger log into per-issue merge info. Each `git merge
 * sandcastle/issue-N` opens a region that runs until the next such line; within
 * it we look for a clean/fast-forward merge, a conflict, and a `gh issue close N`
 * / `Issue N is closed.` that confirms the issue landed.
 */
export function mergeRegionsByIssue(content: string): Map<string, MergeInfo> {
  const lines = content.split("\n");
  const regions = new Map<string, MergeInfo>();

  let currentId: string | undefined;
  const ensure = (id: string): MergeInfo => {
    let info = regions.get(id);
    if (!info) {
      info = { merged: false, closed: false, conflict: false };
      regions.set(id, info);
    }
    return info;
  };

  for (const line of lines) {
    const mergeStart = line.match(/git merge sandcastle\/issue-(\d+)/);
    if (mergeStart) {
      currentId = mergeStart[1]!;
      ensure(currentId);
      continue;
    }

    const closeMatch =
      line.match(/gh issue close (\d+)/) ?? line.match(/Issue (\d+) is closed/);
    if (closeMatch) {
      const info = ensure(closeMatch[1]!);
      info.closed = true;
      info.merged = true;
      info.lastLine = line.trim();
      continue;
    }

    if (currentId) {
      const info = ensure(currentId);
      info.lastLine = line.trim() || info.lastLine;
      if (/conflict|CONFLICT/.test(line)) info.conflict = true;
      if (/fast-forward|merge commit|merged cleanly|Created merge commit/i.test(line)) {
        info.merged = true;
      }
    }
  }

  return regions;
}

function mergeSummaryFor(
  info: MergeInfo,
  mergerSummary: AgentLogSummary | undefined,
): AgentLogSummary {
  let status: AgentStatus;
  if (info.closed) {
    status = "complete";
  } else if (info.conflict) {
    status = mergerSummary?.status === "complete" ? "complete" : "active";
  } else if (info.merged) {
    status = "complete";
  } else {
    status = mergerSummary?.status ?? "unknown";
  }

  return {
    source: mergerSummary?.source ?? "main-merger.log",
    role: "merger",
    status,
    lastUpdated: mergerSummary?.lastUpdated,
    latestMessage: info.lastLine ?? mergerSummary?.latestMessage,
    promise: mergerSummary?.promise,
  };
}

// ---------------------------------------------------------------------------
// Derivations: issue result, run phase, interrupt verdict
// ---------------------------------------------------------------------------

export function deriveIssueResult(args: {
  implementer?: AgentLogSummary;
  reviewer?: AgentLogSummary;
  merge?: AgentLogSummary;
  closed?: boolean;
  implNoCommits?: boolean;
}): IssueResult {
  const { implementer, reviewer, merge, closed, implNoCommits } = args;

  if (closed || merge?.status === "complete") return "complete";
  if (
    implementer?.status === "failed" ||
    reviewer?.status === "failed" ||
    merge?.status === "failed"
  ) {
    return "failed";
  }
  if (!implementer) return "pending";
  if (implementer.status === "complete" && implNoCommits) return "no-commits";
  if (
    implementer.status === "active" ||
    reviewer?.status === "active" ||
    merge?.status === "active"
  ) {
    return "active";
  }
  // Implementer present (started) but not active and not merged: still in-flight
  // through the review/merge pipeline.
  if (
    implementer.status === "idle" ||
    implementer.status === "complete" ||
    reviewer?.status === "idle" ||
    reviewer?.status === "complete"
  ) {
    return "active";
  }
  return "unknown";
}

export function derivePhase(
  summaries: AgentLogSummary[],
  issues: SandcastleIssueStatus[],
): RunPhase {
  const anyActive = (role: Role) =>
    summaries.some((s) => s.role === role && s.status === "active");

  if (anyActive("merger")) return "merging";
  if (anyActive("reviewer")) return "reviewing";
  if (anyActive("implementer")) return "implementing";
  if (anyActive("planner")) return "planning";

  if (issues.length > 0 && issues.every((i) => i.result === "complete")) {
    return "complete";
  }
  if (summaries.some((s) => s.status === "idle")) return "idle";

  const plannerDone = summaries.some(
    (s) => s.role === "planner" && s.status === "complete",
  );
  const noImplementers = !summaries.some((s) => s.role === "implementer");
  if (plannerDone && noImplementers) return "planning";

  return "unknown";
}

export function deriveInterrupt(
  phase: RunPhase,
  summaries: AgentLogSummary[],
  mergeByIssue: Map<string, MergeInfo>,
): InterruptVerdict {
  const mergerActive = summaries.some(
    (s) => s.role === "merger" && s.status === "active",
  );

  if (mergerActive) {
    const conflicting = [...mergeByIssue.entries()].find(
      ([, info]) => info.conflict && !info.closed,
    );
    if (conflicting) {
      return {
        safe: false,
        reason: `merger is resolving a conflict on sandcastle/issue-${conflicting[0]}`,
      };
    }
    return { safe: false, reason: "merger is mid-merge; index may be dirty" };
  }

  if (phase === "complete") {
    return { safe: true, reason: "run is complete" };
  }
  if (phase === "idle") {
    return { safe: true, reason: "all agents are idle between iterations" };
  }
  return {
    safe: true,
    reason: "no merge in progress; agents are interruptible between iterations",
  };
}

// ---------------------------------------------------------------------------
// Top-level assembly
// ---------------------------------------------------------------------------

type LogAnalysis = {
  file: string;
  source: string;
  role: Role;
  issueId?: string;
  content: string;
  mtimeMs: number;
  bytes: number;
  summary: AgentLogSummary;
};

function listLogFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".log"))
    .map((name) => join(dir, name))
    .filter((file) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

function resolveDir(opts: ReadRunStatusOptions): string {
  if (opts.dir) return opts.dir;
  return resolveLogDir(opts.env, opts.repo ?? opts.cwd);
}

function extractStartedAt(content: string): string | undefined {
  return content.match(/--- Run started:\s*(\S+)\s*---/)?.[1];
}

function buildIssue(
  id: string,
  plan: PlanIssue | undefined,
  analyses: LogAnalysis[],
  mergeByIssue: Map<string, MergeInfo>,
  mergerSummary: AgentLogSummary | undefined,
): SandcastleIssueStatus {
  const implA = analyses.find(
    (a) => a.issueId === id && a.role === "implementer",
  );
  const revA = analyses.find((a) => a.issueId === id && a.role === "reviewer");
  const implementer = implA?.summary;
  const reviewer = revA?.summary;

  const mergeInfo = mergeByIssue.get(id);
  const merge = mergeInfo ? mergeSummaryFor(mergeInfo, mergerSummary) : undefined;

  const implNoCommits = implA
    ? /No commits to sync out/.test(implA.content)
    : false;

  const result = deriveIssueResult({
    implementer,
    reviewer,
    merge,
    closed: mergeInfo?.closed,
    implNoCommits,
  });

  const updates = [implementer?.lastUpdated, reviewer?.lastUpdated, merge?.lastUpdated]
    .filter((v): v is string => Boolean(v))
    .sort();
  const lastUpdated = updates.at(-1);
  const latestMessage =
    merge?.latestMessage ?? reviewer?.latestMessage ?? implementer?.latestMessage;

  return {
    id,
    title: plan?.title,
    branch: plan?.branch ?? `sandcastle/issue-${id}`,
    implementer,
    reviewer,
    merge,
    result,
    lastUpdated,
    latestMessage,
  };
}

export async function readRunStatus(
  opts: ReadRunStatusOptions = {},
): Promise<SandcastleRunStatus> {
  const now = opts.now ?? (() => new Date());
  const nowMs = now().getTime();
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const dir = resolveDir(opts);
  const warnings: string[] = [];

  let runDir = dir;
  try {
    runDir = realpathSync(dir);
  } catch {
    warnings.push(`Log directory not found: ${dir}`);
  }

  const analyses: LogAnalysis[] = listLogFiles(dir).map((file) => {
    const content = readFileSync(file, "utf8");
    const st = statSync(file);
    const source = basename(file);
    return {
      file,
      source,
      role: roleForSource(source),
      issueId: issueIdFromSource(source),
      content,
      mtimeMs: st.mtimeMs,
      bytes: st.size,
      summary: summarizeLogFile(source, content, st.mtimeMs, nowMs, staleAfterMs),
    };
  });

  for (const a of analyses) {
    if (a.summary.status === "unknown") {
      warnings.push(`Could not classify log: ${a.source}`);
    }
  }

  const plannerA = analyses.find((a) => a.role === "planner");
  const plan = plannerA ? parsePlanIssues(plannerA.content) : [];
  const planById = new Map(plan.map((p) => [p.id, p]));

  const mergerA = analyses.find((a) => a.role === "merger");
  const mergeByIssue = mergerA
    ? mergeRegionsByIssue(mergerA.content)
    : new Map<string, MergeInfo>();

  // Issue ids: plan order first, then any issue ids seen only in logs / merges.
  const orderedIds: string[] = [...plan.map((p) => p.id)];
  const seen = new Set(orderedIds);
  const extras = new Set<string>();
  for (const a of analyses) if (a.issueId) extras.add(a.issueId);
  for (const id of mergeByIssue.keys()) extras.add(id);
  for (const id of [...extras].sort((x, y) => Number(x) - Number(y))) {
    if (!seen.has(id)) {
      seen.add(id);
      orderedIds.push(id);
    }
  }

  const issues = orderedIds.map((id) =>
    buildIssue(id, planById.get(id), analyses, mergeByIssue, mergerA?.summary),
  );

  const summaries = analyses.map((a) => a.summary);
  const phase = derivePhase(summaries, issues);
  const safeToInterrupt = deriveInterrupt(phase, summaries, mergeByIssue);

  const logs: SandcastleLogStatus[] = analyses.map((a) => ({
    source: a.source,
    role: a.role,
    issueId: a.issueId,
    status: a.summary.status,
    lastUpdated: a.summary.lastUpdated,
    bytes: a.bytes,
  }));

  const latestRunStartedAt = plannerA
    ? extractStartedAt(plannerA.content)
    : analyses.map((a) => extractStartedAt(a.content)).find(Boolean);
  const latestRunCompletedAt =
    phase === "complete"
      ? analyses
          .map((a) => a.summary.lastUpdated)
          .filter((v): v is string => Boolean(v))
          .sort()
          .at(-1)
      : undefined;

  return {
    runDir,
    generatedAt: now().toISOString(),
    phase,
    safeToInterrupt,
    latestRunStartedAt,
    latestRunCompletedAt,
    issues,
    logs,
    warnings,
  };
}
