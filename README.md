# sandglass

A better watcher for [Sandcastle](https://github.com/) agent logs. Sandglass is
Andrew's customization layer on top of Sandcastle logs: it parses raw log lines
into typed **log records**, then renders them with role colors, command/severity
highlighting, and pretty-printed `<plan>` / `<promise>` **structured blocks**.

```
sandglass logs
```

## Install

```sh
bun add @andrew-pynch/sandglass
# or run straight from source
bun /path/to/sandglass/src/cli.ts logs
```

## Usage

Watch the current repo's Sandcastle logs:

```sh
sandglass logs
```

Render piped log text (the old highlighter path):

```sh
cat .sandcastle/logs/latest/main-planner.log \
  | sandglass logs --stdin --source main-planner.log
```

### Options

| Flag                    | Default            | Meaning                                  |
| ----------------------- | ------------------ | ---------------------------------------- |
| `--dir <path>`          | resolved (below)   | Log directory to watch                   |
| `--lines <n>`           | `80`               | Lines to tail per file                   |
| `--poll-interval <sec>` | `1`                | New-file discovery poll interval         |
| `--mode <full\|compact>`| `full`             | `compact` keeps tool calls, blocks, prose, errors |
| `--source <name>`       | `sandcastle`       | Source label for `--stdin`               |
| `--stdin`               | off                | Read log text from stdin instead of watching |
| `--color` / `--no-color`| auto (by TTY)      | Force ANSI color on/off                  |

### Environment fallbacks

`SANDCASTLE_LOG_DIR`, `SANDCASTLE_LOG_LINES`, `SANDCASTLE_LOG_POLL_INTERVAL`,
`SANDCASTLE_LOG_MODE`. Flags take precedence over env, which takes precedence
over defaults.

### Log directory resolution

`sandglass logs` resolves the log directory in this order:

1. `SANDCASTLE_LOG_DIR` when set.
2. `.sandcastle/logs/latest` when it exists.
3. The path inside `.sandcastle/logs/latest-run.txt` when it exists.
4. `.sandcastle/logs`.

## Status

`sandglass status` summarizes the current (or selected) Sandcastle run without
tailing raw logs — which issues are planned, which implementer / reviewer /
merger stages are active/idle/complete/failed, and whether it is safe to
interrupt.

```sh
sandglass status                       # current repo's latest run
sandglass status --json                # stable, ANSI-free model for side agents
sandglass status --repo /path/to/repo  # resolve logs from another repo
sandglass status --watch               # re-render on the poll interval
sandglass status --stale-after 90s     # idle threshold (default 120s)
```

Example:

```text
Sandcastle run: .sandcastle/logs/runs/2026-06-13T21-41-31-284Z
Phase: implementing

Issue  Title                         Branch               Impl      Review    Merge     Result
#6     Implement card: Poke          sandcastle/issue-6   active    pending   pending   active
#11    Implement card: Thundersurge  sandcastle/issue-11  complete  active    pending   active

Safe to interrupt: YES  (no merge in progress; agents are interruptible between iterations)
```

Status is **read-only**: it never writes files, never calls GitHub, and never
mutates a run. Everything is inferred from the log files and their mtimes — the
planner `<plan>` block is the issue list, the per-issue `*-implementer.log` /
`*-reviewer.log` files give those stages, and the single `*-merger.log` is sliced
per issue by its `git merge sandcastle/issue-N` / `gh issue close N` lines.

| Flag                  | Default  | Meaning                                          |
| --------------------- | -------- | ------------------------------------------------ |
| `--json`              | off      | Emit the `SandcastleRunStatus` model as JSON (no ANSI) |
| `--watch`             | off      | Re-render on the poll interval                   |
| `--stale-after <dur>` | `120s`   | Idle threshold (`90s`, `2m`, `1500ms`, bare = seconds) |
| `--repo <path>`       | cwd      | Resolve logs from another repo root              |
| `--dir <path>`        | resolved | Log directory (overrides `--repo` resolution)    |

It reuses the same log-directory resolution as `sandglass logs`.

## Library API

```ts
import { createParser, renderRecord } from "@andrew-pynch/sandglass";
// or stable subpaths: "@andrew-pynch/sandglass/parser" | "/render" | "/watch"

const parser = createParser();
for (const record of parser.push(line)) {
  for (const out of renderRecord(record, { source, color: false })) {
    console.log(out);
  }
}
```

- `createParser()` / `LogParser` — streaming parser; `push(line)` returns
  completed records, `flush()` drains an unterminated block.
- `renderRecord(record, opts)` — returns an array of output lines (a parsed
  `<plan>` expands to a header + one row per issue + a `raw:` line).
- `formatLogLine(opts)` — single-line compatibility wrapper.
- `resolveLogDir(env, cwd)` / `watchLogs(opts)` — directory resolution + tailing.
- `readRunStatus(opts)` → `SandcastleRunStatus`, plus `renderStatusTable(status)`
  and `toJsonStatus(status)` — read-only run-status inspection (see
  `sandglass status`).

## Development

```sh
bun test          # parser, render, watch, ported highlight tests
bun run typecheck # tsc --noEmit
```
