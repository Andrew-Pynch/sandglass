# CONTEXT

Domain context for **sandglass**. See `AGENTS.md` for working conventions.

## Purpose

Sandglass is the single home for the Sandcastle log highlighting that previously
lived as duplicated `scripts/sandcastle-highlight.ts` copies in multiple repos
(MCG, Starcube). It is a public utility: a log parser + renderer + `sandglass logs`
watcher CLI.

## Domain language

| Term                | Meaning |
| ------------------- | ------- |
| **Sandglass**       | This package — the customization layer on top of Sandcastle logs. |
| **Sandcastle log**  | A raw per-role `*.log` file produced by a Sandcastle run (e.g. `main-planner.log`, `sandcastle-issue-32-implementer.log`). |
| **log watcher**     | Resolves the active log directory and tails its `*.log` files. |
| **log parser**      | `LogParser`: a streaming state machine turning lines into **log records**. |
| **log record**      | A typed unit of parsed output: `raw`, `lifecycle`, `tool-call`, or `structured-block`. |
| **renderer**        | Maps records to ANSI-colored or deterministic no-color lines. |
| **structured block**| A `<plan>` or `<promise>` tagged block. `<plan>` JSON is pretty-printed into issue rows (`id`, `title`, `branch`); the raw JSON is always retained as a fallback. |

## Roles

Sandcastle log filenames encode a **role**: `planner`, `implementer`, `reviewer`,
`merger`, or `unknown`. The renderer assigns each role a stable source color.

## Invariants

- A structured block's `raw[]` is never lost, even when its JSON is malformed.
- No-color / non-TTY output is deterministic (no escape codes, fixed layout:
  `timestamp  source.padEnd(34)  message`).
- Runtime has zero npm dependencies.
