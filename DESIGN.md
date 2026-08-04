# pi-claude-subagents design

## Purpose

Provide a deep Pi module for child-agent orchestration: a small model-facing interface over Fresh sessions, inherited-context workers, parallel dispatch, continuation, persistence, verification, and bounded nesting.

## External seam

```ts
interface AgentOrchestrator {
  launch(request: LaunchRequest, parent: ParentContext): Promise<LaunchReceipt>
  send(target: TaskTarget, message: string): Promise<DeliveryReceipt>
  inspect(target: TaskTarget, options?: InspectOptions): Promise<TaskSnapshot>
  stop(target: TaskTarget): Promise<TaskSnapshot>
}
```

The Pi extension adapter exposes this seam as `Agent`, `SendMessage`, `TaskOutput`, and `TaskStop`.

## Modules

- `src/index.ts` — Pi extension registration, root-session state, tool/command adapters, notifications
- `src/prompts.ts` — dispatch classification and parent/child prompt contracts
- `src/agents.ts` — Pi-native role discovery and parsing
- `src/capabilities.ts` — child tool selection
- `src/lifecycle.ts` — pure invocation phase, budget, accounting, and terminal-cause controller
- `src/runtime.ts` — AgentSession construction, Fork preparation, lifecycle event adaptation, nested execution, thinking diagnostics, worktrees
- `src/tasks.ts` — task persistence, historical normalization, strict target routing, invocation output, retention
- `src/config.ts` — global and trusted-project configuration

## Lifecycle

1. Extension registration defines tools, commands, renderers, and lifecycle handlers.
2. `session_start` restores task metadata for the active root session and runs retention cleanup only when a positive cleanup period is configured.
3. `before_agent_start` injects the current orchestration policy and discovered role listing.
4. `Agent` creates child Pi `AgentSession` instances after awaiting the root-shared FIFO capacity semaphore.
5. Child Pi events feed an invocation-scoped lifecycle controller that owns optional soft turn/tool budgets, selected-tool blocking, wrap-up notices, explicit stop causes, status, and output classification.
6. A configured turn count is a soft wrap-up threshold followed by a grace window (default 1). Continuation beyond `maxTurns + graceTurns` records `partial/turn_budget`.
7. Background completion enters the root session through a Pi follow-up message with exact status and termination kind.
8. `SendMessage` steers a live child or reopens a persisted child session with a fresh invocation boundary.
9. `session_shutdown` records `parent_shutdown`, aborts root-owned live tasks, and releases in-memory handles through normal finalization.

## Dispatch

### Fresh

A named role receives:

- its role prompt
- the complete task brief
- selected Pi skills
- child runtime boundary
- task working directory
- resolved Pi model and thinking level

### Fork

The synthetic `fork` type uses Pi `SessionManager` to create a branch from the current persisted leaf. It carries:

- parent conversation entries
- effective parent system prompt
- parent model
- parent thinking level
- resolved sibling tool-call placeholders

### Resume

A resumable role reopens its persisted `session.jsonl`, reuses recorded budgets and trust, appends a new instruction, and appends new output to the task artifact.

### Background

Interactive and RPC launches default to background. Print and JSON launches complete synchronously. Completion is represented as a task notification with status, summary, output file, result, error, usage, and retained-worktree metadata when applicable. Background completion is automatic; normal orchestration does not poll `TaskOutput`.

## Prompt architecture

The parent and child contracts are source-backed behavioral reconstructions adapted to Pi. They preserve architecture-relevant native constraints, including non-duplication, `Never delegate understanding`, no polling or fabricated background results, hard read-only role boundaries, adversarial verification, and direct Fork execution. Claude-specific identity, paths, configuration, memory, hooks, permissions, and MCP syntax are excluded.

The parent contract covers:

- parent ownership of understanding, synthesis, decisions, and delivery
- early specialist routing for open-ended, cross-module, context-heavy, or path-uncertain work
- immediate one-call fan-out for two or more genuinely independent questions
- two-to-three-way non-overlapping parallel investigation
- research-before-dependent-implementation sequencing
- implementation delegation beyond a couple of edits when isolation, validation, or intermediate output makes it worthwhile
- direct Pi tools for known-file reads, specific searches, two-or-three-known-file inspection, and small edits
- complete Fresh briefs and concrete post-research implementation instructions
- inherited-context Fork directives without recap, peeking, polling, or prediction
- continuation based on useful retained state
- completion-driven background workflow
- mandatory recurring progress supervision for normal work, with task-specific first and recurring checkpoints chosen from scope and risk
- hard budgets retained only as explicit custom-agent/runtime unattended policy
- independent adversarial verification without waiting for the user and parent spot-checking
- bounded, restrained nested delegation

Child contracts define role, scope, evidence, allowed access, delegation depth, and handoff shape. Runtime restrictions remain authoritative where a prompt also states the boundary.

## Lifecycle semantics

Each launch and resume creates a new invocation controller:

```text
starting → working → final_handoff → terminal
```

Every root invocation explicitly chooses positive `warning_turns` and `warning_interval_turns` for its assignment rather than copying a universal pair. The choice reflects expected scope, uncertainty, drift/stall risk, tool cost, external waiting, and visibility of intermediate progress. Tasks-array children inherit the top-level values unless their risk materially differs. Internal 30/20 defaults remain only as fail-safe handling for invalid persisted/config values and legacy records, and are not exposed to the calling model as a recommendation. Every invocation then follows its chosen recurring supervision schedule. A child that would continue at its chosen first checkpoint emits a structured warning to the root parent; later warnings recur at its chosen interval. Finishing at a checkpoint emits no warning. Warnings are persisted and deduplicated across reload/resume, do not abort or restrict the child, and are not termination kinds. The root parent may inspect once with `TaskOutput`, continue, steer with `SendMessage`, or stop with `TaskStop`. A foreground launch that reaches its first checkpoint is promoted to supervised background execution so the blocked parent regains control; its eventual completion is then delivered as a root follow-up.

Turn and tool budgets remain optional advanced unattended policy. When configured, `maxTurns` is a soft wrap-up threshold with `graceTurns` (default 1). At the threshold the runtime sends one constructive wrap-up instruction; tools remain available during grace so the child can finish a coherent step. Continuation past `maxTurns + graceTurns` becomes `partial/turn_budget`. `maxToolCalls` is the hard threshold of an optional tool budget; after it is reached, only tools in `toolBudgetBlock` (default `read`, `grep`, `find`, `ls`) are blocked. A valid final report after selected-tool blocking completes normally; only a missing usable report becomes `partial/tool_budget`. Timeout remains `partial/timeout` when a timer is configured. Explicit parent stop becomes `stopped/manual_stop`, parent shutdown becomes `stopped/parent_shutdown`, and startup/provider failures become `failed`.

Tool counters distinguish model requests, admitted executions, and blocks. Compatibility `toolCalls` equals executed calls. Pi `stopReason: aborted` is evidence, not the authoritative task status; explicit lifecycle causes take precedence.

Output extraction is invocation-scoped. An empty aborted terminal message cannot reuse an older progress sentence from the same or a restored session.

Thinking records retain requested and effective levels plus a clamp reason. Runtime respects Pi's effective model capabilities and does not pretend an unsupported level was accepted.

Task routing is strict: exact UUID, unique UUID prefix, then unique name. Ambiguity returns candidate task IDs.

## Role discovery

Roles are loaded from:

1. package `agents/`
2. `${getAgentDir()}/agents/`
3. trusted project `.pi/agents/` directories along the repository path

Later and closer scopes replace earlier definitions with the same name.

## Child capability model

The child coding runtime consists of Pi coding tools:

```text
read bash edit write grep find ls
```

Selection pipeline:

1. intersect with the active parent inventory;
2. apply role `disallowedTools`;
3. remove edit/write for read-only roles;
4. apply the role `tools` selection;
5. add the child `Agent` adapter when nesting is enabled for the role and depth.

The selected names are passed to `createAgentSession({ tools })`. The nested `Agent` adapter is supplied through `customTools`.

## Skills and context

`DefaultResourceLoader` discovers Pi skills under the parent's effective trust state. Selected role skills are preloaded into the child role prompt. Fresh roles use explicit role and task context. Fork workers carry the effective parent system prompt and branch entries.

## Nested execution

Nested agents execute synchronously inside their direct parent AgentSession and return a normal tool result. This gives the direct parent the evidence needed for consolidation while preserving root-context isolation.

- root-shared task quota
- maximum depth 5
- persisted ancestry
- named child roles
- root-level inherited-context branching

## Safety

- exact role tool selection
- read-only tool removal
- inspect/verify shell allowlists
- mandatory recurring root-parent progress supervision with persisted checkpoints
- foreground-to-supervised-background promotion at the first warning
- optional task timeout for explicit unattended policy
- optional soft turn budgets with grace
- optional tool budgets with selected-tool blocking
- root-shared FIFO concurrency semaphore
- trust propagation to child SettingsManager and ResourceLoader
- atomic task metadata writes
- parent-visible output bounded by bytes and lines, with full artifact retention
- opt-in age-based retention cleanup
- partial-output preservation
- clean-checkout worktree creation

## Persistence

Task metadata and output artifacts:

```text
<getAgentDir()>/pi-claude-subagents/<root-session-id>/<task-id>/
  task.json
  output.md
```

Child session JSONL files live in Pi's standard session catalogue (`<getAgentDir()>/sessions/<project>/...`, normally `~/.pi/agent/sessions/<project>/...`), not under the task artifact directory. Fresh children are created in the parent session file's directory with `parentSession` set to the absolute parent session path when available; otherwise they use Pi's default catalogue for the child cwd. Fork children remain at the path returned by `createBranchedSession()` (also in the parent catalogue) with the branched `parentSession` header. `TaskRecord.sessionFile` stores that external standard path for resume and tooling. Age-based task cleanup removes only task metadata/output directories and must not delete standard child sessions.

Task records include ancestry, depth, role, status, termination kind, model, requested/effective thinking and clamp diagnostics, warning schedule/checkpoint state, optional hard budgets, requested/executed/blocked usage, trust, output paths, worktree metadata, and lifecycle timestamps.
