# AGENTS.md

Agent context for **sandglass** — a small public Bun/TypeScript utility package
and CLI. Not a game repo, not a pipeline. Keep it lean.

## What this is

Sandglass parses raw **Sandcastle log** lines into typed **log records** and
renders them with colors and pretty-printed **structured blocks**. Primary
surface is the `sandglass logs` command.

## Canonical terms

- **Sandglass** — this package; the customization layer over Sandcastle logs.
- **Sandcastle log** — the raw per-role `*.log` files a Sandcastle run emits.
- **log watcher** — discovers and tails Sandcastle logs (`src/watch.ts`).
- **log parser** — turns lines into records (`src/parser.ts`, `LogParser`).
- **log record** — a typed unit: `raw`, `lifecycle`, `tool-call`, `structured-block`.
- **renderer** — paints records to ANSI / no-color output (`src/render.ts`).
- **structured block** — a `<plan>` / `<promise>` tagged block, possibly with JSON.

## Layout

- `src/parser.ts` — classifiers + `LogParser` + record types.
- `src/render.ts` — `renderRecord` (returns `string[]`) + `formatLogLine` wrapper.
- `src/watch.ts` — `resolveLogDir` + `watchLogs`.
- `src/cli.ts` — `sandglass logs`, arg/env parsing, stdin path.
- `src/index.ts` — public re-exports.
- `tests/` — `highlight` (ported legacy), `parser`, `render`, `watch`; fixtures in `tests/fixtures/`.

## Conventions

- Bun-first. No npm deps for runtime; raw ANSI escape codes for color.
- No-color / non-TTY output must stay deterministic and testable.
- Never drop a structured block's `raw[]` — it is the graceful fallback when JSON
  is malformed or absent.
- TDD: behavior is test-shaped; add a failing test before changing parser/render.

## Issue tracker

GitHub Issues on `andrew-pynch/sandglass`. Triage labels: `needs-triage`,
`needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.

## Verify

```sh
bun test
bun run typecheck
cat tests/fixtures/planner.log | bun src/cli.ts logs --stdin --no-color --source main-planner.log
```
