# pi-claude-subagents

Pi package for multi-agent orchestration: specialist roles, inherited-context workers, parallel investigation, background completion, continuation, verification, and bounded nesting — all on Pi-native sessions, tools, and lifecycle.

Compatible with Pi packages **>= 1.0.0 < 2** (verified against 1.0.0). MIT license.

## Install

This package conflicts with the separate `pi-subagents` package. Remove it first if installed:

```bash
pi remove npm:pi-subagents
```

Pick one install path:

```bash
# npm
pi install npm:pi-claude-subagents@0.3.7

# GitHub release
pi install git:github.com/FFatTiger/pi-claude-subagents@v0.3.7

# local checkout
pi install /absolute/path/to/pi-claude-subagents
```

Reload an existing TUI session with `/reload`, then verify discovery:

```text
/pi-subagents-doctor
/agents
```

Success looks like: doctor reports this package’s agents and config, and `/agents` lists `Explore`, `Plan`, `verification`, `general-purpose`, and any project/user overrides.

## What you get

Four tools on the parent session:

| Tool | Purpose |
| --- | --- |
| `Agent` | Launch a named Fresh agent, an inherited-context Fork, or a parallel task set |
| `SendMessage` | Continue a live or persisted resumable agent |
| `TaskOutput` | Snapshot a task for explicit status / ops diagnosis (not a polling loop) |
| `TaskStop` | Stop a live task and keep partial output |

Root orchestration is a Pi extension. Each child runs in its own Pi `AgentSession`. Metadata and output live under `getAgentDir()`. Parent and child share explicit trust, model, thinking, budget, ancestry, and concurrency state.

## Quick usage

### Fresh specialist

Omit `subagent_type` for `general-purpose`.

```json
{
  "subagent_type": "Explore",
  "description": "Trace token refresh",
  "prompt": "Very thorough. Trace token refresh from the HTTP route through storage and retry behavior. Report absolute paths and line ranges."
}
```

### Fork (inherited context)

Uses Pi `SessionManager.createBranchedSession()`. The child gets the parent conversation branch, effective system prompt, model, and thinking level.

```json
{
  "subagent_type": "fork",
  "name": "release-audit",
  "description": "Audit release readiness",
  "prompt": "Audit the current branch and return a prioritized release punch list under 200 words."
}
```

### Parallel fan-out

TUI and RPC default to background. Print and JSON modes run synchronously. Background completion arrives as a parent follow-up notification — do not poll `TaskOutput`.

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

### Continue / stop

```json
{ "to": "task-id-or-name", "message": "Apply the fix and run the focused regression test." }
```

```json
{ "task_id": "task-id" }
```

`TaskOutput` is for explicit status requests or diagnosis. If the result is required before the next step, launch with `run_in_background: false`.

## Built-in roles

| Agent | Role |
| --- | --- |
| `general-purpose` | Complex research, uncertain searches, dependent implementation, validation |
| `Explore` | Read-only discovery and code-path tracing; one-shot |
| `Plan` | Read-only architecture / planning research; one-shot |
| `verification` | Independent command-evidence verification; background by default |
| `fork` | Synthetic inherited-context worker from the current session branch |

Role and orchestration prompts are source-backed behavioral reconstructions adapted to Pi tools and lifecycle. Architecture-relevant constraints stay; Claude-specific paths, memory, hooks, permissions, and MCP conventions are not runtime inputs.

## When the parent delegates

The injected parent policy is concrete, not “delegate when useful”:

- Delegate open-ended, cross-module, context-heavy, or path-uncertain investigation early
- Fan out two or more independent questions in one `tasks` array call
- Synthesize research before assigning dependent implementation
- Delegate multi-edit / isolation / broad validation work unless tightly scoped
- Handle known-file reads, small symbol lookups, and small edits directly
- Launch verification at the configured threshold or high-risk boundary without waiting for the user
- Never poll, peek, duplicate, or invent background results
- Parent owns understanding, synthesis, final validation, and delivery

## Custom agent definitions

Discovery order (closest wins):

1. bundled `agents/`
2. `${getAgentDir()}/agents/`
3. trusted project `.pi/agents/` from repository root toward cwd

```markdown
---
name: code-reviewer
description: Expert reviewer for correctness, security, maintainability, and tests.
tools: "*"
model: inherit
thinking: high
skills: code-review
readonly: true
shellPolicy: unrestricted
background: true
isolation: worktree
warningTurns: 40
warningIntervalTurns: 25
maxTurns: 60
graceTurns: 1
maxToolCalls: 100
softToolCalls: 80
toolBudgetBlock: read, grep, find, ls
timeoutMs: 900000
---

Review the assigned change and return an evidence-based report.
```

Supported frontmatter: `name`, `description`, `tools`, `disallowedTools`, `model`, `thinking`, `skills`, `readonly`, `shellPolicy`, `background`, `context`, `isolation`, `warningTurns`, `warningIntervalTurns`, `maxTurns`, `graceTurns`, `maxToolCalls`, `softToolCalls`, `toolBudgetBlock`, `timeoutMs`, `oneShot`. Warning settings control mandatory parent supervision. Hard budgets and timeouts are advanced unattended policies and are not exposed as ordinary `Agent` invocation arguments.

`tools` and `disallowedTools` are explicit, user-authored capability selection and remain enforced after intersection with the parent inventory. `readonly` and `shellPolicy` are accepted as compatibility/descriptive role metadata only; they do not automatically remove tools, inspect Bash commands, or enforce a permission boundary.

Child coding tools are Pi-native: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, filtered by parent inventory and role definition. Nested roles may also receive the child `Agent` adapter.

### Skills

Child skill discovery uses Pi `DefaultResourceLoader` and parent project trust. The `skills` field selects discovered Pi skills and preloads their `SKILL.md` into the role system prompt.

## Model selection

1. Explicit `Agent` call `model` override (validated against the current Pi model registry)
2. `subagents.agentOverrides.<AgentName>.model` in Pi user/project `settings.json`
3. Agent Markdown `model` frontmatter
4. `subagents.defaultModel` in Pi user/project `settings.json`
5. Current parent-session model

Omit `model` on normal calls. Unknown overrides fail before child startup. Fork always inherits parent model and thinking. Override keys must match runtime names exactly: `general-purpose`, `Explore`, `Plan`, `verification`. Legacy `pi-subagents` names (`scout`, `planner`, `reviewer`, `worker`) are ignored and reported as diagnostics.

### Fallback model

Configure a fallback model that is used automatically when the primary model is unavailable, so a single transient provider outage (for example a 503 auth error on the first model call) does not fail the whole task:

```json
{
  "subagents": {
    "defaultModel": "provider/primary",
    "fallbackModel": "provider/backup",
    "agentOverrides": {
      "verification": { "fallbackModel": "provider/verifier-backup" }
    }
  }
}
```

Resolution order for `fallbackModel`:

1. `subagents.agentOverrides.<AgentName>.fallbackModel` in Pi user/project `settings.json`
2. Agent Markdown `fallbackModel` frontmatter
3. `subagents.fallbackModel` in Pi user/project `settings.json`

Behavior:

- If the resolved primary model cannot be found or authenticated, the fallback is used before the child starts.
- If the child fails on its very first model call before doing any work (0 turns, no output, no tool calls), the launch is retried once with the fallback model.
- A fallback that equals the primary reference is ignored; fallback is attempted at most once per task.
- Successful fallback retries keep the primary-unavailable note in the task error/diagnostic history.

## Nested agents

A role with `Agent` access may launch a named child. Nested work returns to the direct parent for consolidation.

- Max depth: **5**
- Shared root concurrency quota
- Persisted `rootParentSessionId`, `parentTaskId`, `depth`
- Named child roles; root-session Fork only at the root

## Trust, capability selection, and lifecycle

The child runtime deliberately uses a trust-based capability model:

- Bundled `Explore`, `Plan`, `verification`, and `general-purpose` roles request the full available parent tool inventory with unrestricted Bash. Fresh and Fork workers therefore have full tools unless an explicit custom role inventory narrows them.
- Read-only behavior for bundled exploration, planning, and verification roles is prompt-only and advisory. Their prompts strictly instruct them not to modify files or state, but the runtime does not remove `edit`/`write` or parse and allowlist Bash commands.
- `readonly` and `shellPolicy` remain accepted and persisted as descriptive/compatibility metadata, not automatic runtime permissions.
- Explicit custom-agent `tools` and `disallowedTools` selection remains effective after intersection with the active parent inventory.
- Do not rely on role prompts as a security sandbox. Use OS permissions, containers, VMs, or equivalent process isolation for untrusted models or tasks.

Lifecycle enforcement includes:

- Lifecycle phases: `starting → working → final_handoff → terminal`
- Each root `Agent` invocation explicitly chooses positive `warning_turns` and `warning_interval_turns` for that task instead of copying a universal pair
- Default and general recommendation: `40 / 25` (first checkpoint / recurring interval)
- Override only when scope or risk materially warrants it: narrow/high-risk `15–20 / 10–15`; routine investigation `30–40 / 20–25`; broad research `45–60 / 30–40`; multi-file implementation `50–70 / 35–45`; external/deployment `15–25 / 10–15`
- In a `tasks` array, child entries inherit the top-level warning values unless their scope or risk materially differs
- Long-running children are instructed to emit a one- or two-sentence stage note after meaningful phases and at least every 8–12 tool-using turns, giving the parent fresher visible progress without making supervision warnings frequent
- Mandatory recurring progress supervision follows the chosen checkpoints
- Warnings reach the root parent without stopping the child, restricting tools, or changing task status
- A warning is not a failure, timeout, or proof of a stall; repeated/empty preview alone is insufficient reason to stop. Inspect once with `TaskOutput`, continue while turns/tool counters advance, and reserve `TaskStop` for explicit cancellation, dangerous/duplicate work, or repeated fresh evidence that useful progress stopped
- A foreground task is promoted to supervised background execution on its first warning so the parent can inspect, steer, or stop it
- Optional soft `maxTurns` + grace window for explicit unattended policy (default grace 1)
- Optional hard `maxToolCalls` that blocks only configured tools (default `read`, `grep`, `find`, `ls`)
- Explicit termination kinds: `normal`, `turn_budget`, `tool_budget`, `timeout`, `manual_stop`, `parent_shutdown`, `provider_error`, `startup_error`
- Task statuses: `running`, `completed`, `partial`, `failed`, `stopped`
- Root-shared FIFO concurrency (default capacity 20)
- Project trust propagation; atomic task metadata
- Parent-visible output capped at 200 KiB / 5,000 lines; full `output.md` retained
- Optional Git worktree isolation (clean trees removed; dirty trees kept and reported)

`task.json` is authoritative. Budget/timeout limits that still produced useful output are `partial`. User stop and parent shutdown are `stopped`. Provider/startup failures are `failed`.

Usage fields: `toolCallsRequested`, `toolCallsExecuted`, `toolCallsBlocked`, plus compatibility `toolCalls` (= executed). Thinking is recorded as `requestedThinking`, `effectiveThinking`, and optional `thinkingClampReason`.

Task targets resolve by exact UUID → unique UUID prefix → unique name. Ambiguous names/prefixes return candidates instead of silent picks.

## Configuration

Global:

```text
<getAgentDir()>/pi-claude-subagents.json
```

Trusted project:

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
  "warningTurns": 40,
  "warningIntervalTurns": 25,
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

The public `Agent` schema requires `warning_turns` and `warning_interval_turns` on every root call. The runtime fallback and general recommendation are `40 / 25`. The caller should override that pair only when task scope, uncertainty, drift/stall risk, tool cost, or external waiting materially warrants one of the documented ranges. Tasks-array entries inherit top-level values unless their risk materially differs. Warnings are supervision checkpoints rather than timeout signals, and children emit more frequent concise stage notes independently of the warning schedule. Defaults leave hard timeout, turn, tool, and cleanup budgets unset. Positive `cleanupPeriodDays` enables age-based retention cleanup. Legacy `maxOutputChars` still maps to `maxOutputBytes`. Bundled roles declare no hard budgets; custom frontmatter and runtime config can still define advanced unattended policies.

## Persistence

Task metadata and output artifacts:

```text
<getAgentDir()>/pi-claude-subagents/<root-session-id>/<task-id>/
  task.json
  output.md
```

Child session JSONL lives in Pi's standard session catalogue (`<getAgentDir()>/sessions/<project>/...`, normally `~/.pi/agent/sessions/<project>/...`), colocated with the parent session when a parent session file is available. `TaskRecord.sessionFile` stores that external standard path. Task cleanup removes only task metadata/output directories and does not delete standard child sessions.

## Commands

- `/agents` — list subagents and current tasks
- `/pi-subagents-doctor` — inspect discovery and configuration

## Develop / validate

Requirements: Node.js `>=22.19.0` and Pi packages `>= 1.0.0 < 2` (peer range; verified against 1.0.0).

Pi 1.0 compatibility notes:

- Pi >= 1.0 persists the session file as soon as the first user message exists. `subagent_type: fork` therefore works from the first persisted user turn; a parent branch that has only in-memory setup entries (for example thinking-level changes) is still rejected as non-durable.
- Background completion and progress-warning notifications are delivered through a send helper that recognizes Pi's stale-extension-ctx contract (`This extension ctx is stale after session replacement or reload.`). If the parent session was replaced or reloaded while a child was running, the already-persisted task record survives and the stale notification is dropped instead of crashing the parent process. Any other send error remains observable and is never swallowed.

```bash
npm run check
npm pack --dry-run
```

Architecture notes: [DESIGN.md](./DESIGN.md). Issues: [GitHub Issues](https://github.com/FFatTiger/pi-claude-subagents/issues).

## License

[MIT](./LICENSE) © FFatTiger
