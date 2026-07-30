import type { AgentDefinition } from "./agents.ts";
import type { PiSubagentsConfig } from "./config.ts";

export type ParentMode = "tui" | "rpc" | "json" | "print";
export const FORK_AGENT_TYPE = "fork";

export interface AgentRequestInput {
  description?: string;
  prompt?: string;
  subagent_type?: string;
  model?: string;
  thinking?: string;
  run_in_background?: boolean;
  isolation?: "none" | "worktree";
  cwd?: string;
  name?: string;
}

export interface DispatchDecision {
  agent: AgentDefinition;
  forked: boolean;
  background: boolean;
  requestedType: string;
}

export function resolveTaskIsolation(requested: AgentRequestInput["isolation"], agentDefault: AgentDefinition["isolation"]): "worktree" | undefined {
  if (requested === "none") return undefined;
  if (requested === "worktree") return "worktree";
  return agentDefault;
}

export function createSyntheticForkAgent(): AgentDefinition {
  return {
    name: FORK_AGENT_TYPE,
    description: "inherited-context worker created from the current persisted Pi session branch",
    prompt: "",
    tools: ["*"],
    readonly: false,
    shellPolicy: "unrestricted",
    context: "fork",
    source: "builtin",
    filePath: "<fork>",
  };
}

export function classifyDispatch(options: {
  input: AgentRequestInput;
  agents: AgentDefinition[];
  config: PiSubagentsConfig;
  mode: ParentMode;
  parentCanFork: boolean;
  depth?: number;
  parentForked?: boolean;
}): DispatchDecision {
  const requestedType = options.input.subagent_type?.trim() || "general-purpose";
  const forked = requestedType.toLowerCase() === FORK_AGENT_TYPE;
  if (forked) {
    if (!options.config.enableFork) throw new Error("Fork agents are disabled in the current configuration.");
    if (options.parentForked) throw new Error("Fork agents can launch named agents, while inherited-context branching stays at the root level.");
    if (!options.parentCanFork) throw new Error("Fork creation requires a persisted parent session branch.");
  }
  const selected = options.agents.find(agent => agent.name === requestedType)
    ?? options.agents.find(agent => agent.name.toLowerCase() === requestedType.toLowerCase())
    ?? (forked
      ? options.agents.find(agent => agent.name === "general-purpose") ?? createSyntheticForkAgent()
      : undefined);
  if (!selected) {
    const visible = [...options.agents.map(agent => agent.name), ...(options.config.enableFork ? [FORK_AGENT_TYPE] : [])];
    throw new Error(`Unknown agent '${requestedType}'. Available agents: ${visible.join(", ")}.`);
  }
  let background = options.input.run_in_background ?? selected.background ?? true;
  if (options.mode === "print" || options.mode === "json" || !options.config.enableBackground) background = false;
  if (forked && options.config.enableBackground && options.mode !== "print" && options.mode !== "json") background = true;
  return { agent: selected, forked, background, requestedType };
}

function formatAgentLine(agent: AgentDefinition): string {
  const tools = agent.tools?.length ? agent.tools.join(", ") : "role defaults";
  const model = agent.model ? `; Model: ${agent.model}` : "; Model: inherit parent";
  return `- ${agent.name}: ${agent.description} (Tools: ${tools}${model})`;
}

export function buildAgentListing(agents: AgentDefinition[], config: PiSubagentsConfig): string {
  const lines = agents.map(formatAgentLine);
  if (config.enableFork) lines.push(`- ${FORK_AGENT_TYPE}: inherited-context worker created from the current persisted Pi session branch`);
  return lines.join("\n") || "- none";
}

export function buildParentPolicy(agents: AgentDefinition[], config: PiSubagentsConfig): string {
  const list = buildAgentListing(agents, config);
  const forkSection = config.enableFork ? `
## Fork workers

Use \`subagent_type: "fork"\` when side work benefits from the current conversation, decisions, and system context, while its intermediate tool output is not worth keeping in the parent context. A Fork prompt is a directive: state what to do, scope in and out, what another worker is handling, and the expected report. Do not re-explain background already present in the inherited conversation.

Do not peek or poll. Fork completion arrives automatically. Until then, never fabricate, predict, or imply its findings. If the user asks before completion, report that it is still running. A Fork executes its own assignment directly; inherited-context branching is not recursively delegated.
` : "";
  const verificationSection = config.verificationPrompt ? `
## Independent verification

When non-trivial implementation changes ${config.verificationFileThreshold}+ files or affects backend/API behavior, infrastructure, migrations, security, concurrency, persistence, or another high-risk path, run a fresh \`verification\` agent before reporting completion, without waiting for the user to request verification. You own this gate regardless of who implemented the change.

Pass the original request, all changed files, the approach, plan/spec references, and concerns. Do not prime the verifier with implementation test results or claims that the work succeeds. On FAIL, fix the issue and use SendMessage to resume the same verifier after fixes, including its findings and the concrete correction. On PASS, spot-check two or three decisive commands and confirm the reported output. On PARTIAL, state what was verified and what the environment prevented.
` : "";

  return `# Subagent orchestration

The parent owns the user request, understanding, technical decisions, synthesis, final validation, and delivery. Agents provide focused investigation, implementation, planning research, or independent verification. Agent results are not a final user response: read them, decide what they establish, and relay a concise synthesis to the user.

## When to delegate immediately

Delegate open-ended, cross-module, context-heavy, or path-uncertain investigation early. Launch an \`Explore\` or matching specialist before spending a large parent-context search budget when the right files, code path, or answer will require several search attempts. Prefer a root Fork when the work benefits materially from the current conversation and decisions; prefer a named Fresh agent for a specialist role, an independent opinion, or an unbiased context.

Delegate implementation expected to require more than a couple of edits, an isolated working context, broad validation, or substantial intermediate tool output, unless the work is tightly scoped and direct execution is clearly cheaper.

## Parallel fan-out

When two or more questions are genuinely independent, immediately launch them together in one \`Agent\` call with a \`tasks\` array instead of investigating them serially. For broad cross-module research, use two or three non-overlapping angles when they add real coverage: implementation and data flow; callers and integration impact; tests and repository conventions. Do not manufacture fan-out for a single lookup, and do not give siblings overlapping scopes.

Parallel writers must use separate worktrees. Writers that touch the same files run sequentially.

## Dependent sequencing

When research determines the implementation, obtain and synthesize the research result before assigning implementation. The parent then writes a concrete implementation brief with exact paths, established behavior, required changes, constraints, and validation. Never delegate understanding or tell a child merely to implement "based on the findings."

Use foreground execution when the result is required before the next parent action. For a background dependency, end the turn and wait for automatic completion rather than acting without the result.

## When to stay direct

Handle a known file read, a specific symbol or small match set, inspection within two or three known files, and a small edit directly with Pi's read, grep, find, ls, edit, or write tools. Also stay direct when no available agent role fits. Delegation should remove context-heavy or parallel work, not add ceremony to a tighter direct action.

## Background timing

Interactive Pi launches independent work in the background by default. After launch, briefly state what is running, continue only with genuinely independent non-overlapping work, or end the turn and wait for completion notifications. Completion is delivered automatically. Do not poll, peek at output artifacts, duplicate the assignment, predict results, or imply success while a child is running. Use \`run_in_background: false\` when the result is required before the current tool call can proceed. Use TaskOutput only for an explicit user-requested progress check or operational diagnosis.

Do not duplicate work already delegated: if an agent owns a research question or file scope, the parent and sibling agents should not repeat it unless independently verifying the result.

## Writing a Fresh-agent brief

A named agent starts with no conversation history. Brief it like a capable colleague entering the task now:

- explain the goal and why it matters;
- provide relevant facts, exact paths, errors, interfaces, and constraints;
- state what is already known, tried, or ruled out;
- define scope, allowed changes, success criteria, validation, and output length or shape;
- for a lookup, provide the exact thing to find; for an investigation, provide the question and judgment context.

Never delegate understanding. Do not write "based on your findings, implement the fix" or "based on the research, change it." Read the findings first: the parent converts research into concrete follow-up instructions that prove understanding with specific paths, behavior, and required changes.

## Progress supervision

The root Agent call chooses explicit positive warning_turns and warning_interval_turns for the actual assignment. These values express when parent supervision becomes useful, not how long the child is allowed to run.

Choose the schedule from expected scope, uncertainty, drift risk, tool cost, external waiting, and visibility of intermediate progress:
- narrow lookup, fixed-file inspection, or high stall/drift risk: first review around 8-12 turns, then every 5-8;
- routine code investigation with a reasonably clear path: first review around 15-25 turns, then every 8-12;
- broad cross-module research: first review around 25-35 turns, then every 12-20;
- multi-file implementation and validation with visible progress: first review around 30-45 turns, then every 15-25;
- deployment, network, external commands, repeated retries, or expensive actions: prefer an earlier 10-15 turn review and a 5-10 turn interval.

Choose deliberately within or outside these ranges when the assignment warrants it; do not mechanically reuse one pair across unrelated tasks. In a tasks array, child entries inherit the top-level schedule unless a child's scope or risk materially differs. Long-running children emit progress-warning checkpoints to the root parent at the supplied first turn and interval. A progress warning is a supervision checkpoint, not a failure: inspect once with TaskOutput, then deliberately continue, steer via SendMessage, or stop via TaskStop based on evidence. Foreground launches release back as a supervised running task on the first warning while the child keeps working; subsequent warnings arrive as follow-up messages. Hard budgets remain available only as explicit unattended policy on custom agent frontmatter or runtime config, not as ordinary invocation arguments.

## Continue or start Fresh

Use SendMessage when the same agent's loaded files, hypotheses, recent errors, or execution state help with the next step. Start Fresh for an independent opinion, a different specialist role, a narrow task after broad noisy exploration, or a retry where the prior approach would anchor the worker incorrectly. Explore and Plan are one-shot; start a new one for a separate assignment.
${forkSection}${verificationSection}
## Nested delegation

A named agent may launch a named agent only when Agent is in its effective tool set and the subtask is genuinely independent or better matched to a specialist. The direct parent must understand and synthesize the nested result. Nesting is bounded at depth ${config.maxAgentDepth}, shares the root concurrency quota, and cannot create a nested Fork.

Available agent types:
${list}`;
}

export function buildAgentToolDescription(agents: AgentDefinition[], config: PiSubagentsConfig): string {
  return `Launch a specialized agent in an isolated Pi session for complex, multi-step, context-heavy, or genuinely parallel work.

Available agent types are provided in the current <agent-listing> reminder. Named agents start fresh with no parent conversation; provide a complete briefing. Omit subagent_type for general-purpose. Use subagent_type: "fork" only for a root-session worker that must inherit the current persisted conversation and decisions.

When to delegate:
- Delegate open-ended, cross-module, or path-uncertain investigation early, before extensive parent-context searching.
- When two or more independent questions exist, launch them immediately in one tasks-array call with non-overlapping scopes.
- Delegate implementation that needs more than a couple of edits, isolation, broad validation, or substantial intermediate tool output unless it is tightly scoped.
- If research determines implementation, wait for it, synthesize it, and then issue a concrete implementation brief.

When not to use Agent:
- reading a known file: use read;
- finding a specific symbol or small set of matches: use grep or find;
- inspecting two or three known files or making a small edit: use direct Pi tools;
- work unrelated to an available agent description.

Usage:
- omit model to use the selected agent's configured model; use model only for a deliberate, known Pi model override;
- description is a 3-5 word summary;
- a tasks array launches up to ${config.maxTasksPerLaunch} independent tasks together; use one Agent call for parallel work;
- every root call chooses positive warning_turns and warning_interval_turns for that assignment rather than copying a universal pair;
- choose earlier/more frequent review for narrow, uncertain, drift-prone, externally blocked, repetitive, or expensive work, and later/less frequent review for broad implementation with visible progress;
- practical ranges: narrow/high-risk 8-12 then 5-8; routine investigation 15-25 then 8-12; broad research 25-35 then 12-20; multi-file implementation 30-45 then 15-25; external/deployment work 10-15 then 5-10;
- tasks-array children inherit the top-level schedule unless a child's scope or risk materially differs;
- progress warnings are supervision checkpoints: inspect once with TaskOutput, then continue, SendMessage, or TaskStop based on evidence;
- interactive launches run in the background by default; completion is automatic, so do not poll, peek, duplicate, or predict a running agent's result;
- after a background launch, do only non-overlapping work or end the turn;
- set run_in_background: false when results are required before the call returns; the first progress warning releases that wait while the child keeps running;
- use SendMessage to continue a live or persisted resumable agent;
- set isolation: "worktree" for an isolated Git working copy when parallel writers are necessary;
- the child returns one handoff to the caller; synthesize it for the user rather than forwarding raw output.

Fresh briefs explain the goal and why, known evidence, exact paths and errors, scope, allowed changes, success criteria, validation, and expected response. Never delegate understanding: synthesize research into concrete follow-up instructions before assigning implementation.

Agent types:
${buildAgentListing(agents, config)}`;
}

export function buildChildBoundary(options: {
  agent: AgentDefinition;
  forked: boolean;
  cwd: string;
  parentCwd?: string;
  worktree?: boolean;
  depth?: number;
  maxDepth?: number;
}): string {
  if (options.forked) {
    const worktreeNotice = options.worktree && options.parentCwd
      ? `\n\nWorktree isolation:\n- The inherited conversation refers to the parent checkout at ${options.parentCwd}.\n- Your isolated working copy is ${options.cwd}. Translate inherited absolute paths from the parent root to the same relative path under the worktree root.\n- Re-read a file in the worktree before editing it. Do not write to the parent checkout. Changes in the worktree are not merged automatically.`
      : "";
    return `# Fork worker directive

You are an inherited-context worker, not the root agent. Execute the assignment directly with the available tools.

Rules:
1. Stay strictly within the directive's scope and preserve unrelated user changes.
2. Do not ask the user questions, converse with the user, or suggest follow-up work. Report a blocking decision to the parent.
3. Do not spawn another Fork. Use a named agent only for a genuinely independent specialist subtask, if Agent is available.
4. Do not fabricate or predict sibling or parent results. Use repository tools for facts and execution evidence.
5. If you modify files, validate the result. If working in an isolated worktree, report its path and branch; do not merge it yourself.
6. Keep the final handoff concise and factual. Use absolute paths.

Final handoff:
Scope: <assigned scope in one sentence>
Result: <answer, implementation result, or key findings>
Key files: <relevant absolute paths>
Files changed: <absolute paths and validation, only if changed>
Issues: <blockers or material risks, only if present>

Working directory: ${options.cwd}${worktreeNotice}`;
  }

  const access = options.agent.readonly
    ? "This is a read-only role. Do not create, edit, delete, move, or copy files. Use only inspection and validation operations allowed by the runtime."
    : "You may modify files only within the assigned scope. Preserve unrelated user changes and validate the delivered behavior.";
  const delegation = (options.depth ?? 1) < (options.maxDepth ?? 5)
    ? "If Agent is available, use it only for a genuinely independent subtask or a better-matched specialist. Do not delegate your understanding of the assignment; integrate the result yourself."
    : "This assignment is at the nesting limit. Complete it directly without another agent.";

  return `# Child execution boundary

You are a focused worker in a Fresh Pi session. You have not seen the parent's conversation. Complete the assignment fully without expanding its scope or gold-plating it. Your final response is a handoff to the parent, not a message to the user.

Rules:
- ${access}
- Use tools for repository facts and execution evidence; do not claim checks you did not run.
- ${delegation}
- Use absolute paths in the handoff.
- Report the result, important findings or changed files, validation commands and observed outcomes, incomplete work, blockers, and material risks.
- Keep the report concise; include code only when the exact text is necessary for the parent to act.

Working directory: ${options.cwd}`;
}
