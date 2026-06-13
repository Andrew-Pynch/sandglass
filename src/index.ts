// Sandglass public surface: parser records + classifiers, renderer, and the
// log-directory resolver / watcher. Adoption repos (MCG, Starcube) import from
// here or the `./parser` / `./render` / `./watch` subpaths.

export {
  LogParser,
  createParser,
  classifyCommand,
  classifyLine,
  extractBashCommand,
  roleForSource,
  shouldShowInCompactMode,
  type CommandClassification,
  type CommandFamily,
  type LifecycleRecord,
  type LifecycleSection,
  type LineClassification,
  type LogRecord,
  type PlanData,
  type PlanIssue,
  type RawRecord,
  type Role,
  type Severity,
  type StructuredBlockRecord,
  type StructuredTag,
  type ToolCallRecord,
} from "./parser.ts";

export {
  formatLogLine,
  renderRecord,
  type RenderOptions,
} from "./render.ts";

export {
  resolveLogDir,
  watchLogs,
  recordVisibleInCompact,
  type LogEnv,
  type WatchOptions,
} from "./watch.ts";
