// Sandglass watcher: resolves the active Sandcastle log directory and tails its
// per-role *.log files, streaming each line through the parser + renderer.
//
// The watcher is intentionally lean — the parser/render split is the real value.
// `resolveLogDir` is pure-ish (env + fs probes) and unit tested; the live tail
// shells out to `tail -n <N> -F` on Linux.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { createParser } from "./parser.ts";
import { renderRecord, type RenderOptions } from "./render.ts";
import { shouldShowInCompactMode } from "./parser.ts";

const DEFAULT_LOG_DIR = ".sandcastle/logs";

export type LogEnv = {
  SANDCASTLE_LOG_DIR?: string;
  [key: string]: string | undefined;
};

/**
 * Resolve the Sandcastle log directory, preferring (in order):
 *   1. SANDCASTLE_LOG_DIR when set.
 *   2. .sandcastle/logs/latest when it exists.
 *   3. The path inside .sandcastle/logs/latest-run.txt when it exists.
 *   4. .sandcastle/logs (the default).
 * Returns an absolute path rooted at `cwd`.
 */
export function resolveLogDir(env: LogEnv = process.env, cwd = process.cwd()): string {
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(cwd, p));

  if (env.SANDCASTLE_LOG_DIR && env.SANDCASTLE_LOG_DIR.length > 0) {
    return abs(env.SANDCASTLE_LOG_DIR);
  }

  const base = resolve(cwd, DEFAULT_LOG_DIR);
  const latest = join(base, "latest");
  if (existsSync(latest)) return latest;

  const latestRun = join(base, "latest-run.txt");
  if (existsSync(latestRun)) {
    const target = readFileSync(latestRun, "utf8").trim();
    if (target.length > 0) return abs(target);
  }

  return base;
}

export type WatchOptions = {
  dir: string;
  lines: number;
  pollInterval: number;
  mode: "full" | "compact";
  color: boolean;
  emit?: (line: string) => void;
  signal?: AbortSignal;
};

function discoverLogFiles(dir: string): string[] {
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
    });
}

/**
 * Watch a Sandcastle log directory: discover *.log files (polling for new ones),
 * tail each, and stream rendered output via `emit`. Returns a promise that
 * resolves when the abort signal fires.
 */
export async function watchLogs(options: WatchOptions): Promise<void> {
  const emit = options.emit ?? ((line: string) => console.log(line));
  const watched = new Set<string>();

  const startTail = (file: string) => {
    const source = basename(file);
    const parser = createParser();
    const renderOpts: RenderOptions = { source, color: options.color };

    const proc = Bun.spawn(
      ["tail", "-n", String(options.lines), "-F", file],
      { stdout: "pipe", stderr: "ignore", signal: options.signal },
    );

    void pumpStream(proc.stdout, (line) => {
      for (const record of parser.push(line)) {
        emitRecord(record, renderOpts, options.mode, emit);
      }
    });
  };

  // Initial banner line, mirroring the old watcher.
  emit(`--- watching ${options.dir} ---`);

  while (!options.signal?.aborted) {
    for (const file of discoverLogFiles(options.dir)) {
      if (!watched.has(file)) {
        watched.add(file);
        startTail(file);
      }
    }
    await Bun.sleep(options.pollInterval * 1000);
  }
}

function emitRecord(
  record: ReturnType<ReturnType<typeof createParser>["push"]>[number],
  renderOpts: RenderOptions,
  mode: "full" | "compact",
  emit: (line: string) => void,
) {
  if (mode === "compact" && !recordVisibleInCompact(record)) return;
  for (const line of renderRecord(record, renderOpts)) emit(line);
}

export function recordVisibleInCompact(
  record: ReturnType<ReturnType<typeof createParser>["push"]>[number],
): boolean {
  if (record.kind === "structured-block" || record.kind === "tool-call") return true;
  if (record.kind === "lifecycle") return false;
  return shouldShowInCompactMode(record.text);
}

async function pumpStream(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
) {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    while (pending.includes("\n")) {
      const nl = pending.indexOf("\n");
      onLine(pending.slice(0, nl));
      pending = pending.slice(nl + 1);
    }
  }
  pending += decoder.decode();
  if (pending.length > 0) onLine(pending);
}
