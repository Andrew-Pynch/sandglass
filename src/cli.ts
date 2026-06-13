#!/usr/bin/env bun
// Sandglass CLI. `sandglass logs` watches the current repo's Sandcastle logs;
// piping log text on stdin renders it line-by-line (the old highlighter path).

import { createParser } from "./parser.ts";
import { renderRecord } from "./render.ts";
import {
  recordVisibleInCompact,
  resolveLogDir,
  watchLogs,
} from "./watch.ts";

type Mode = "full" | "compact";

type Options = {
  dir?: string;
  lines: number;
  pollInterval: number;
  mode: Mode;
  color: boolean;
  source: string;
  stdin: boolean;
};

const HELP = `sandglass — a better Sandcastle log watcher

Usage:
  sandglass logs [options]            Watch the current repo's Sandcastle logs
  cat run.log | sandglass logs --stdin   Render piped log text

Options:
  --dir <path>            Log directory (default: resolved from .sandcastle/logs)
  --lines <n>             Lines to tail per file (default: 80)
  --poll-interval <sec>   New-file poll interval (default: 1)
  --mode <full|compact>   Output verbosity (default: full)
  --source <name>         Source label for --stdin (default: sandcastle)
  --stdin                 Read log text from stdin instead of watching
  --color / --no-color    Force ANSI color on/off (default: auto by TTY)
  -h, --help              Show this help

Environment fallbacks:
  SANDCASTLE_LOG_DIR, SANDCASTLE_LOG_LINES,
  SANDCASTLE_LOG_POLL_INTERVAL, SANDCASTLE_LOG_MODE
`;

function parseMode(value: string | undefined, fallback: Mode): Mode {
  return value === "full" || value === "compact" ? value : fallback;
}

function parseArgs(argv: string[]): { command?: string; options: Options; help: boolean } {
  const env = process.env;
  const options: Options = {
    dir: env.SANDCASTLE_LOG_DIR,
    lines: Number(env.SANDCASTLE_LOG_LINES ?? 80) || 80,
    pollInterval: Number(env.SANDCASTLE_LOG_POLL_INTERVAL ?? 1) || 1,
    mode: parseMode(env.SANDCASTLE_LOG_MODE, "full"),
    color: Boolean(process.stdout.isTTY),
    source: "sandcastle",
    stdin: false,
  };

  let command: string | undefined;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        help = true;
        break;
      case "--dir":
        options.dir = argv[++i];
        break;
      case "--lines":
        options.lines = Number(argv[++i]) || options.lines;
        break;
      case "--poll-interval":
        options.pollInterval = Number(argv[++i]) || options.pollInterval;
        break;
      case "--mode":
        options.mode = parseMode(argv[++i], options.mode);
        break;
      case "--source":
        options.source = argv[++i] ?? options.source;
        break;
      case "--stdin":
        options.stdin = true;
        break;
      case "--color":
        options.color = true;
        break;
      case "--no-color":
        options.color = false;
        break;
      default:
        if (arg && !arg.startsWith("-") && !command) command = arg;
    }
  }

  return { command, options, help };
}

async function runStdin(options: Options) {
  const parser = createParser();
  const decoder = new TextDecoder();
  let pending = "";

  const handle = (line: string) => {
    for (const record of parser.push(line)) {
      if (options.mode === "compact" && !recordVisibleInCompact(record)) continue;
      for (const out of renderRecord(record, {
        source: options.source,
        color: options.color,
      })) {
        console.log(out);
      }
    }
  };

  for await (const chunk of Bun.stdin.stream()) {
    pending += decoder.decode(chunk, { stream: true });
    while (pending.includes("\n")) {
      const nl = pending.indexOf("\n");
      handle(pending.slice(0, nl));
      pending = pending.slice(nl + 1);
    }
  }
  pending += decoder.decode();
  if (pending.length > 0) handle(pending);
  for (const record of parser.flush()) {
    for (const out of renderRecord(record, {
      source: options.source,
      color: options.color,
    })) {
      console.log(out);
    }
  }
}

async function runLogs(options: Options) {
  if (options.stdin) {
    await runStdin(options);
    return;
  }

  const dir = options.dir ?? resolveLogDir();
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await watchLogs({
    dir,
    lines: options.lines,
    pollInterval: options.pollInterval,
    mode: options.mode,
    color: options.color,
    signal: controller.signal,
  });
}

async function main() {
  const { command, options, help } = parseArgs(Bun.argv.slice(2));

  if (help) {
    console.log(HELP);
    return;
  }

  switch (command) {
    case undefined:
    case "logs":
      await runLogs(options);
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
