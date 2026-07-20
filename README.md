# pi-claude-subagents

A standalone Pi package for specialist agents, inherited-context workers, parallel investigation, background completion, continuation, verification, and bounded nesting. The runtime is implemented with Pi Extension API and SDK primitives.

## Architecture

The package registers four tools:

- `Agent` — launch a named Fresh agent, an inherited-context Fork worker, or a parallel task set
- `SendMessage` — continue a live or persisted resumable agent
- `TaskOutput` — inspect a task snapshot for an explicit status request or operational diagnosis; normal background completion is automatic
- `TaskStop` — stop a live task and preserve its partial output

Root orchestration runs as a Pi extension. Each child runs in its own Pi `AgentSession`. Task metadata and output are persisted under `getAgentDir()`. Parent and child sessions share explicit trust, model, thinking, budget, ancestry, and concurrency state.

## Dispatch model

### Fresh

A named agent starts with its role prompt, task brief, selected Pi skills, working directory, and execution boundary.

```json
{
  "subagent_type": "Explore",
  "description": "Trace token refresh",
  "prompt": "Very thorough. Trace token refresh from the HTTP route through storage and retry behavior. Report absolute paths and line ranges."
}
```

Omitted `subagent_type` selects `general-purpose`.

### Fork

An inherited-context worker starts from the current persisted Pi session branch:

```json
{
  "subagent_type": "fork",
  "name": "release-audit",
  "description": "Audit release readiness",
  "prompt": "Audit the current branch and return a prioritized release punch list under 200 words."
}
```

Fork construction uses Pi `SessionManager.createBranchedSession()`. The child receives the parent conversation branch, effective system prompt, model, and thinking level.

### Parallel

```json
{
  "tasks": [
    {
      "subagent_type": "Explore",
      "description": "Trace auth implementation",
      "prompt": "Trace auth implementation and data flow."
    },
    {
      "subagent_type": "Explore",
      "description": "Map auth integration",
      "prompt": "Find auth callers, integration points, and affected public interfaces."
    },
    {
      "subagent_type": "Explore",
      "description": "Audit auth tests",
      "prompt": "Map auth tests, repository conventions, and likely regression gaps."
    }
  ]
}
```

TUI and RPC launches default to background execution. Print and JSON modes execute synchronously. Background completion is delivered to the parent session as a follow-up task notification.

## Built-in roles

| Agent | Role |
|---|---|
| `general-purpose` | Complex research, uncertain searches, dependent implementation, and validation |
| `Explore` | Read-only file discovery, code search, and code-path tracing; one-shot |
| `Plan` | Read-only architecture and planning research; one-shot |
| `verification` | Independent command-evidence verification; background by default |
| `fork` | Synthetic inherited-context worker built from the current Pi session branch |

The role and orchestration prompts are source-backed behavioral reconstructions adapted to exact Pi tools and lifecycle semantics. Native Claude Code constraints are retained when they define architecture or failure prevention; Claude-specific paths, configuration, memory, hooks, permissions, and MCP conventions are not runtime inputs.

## Orchestration policy

The parent prompt uses concrete dispatch timing rather than a generic “delegate when useful” rule:

- delegate open-ended, cross-module, context-heavy, or path-uncertain investigation before extensive parent searching
- immediately fan out two or more independent questions in one `tasks` array call
- use two or three non-overlapping investigation angles when they add real coverage
- obtain and synthesize research before assigning dependent implementation
- delegate implementation requiring more than a couple of edits, isolation, broad validation, or substantial intermediate output unless tightly scoped
- handle known-file reads, specific symbols, two-or-three-known-file inspection, and small edits directly
- launch independent verification at the configured threshold or high-risk boundary without waiting for the user
- never poll, peek, duplicate, or predict background results
- inherit role and runtime defaults for normal work; set optional budgets only for intentionally bounded probes while leaving implementation room for validation
- preserve complete Fresh briefs, inherited-context Fork directives, continuation, parent-owned synthesis, and bounded nesting

## Agent definitions

Discovery precedence:

1. bundled `agents/`
2. `${getAgentDir()}/agents/`
3. trusted project `.pi/agents/` from repository root toward the current working directory

The closest definition wins.

```markdown
---
name: code-reviewer
description: Expert reviewer for correctness, security, maintainability, and tests.
tools: read, grep, find, bash
model: inherit
thinking: high
skills: code-review
readonly: true
shellPolicy: verify
background: true
isolation: worktree
maxTurns: 60
graceTurns: 1
maxToolCalls: 100
softToolCalls: 80
toolBudgetBlock: read, grep, find, ls
timeoutMs: 900000
---

Review the assigned change and return an evidence-based report.
```

Supported fields:

- `name`, `description`
- `tools`, `disallowedTools`
- `model`, `thinking`
- `skills`
- `readonly`, `shellPolicy`
- `background`, `context`, `isolation`
- `maxTurns`, `graceTurns`, `maxToolCalls`, `softToolCalls`, `toolBudgetBlock`, `timeoutMs`
- `oneShot`

Tool names refer to Pi tools. The child runtime provides the Pi coding tools `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`, filtered by the parent active inventory and the role definition. Nested roles may also receive the child `Agent` adapter.

## Skills

Child skill discovery uses Pi `DefaultResourceLoader` and the parent project trust state. The `skills` field selects discovered Pi skills and preloads their `SKILL.md` content into the role system prompt.

## Nested agents

A role with `Agent` access may launch a named child role. Nested execution returns to the direct parent, which consolidates the result for its own caller.

- maximum depth: 5
- shared root concurrency quota
- persisted `rootParentSessionId`, `parentTaskId`, and `depth`
- named child roles
- root-session Fork creation

## Continuation and task control

Continue a task:

```json
{ "to": "task-id-or-name", "message": "Apply the fix and run the focused regression test." }
```

Inspect a task only when the user explicitly asks for status or when diagnosing orchestration:

```json
{ "task_id": "task-id", "block": false }
```

Normal background completion arrives automatically. Do not build a polling loop around `TaskOutput`; if the result is required synchronously, launch the original Agent with `run_in_background: false`.

Stop a task:

```json
{ "task_id": "task-id" }
```

Explore and Plan use one-shot execution. General-purpose and custom roles retain a persisted child session for continuation.

## Model selection

Agent models resolve in this order:

1. a deliberate `Agent` call `model` override, validated against the current Pi model registry;
2. `subagents.agentOverrides.<AgentName>.model` from Pi user/project `settings.json`;
3. the Agent Markdown `model` frontmatter;
4. `subagents.defaultModel` from Pi user/project `settings.json`;
5. the current parent-session model.

Omit `model` during normal Agent calls. The selected Agent's configured model is shown in `<agent-listing>` and by `/pi-subagents-doctor`. An unknown explicit override fails before child startup. Fork always inherits the parent model and thinking level.

Override keys must match the runtime names exactly: `general-purpose`, `Explore`, `Plan`, and `verification`. Old `pi-subagents` names such as `scout`, `planner`, `reviewer`, and `worker` are ignored and reported as diagnostics.

## Safety and isolation

Runtime enforcement includes:

- exact role tool selection
- read-only edit/write removal
- `inspect`, `verify`, and `unrestricted` shell policies
- a Pi-native lifecycle controller with `starting → working → final_handoff → terminal` phases
- optional `maxTurns` as a soft wrap-up threshold with a configurable grace window (default grace 1)
- optional `maxToolCalls` as a hard threshold that blocks only the configured tools (default `read`, `grep`, `find`, `ls`)
- separate requested, executed, and blocked tool-call accounting
- a valid final report after selected-tool blocking can still complete normally
- explicit termination kinds: `normal`, `turn_budget`, `tool_budget`, `timeout`, `manual_stop`, `parent_shutdown`, `provider_error`, and `startup_error`
- task statuses: `running`, `completed`, `partial`, `failed`, and `stopped`
- root-shared FIFO concurrency semaphore (default capacity 20)
- project trust propagation
- atomic task metadata
- invocation-scoped output that cannot fall back to an earlier progress message
- parent-visible output bounded to 200 KiB / 5,000 lines while the full `output.md` is retained
- optional Git worktree isolation

Worktree tasks start from the current checkout `HEAD`. Unchanged worktrees are removed; changed worktrees are retained and reported.

## Task lifecycle and diagnostics

`task.json` records the authoritative lifecycle result. Controlled budget limits and timeouts preserve useful output as `partial`; user stop and parent shutdown are `stopped`; provider and startup failures are `failed`.

Tool usage fields are:

- `toolCallsRequested` — every model-requested call
- `toolCallsExecuted` — calls admitted by quota and runtime policy
- `toolCallsBlocked` — calls rejected by budget or policy
- `toolCalls` — compatibility alias for executed calls

Thinking intent and reality are both retained as `requestedThinking`, `effectiveThinking`, and optional `thinkingClampReason`. Legacy `thinking` remains an alias for the effective value. The package reports a clamp; it does not change model metadata automatically.

Task targets resolve by exact UUID, then unique UUID prefix, then unique name. Ambiguous names or prefixes return candidate IDs instead of silently selecting one.

## Configuration

Global configuration:

```text
<getAgentDir()>/pi-claude-subagents.json
```

Trusted project configuration:

```text
.pi/pi-claude-subagents.json
```

```json
{
  "maxConcurrentTasks": 20,
  "defaultTimeoutMs": null,
  "defaultMaxTurns": null,
  "defaultGraceTurns": 1,
  "defaultMaxToolCalls": null,
  "defaultSoftToolCalls": null,
  "defaultToolBudgetBlock": ["read", "grep", "find", "ls"],
  "maxOutputBytes": 204800,
  "maxOutputLines": 5000,
  "maxTasksPerLaunch": 8,
  "maxAgentDepth": 5,
  "enableBackground": true,
  "enableFork": true,
  "enableWorktrees": true,
  "enableNestedAgents": true,
  "proactivePrompt": true,
  "verificationPrompt": true,
  "verificationFileThreshold": 3,
  "cleanupPeriodDays": null
}
```

Defaults leave timeout, turn, tool, and cleanup budgets unset so ordinary work is governed by task scope and Pi session completion. A positive `cleanupPeriodDays` enables age-based retention cleanup. Legacy `maxOutputChars` is still accepted as a fallback for `maxOutputBytes`. Bundled roles do not declare budgets; custom frontmatter and invocation arguments can still set them.

## Persistence

```text
<getAgentDir()>/pi-claude-subagents/<root-session-id>/<task-id>/
  task.json
  output.md
  session.jsonl
```

## Install

```bash
pi remove npm:pi-subagents
pi install /absolute/path/to/pi-claude-subagents
```

Reload an existing TUI session with `/reload`.

## Commands

- `/agents`
- `/pi-subagents-doctor`

## Validation

```bash
npm run check
npm pack --dry-run
```
