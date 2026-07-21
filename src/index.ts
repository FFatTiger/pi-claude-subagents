import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { applyAgentModelSettings, discoverAgents, findAgent, resolvePackageRoot, type AgentDefinition } from "./agents.ts";
import { agentAllowsNestedAgents, type ToolDescriptor } from "./capabilities.ts";
import { loadAgentModelSettings, loadConfig, type PiSubagentsConfig } from "./config.ts";
import { buildAgentListing, buildAgentToolDescription, buildParentPolicy, classifyDispatch, resolveTaskIsolation } from "./prompts.ts";
import { launchTask, resumeCompletedTask, createTaskQuota, type LaunchSpec, type ParentLaunchContext } from "./runtime.ts";
import {
  cleanupExpiredTasks,
  formatTaskTargetError,
  formatTaskOutputForModel,
  loadTaskRecords,
  persistTask,
  resolveTaskTarget,
  type LiveTask,
  type TaskRecord,
} from "./tasks.ts";

const packageRoot = resolvePackageRoot(import.meta.url);

interface TaskDetails {
  tasks: TaskRecord[];
}

const TaskSpecSchema = Type.Object({
  description: Type.String({ description: "Short 3-5 word task summary" }),
  prompt: Type.String({ description: "Complete task briefing for the child agent" }),
  subagent_type: Type.Optional(Type.String({ description: "Specialized agent type. Omit for general-purpose; use 'fork' to inherit the current conversation." })),
  model: Type.Optional(Type.String({ description: "Deliberate override using a known Pi model reference. Omit to use the selected agent's configured model." })),
  thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)),
  run_in_background: Type.Optional(Type.Boolean({ description: "Run independently in background when the current mode supports it" })),
  isolation: Type.Optional(StringEnum(["none", "worktree"] as const, { description: "Optional task isolation. Use none unless worktree isolation is explicitly required." })),
  cwd: Type.Optional(Type.String({ description: "Working directory; defaults to parent cwd" })),
  name: Type.Optional(Type.String({ description: "Optional addressable task name" })),
  timeout_ms: Type.Optional(Type.Number({ minimum: 1000 })),
  max_turns: Type.Optional(Type.Number({ minimum: 1 })),
  max_tool_calls: Type.Optional(Type.Number({ minimum: 1 })),
});

const AgentParams = Type.Object({
  description: Type.Optional(Type.String()),
  prompt: Type.Optional(Type.String()),
  subagent_type: Type.Optional(Type.String()),
  model: Type.Optional(Type.String({ description: "Deliberate override using a known Pi model reference. Omit to use the selected agent's configured model." })),
  thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)),
  run_in_background: Type.Optional(Type.Boolean()),
  isolation: Type.Optional(StringEnum(["none", "worktree"] as const, { description: "Optional task isolation. Use none unless worktree isolation is explicitly required." })),
  cwd: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  timeout_ms: Type.Optional(Type.Number({ minimum: 1000 })),
  max_turns: Type.Optional(Type.Number({ minimum: 1 })),
  max_tool_calls: Type.Optional(Type.Number({ minimum: 1 })),
  tasks: Type.Optional(Type.Array(TaskSpecSchema)),
});

const SendMessageParams = Type.Object({
  to: Type.String({ description: "Task ID, unique ID prefix, or task name" }),
  message: Type.String({ description: "Follow-up instruction" }),
});

const TaskOutputParams = Type.Object({
  task_id: Type.String(),
  block: Type.Optional(Type.Boolean({ default: false })),
  timeout_ms: Type.Optional(Type.Number({ minimum: 1, default: 300_000 })),
});

const TaskStopParams = Type.Object({ task_id: Type.String() });

function compactAgentParams<T extends {
  tasks?: unknown[];
  model?: string;
  name?: string;
  cwd?: string;
  isolation?: string;
  thinking?: string;
  max_turns?: number;
  max_tool_calls?: number;
  timeout_ms?: number;
}>(params: T): T {
  const compacted = { ...params };
  if (!compacted.tasks?.length) delete compacted.tasks;
  if (!compacted.model?.trim()) delete compacted.model;
  if (!compacted.name?.trim()) delete compacted.name;
  if (!compacted.cwd?.trim()) delete compacted.cwd;
  if (compacted.isolation !== "worktree" && compacted.isolation !== "none") delete compacted.isolation;
  return compacted;
}

function normalizeOptionalModel(model: string | undefined, parentModel: string | undefined): string | undefined {
  const value = model?.trim();
  if (!value || value === "default" || value === "inherit" || value === parentModel) return undefined;
  return value;
}

function taskResult(tasks: TaskRecord[], text: string, isError = false): AgentToolResult<TaskDetails> {
  return { content: [{ type: "text", text: isError ? `ERROR: ${text}` : text }], details: { tasks } };
}

function xmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export interface CompletionDeduper {
  beginInvocation(taskId: string): void;
  shouldHandle(taskId: string): boolean;
}

export function createCompletionDeduper(): CompletionDeduper {
  const handled = new Set<string>();
  return {
    beginInvocation(taskId) { handled.delete(taskId); },
    shouldHandle(taskId) {
      if (handled.has(taskId)) return false;
      handled.add(taskId);
      return true;
    },
  };
}

export function formatTaskDiagnostic(record: TaskRecord): string {
  const lines = [
    `task: ${record.id} ${record.description}`,
    `termination: ${record.terminationKind ?? "unknown"} (${record.status})`,
    `usage.tools: requested=${record.usage.toolCallsRequested} executed=${record.usage.toolCallsExecuted} blocked=${record.usage.toolCallsBlocked}`,
  ];
  if (record.requestedThinking || record.effectiveThinking || record.thinking) {
    lines.push(`thinking: requested=${record.requestedThinking ?? "default"} effective=${record.effectiveThinking ?? record.thinking ?? "unknown"}${record.thinkingClampReason ? ` reason=${record.thinkingClampReason}` : ""}`);
  }
  return lines.join("\n");
}

export function taskNotification(record: TaskRecord, result: string, includeUsage = true): string {
  const sections = [
    "<task-notification>",
    `<task-id>${xmlText(record.id)}</task-id>`,
    `<status>${record.status}</status>`,
    `<summary>${xmlText(record.description)}</summary>`,
    `<output-file>${xmlText(record.outputFile)}</output-file>`,
  ];
  if (record.terminationKind) sections.push(`<termination>${record.terminationKind}</termination>`);
  if (includeUsage) {
    const usage = record.usage;
    sections.push(`<usage><input_tokens>${usage.input}</input_tokens><output_tokens>${usage.output}</output_tokens><cache_read_tokens>${usage.cacheRead}</cache_read_tokens><cache_write_tokens>${usage.cacheWrite}</cache_write_tokens><tool_uses>${usage.toolCalls}</tool_uses><tool_calls_requested>${usage.toolCallsRequested}</tool_calls_requested><tool_calls_executed>${usage.toolCallsExecuted}</tool_calls_executed><tool_calls_blocked>${usage.toolCallsBlocked}</tool_calls_blocked><turns>${usage.turns}</turns><cost_usd>${usage.cost.toFixed(6)}</cost_usd></usage>`);
  }
  if (record.error) sections.push(`<error>${xmlText(record.error)}</error>`);
  if (record.worktreePath || record.worktreeBranch) {
    sections.push(`<worktree><path>${xmlText(record.worktreePath ?? "")}</path><branch>${xmlText(record.worktreeBranch ?? "")}</branch></worktree>`);
  }
  sections.push(`<result>${xmlText(result)}</result>`, "</task-notification>");
  return sections.join("\n");
}

function currentParent(pi: ExtensionAPI, ctx: ExtensionContext): ParentLaunchContext {
  const activeTools = new Set(pi.getActiveTools());
  return {
    parentSessionId: ctx.sessionManager.getSessionId(),
    rootParentSessionId: ctx.sessionManager.getSessionId(),
    depth: 0,
    parentSessionFile: ctx.sessionManager.getSessionFile(),
    parentLeafId: ctx.sessionManager.getLeafId(),
    parentModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    parentThinking: pi.getThinkingLevel(),
    parentSystemPrompt: ctx.getSystemPrompt(),
    toolInventory: pi.getAllTools()
      .filter(tool => activeTools.has(tool.name))
      .map(tool => ({
        name: tool.name,
        source: tool.sourceInfo.source,
        path: tool.sourceInfo.path,
        scope: tool.sourceInfo.scope,
      } satisfies ToolDescriptor)),
    availableModels: ctx.modelRegistry.getAvailable().map(model => ({ provider: model.provider, id: model.id })),
    projectTrusted: ctx.isProjectTrusted(),
  };
}

function resolveRequestedModel(modelRef: string, registry: ExtensionContext["modelRegistry"]): string {
  const value = modelRef.trim();
  if (!value) throw new Error("Model reference is empty.");
  const slash = value.indexOf("/");
  if (slash > 0) {
    const found = registry.find(value.slice(0, slash), value.slice(slash + 1));
    if (found) return `${found.provider}/${found.id}`;
  }
  const models = registry.getAvailable().length > 0 ? registry.getAvailable() : registry.getAll();
  const exact = models.filter(model => model.id === value || `${model.provider}/${model.id}` === value);
  if (exact.length === 1) return `${exact[0].provider}/${exact[0].id}`;
  if (exact.length > 1) throw new Error(`Model '${modelRef}' is ambiguous in the current Pi model registry.`);
  const partial = models.filter(model => model.id.includes(value) || `${model.provider}/${model.id}`.includes(value));
  if (partial.length === 1) return `${partial[0].provider}/${partial[0].id}`;
  if (partial.length > 1) throw new Error(`Model '${modelRef}' is ambiguous in the current Pi model registry.`);
  throw new Error(`Model '${modelRef}' is not available in the current Pi model registry.`);
}

function normalizeTask(input: {
  description?: string;
  prompt?: string;
  subagent_type?: string;
  model?: string;
  thinking?: string;
  run_in_background?: boolean;
  isolation?: "none" | "worktree";
  cwd?: string;
  name?: string;
  timeout_ms?: number;
  max_turns?: number;
  max_tool_calls?: number;
}, agents: AgentDefinition[], config: PiSubagentsConfig, ctx: ExtensionContext): LaunchSpec {
  if (!input.description?.trim() || !input.prompt?.trim()) throw new Error("description and prompt are required");
  const dispatchInput = { ...input, isolation: input.isolation === "worktree" ? "worktree" as const : undefined };
  const decision = classifyDispatch({
    input: dispatchInput,
    agents,
    config,
    mode: ctx.mode,
    parentCanFork: Boolean(ctx.sessionManager.getSessionFile() && ctx.sessionManager.getLeafId()),
    depth: 0,
  });
  const selected = decision.agent;
  const forked = decision.forked;
  const isolation = resolveTaskIsolation(input.isolation, selected.isolation);
  if (isolation === "worktree" && !config.enableWorktrees) throw new Error("worktree isolation is disabled");
  const requestedModel = normalizeOptionalModel(input.model, ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
  const model = requestedModel ? resolveRequestedModel(requestedModel, ctx.modelRegistry) : undefined;
  return {
    agent: selected,
    prompt: input.prompt.trim(),
    description: input.description.trim(),
    cwd: path.resolve(ctx.cwd, input.cwd ?? "."),
    background: decision.background,
    forked,
    model,
    thinking: input.thinking?.trim() || undefined,
    timeoutMs: input.timeout_ms ?? selected.timeoutMs ?? config.defaultTimeoutMs,
    maxTurns: input.max_turns ?? selected.maxTurns ?? config.defaultMaxTurns,
    graceTurns: selected.graceTurns ?? config.defaultGraceTurns,
    maxToolCalls: input.max_tool_calls ?? selected.maxToolCalls ?? config.defaultMaxToolCalls,
    softToolCalls: selected.softToolCalls ?? config.defaultSoftToolCalls,
    toolBudgetBlock: selected.toolBudgetBlock ?? config.defaultToolBudgetBlock,
    isolation,
    toolInventory: undefined,
    allowNestedAgent: config.enableNestedAgents && agentAllowsNestedAgents(selected) && config.maxAgentDepth > 1 && !forked,
    name: input.name,
  };
}

export default function register(pi: ExtensionAPI): void {
  let currentConfig = loadConfig(process.cwd(), false).config;
  let initialDiscovery = discoverAgents({ cwd: process.cwd(), packageRoot, includeProject: false });
  let initialModels = loadAgentModelSettings(process.cwd(), false);
  let initialApplied = applyAgentModelSettings(initialDiscovery.agents, initialModels.settings);
  let currentAgents = initialApplied.agents;
  let currentDiagnostics = [...initialDiscovery.diagnostics, ...initialModels.diagnostics, ...initialApplied.diagnostics];
  let parentSessionId = "unknown";
  const live = new Map<string, LiveTask>();
  const known = new Map<string, TaskRecord>();
  const taskQuota = createTaskQuota(currentConfig.maxConcurrentTasks);
  const quotaTasks = new Set<string>();
  const completionDeduper = createCompletionDeduper();

  const reload = (ctx: ExtensionContext) => {
    const includeProject = ctx.isProjectTrusted();
    const loadedConfig = loadConfig(ctx.cwd, includeProject);
    const discovered = discoverAgents({ cwd: ctx.cwd, packageRoot, includeProject });
    const modelSettings = loadAgentModelSettings(ctx.cwd, includeProject);
    const applied = applyAgentModelSettings(discovered.agents, modelSettings.settings);
    currentConfig = loadedConfig.config;
    taskQuota.setLimit(currentConfig.maxConcurrentTasks);
    currentAgents = applied.agents;
    currentDiagnostics = [...loadedConfig.diagnostics, ...discovered.diagnostics, ...modelSettings.diagnostics, ...applied.diagnostics];
    parentSessionId = ctx.sessionManager.getSessionId();
    known.clear();
    const records = loadTaskRecords(parentSessionId);
    for (const record of records) {
      if (record.status === "running" && !live.has(record.id)) {
        record.status = "failed";
        record.error = "Task was orphaned by a previous Pi process or session reload.";
        record.completedAt = new Date().toISOString();
        void persistTask(record);
      }
      known.set(record.id, record);
    }
    for (const diagnostic of currentDiagnostics) {
      if (ctx.hasUI) ctx.ui.notify(diagnostic, "warning");
    }
  };

  const notifyCompletion = (record: TaskRecord) => {
    if (!completionDeduper.shouldHandle(record.id)) return;
    if (quotaTasks.delete(record.id)) taskQuota.release();
    known.set(record.id, record);
    live.delete(record.id);
    if (record.parentTaskId || !record.background) return;
    const result = formatTaskOutputForModel(record, {
      bytes: currentConfig.maxOutputBytes,
      lines: currentConfig.maxOutputLines,
    });
    pi.sendMessage({
      customType: "pi-subagent-notification",
      content: taskNotification(record, result),
      display: true,
      details: record,
    }, { triggerTurn: true, deliverAs: "followUp" });
  };

  const finalizeForegroundTask = (record: TaskRecord) => {
    if (!completionDeduper.shouldHandle(record.id)) return;
    if (quotaTasks.delete(record.id)) taskQuota.release();
    known.set(record.id, record);
    live.delete(record.id);
  };

  pi.on("session_start", (_event, ctx) => {
    reload(ctx);
    void cleanupExpiredTasks(currentConfig.cleanupPeriodDays);
  });

  pi.on("before_agent_start", (event, ctx) => {
    reload(ctx);
    if (!currentConfig.proactivePrompt) return;
    return {
      message: {
        customType: "pi-subagent-agent-listing",
        content: `<agent-listing>\n${buildAgentListing(currentAgents, currentConfig)}\n</agent-listing>`,
        display: false,
      },
      systemPrompt: `${event.systemPrompt}\n\n${buildParentPolicy(currentAgents, currentConfig)}`,
    };
  });

  pi.on("session_shutdown", () => {
    for (const task of live.values()) void task.stop("parent_shutdown");
    live.clear();
  });

  pi.registerMessageRenderer<TaskRecord>("pi-subagent-notification", (message, options, theme) => {
    const record = message.details as TaskRecord | undefined;
    if (!record) return new Text(typeof message.content === "string" ? message.content : "Subagent finished", 0, 0);
    const icon = record.status === "completed"
      ? theme.fg("success", "✓")
      : record.status === "partial" || record.status === "stopped"
        ? theme.fg("warning", record.status === "partial" ? "◐" : "■")
        : theme.fg("error", "✗");
    const preview = options.expanded
      ? formatTaskOutputForModel(record, { bytes: currentConfig.maxOutputBytes, lines: currentConfig.maxOutputLines })
      : record.preview ?? record.error ?? "(no output)";
    return new Text(`${icon} ${theme.bold(record.description)} ${theme.fg("dim", record.status)}\n  ${theme.fg("dim", preview)}`, 0, 0);
  });

  pi.registerTool({
    name: "Agent",
    label: "Agent",
    promptSnippet: "Launch a focused child agent",
    promptGuidelines: [
      "Delegate open-ended, cross-module, context-heavy, or path-uncertain investigation early, before extensive parent-context searching. Keep known-file reads, specific symbol lookups, two-or-three-known-file inspection, and small edits direct.",
      "When two or more questions are genuinely independent, launch them immediately in one Agent call with a tasks array and non-overlapping scopes. If research determines implementation, wait for it, synthesize it, then issue a concrete implementation brief.",
      "Delegate implementation needing more than a couple of edits, isolation, broad validation, or substantial intermediate tool output unless it is tightly scoped and direct execution is clearly cheaper.",
      "Named agents start Fresh. Explain the goal and why, known evidence and ruled-out paths, exact files/errors, scope, success criteria, validation, and expected response. Never delegate understanding: synthesize research into concrete implementation instructions.",
      "In interactive Pi, Agent launches in the background by default. Do not poll, peek, duplicate, or predict the result. Continue only non-overlapping work, or briefly state what is running and end the turn.",
      "Use subagent_type: fork only for root-session work that needs the persisted conversation and decisions. Normal tasks inherit role and runtime defaults; set timeout, turn, or tool budgets only for intentionally bounded probes, and leave implementation room for validation.",
    ],
    description: buildAgentToolDescription(currentAgents, currentConfig),
    parameters: AgentParams,
    executionMode: "parallel",
    async execute(_id, params, signal, onUpdate, ctx) {
      reload(ctx);
      params = compactAgentParams(params);
      const rawTasks = params.tasks?.length ? params.tasks : [params];
      if (rawTasks.length > currentConfig.maxTasksPerLaunch) return taskResult([], `Too many tasks (${rawTasks.length}); max is ${currentConfig.maxTasksPerLaunch}.`, true);
      const specs: LaunchSpec[] = [];
      const parent = {
        ...currentParent(pi, ctx),
        taskQuota,
      };
      try {
        for (const raw of rawTasks) {
          const spec = normalizeTask(raw, currentAgents, currentConfig, ctx);
          specs.push(spec);
        }
      } catch (error) {
        return taskResult([], error instanceof Error ? error.message : String(error), true);
      }
      const launched: LiveTask[] = [];
      let heldPermit = false;
      const abortLaunched = () => {
        for (const task of launched.filter(item => !item.record.background)) void task.stop("manual_stop");
      };
      signal?.addEventListener("abort", abortLaunched, { once: true });
      try {
        for (const spec of specs) {
          if (signal?.aborted) throw new Error("Agent launch aborted before all child tasks started.");
          await taskQuota.acquire(1, signal ?? undefined);
          heldPermit = true;
          try {
            const task = await launchTask({
              spec,
              parent,
              config: currentConfig,
              agents: currentAgents,
              onComplete: spec.background ? notifyCompletion : finalizeForegroundTask,
              onTaskStarted: nested => {
                known.set(nested.record.id, nested.record);
                live.set(nested.record.id, nested);
                quotaTasks.add(nested.record.id);
              },
              onUpdate: record => onUpdate?.(taskResult([record], `${record.description}: ${record.preview ?? "running"}`)),
            });
            known.set(task.record.id, task.record);
            live.set(task.record.id, task);
            completionDeduper.beginInvocation(task.record.id);
            quotaTasks.add(task.record.id);
            launched.push(task);
            heldPermit = false;
          } catch (error) {
            if (heldPermit) {
              taskQuota.release();
              heldPermit = false;
            }
            throw error;
          }
        }
      } catch (error) {
        signal?.removeEventListener("abort", abortLaunched);
        for (const task of launched) task.abortController.abort("sibling task failed during launch");
        await Promise.allSettled(launched.map(task => task.promise));
        if (heldPermit) {
          taskQuota.release();
          heldPermit = false;
        }
        return taskResult(launched.map(task => task.record), error instanceof Error ? error.message : String(error), true);
      }
      signal?.removeEventListener("abort", abortLaunched);
      const foreground = launched.filter(task => !task.record.background);
      if (foreground.length > 0) await Promise.all(foreground.map(task => task.promise));
      const summaries = launched.map(task => {
        return task.record.background
          ? `Async agent launched successfully.\ntask_id: ${task.record.id} (internal operational ID; do not mention it to the user)\noutput_file: ${task.record.outputFile}\nThe agent is running in the background and completion will be delivered automatically. Do not sleep, poll TaskOutput, or duplicate this task. Continue only with non-overlapping work, or briefly tell the user what was launched and end the turn.`
          : `### ${task.record.description}\n${formatTaskOutputForModel(task.record, {
            bytes: currentConfig.maxOutputBytes,
            lines: currentConfig.maxOutputLines,
          })}`;
      });
      return taskResult(launched.map(task => task.record), summaries.join("\n\n"));
    },
    renderCall(args, theme) {
      const count = args.tasks?.length ?? 1;
      const label = count > 1 ? `${count} tasks` : args.subagent_type ?? "general-purpose";
      return new Text(`${theme.fg("toolTitle", theme.bold("Agent "))}${theme.fg("accent", label)}`, 0, 0);
    },
    renderResult(result, _options, theme) {
      const tasks = (result.details as TaskDetails | undefined)?.tasks ?? [];
      const lines = tasks.map(task => {
        const icon = task.status === "completed"
          ? theme.fg("success", "✓")
          : task.status === "running" || task.status === "partial" || task.status === "stopped"
            ? theme.fg("warning", task.status === "running" ? "…" : task.status === "partial" ? "◐" : "■")
            : theme.fg("error", "✗");
        return `${icon} ${task.description} ${theme.fg("dim", task.id.slice(0, 8))}`;
      });
      const fallback = result.content.find(item => item.type === "text")?.text ?? "(no output)";
      return new Text(lines.length ? lines.join("\n") : fallback, 0, 0);
    },
  });

  pi.registerTool({
    name: "SendMessage",
    label: "Send Message",
    description: "Continue or steer an existing child agent using its task ID, unique prefix, or assigned name. Use this when the agent's loaded files, hypotheses, recent errors, or execution state remain useful. Live tasks receive the message in their current session; completed resumable tasks reopen the persisted child session. Start Fresh instead for an independent opinion, a different role, or a retry that should not inherit a failed approach.",
    parameters: SendMessageParams,
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const resolution = resolveTaskTarget([...known.values()], params.to);
      if (resolution.kind !== "found") return taskResult([], formatTaskTargetError(resolution), true);
      const record = resolution.task;
      if (record.oneShot) return taskResult([record], `${record.agent} uses one-shot execution. Start a new ${record.agent} task for the next assignment.`, true);
      if (record.worktreeCleaned) return taskResult([record], `Task ${record.id} used an isolated worktree that was cleaned after a no-change run. Start a new isolated task instead of resuming it.`, true);
      const liveTask = live.get(record.id);
      if (liveTask) {
        await liveTask.send(params.message);
        return taskResult([record], `Message delivered to ${record.description}.`);
      }
      const agent = findAgent(currentAgents, record.agent);
      if (!agent) return taskResult([record], `Agent definition no longer exists: ${record.agent}`, true);
      try {
        await taskQuota.acquire(1, signal ?? undefined);
      } catch (error) {
        return taskResult([record], error instanceof Error ? error.message : String(error), true);
      }
      try {
        completionDeduper.beginInvocation(record.id);
        const resumed = await resumeCompletedTask({
          record,
          message: params.message,
          agent,
          agents: currentAgents,
          parent: {
            ...currentParent(pi, ctx),
            parentSessionId: record.rootParentSessionId ?? record.parentSessionId,
            rootParentSessionId: record.rootParentSessionId ?? record.parentSessionId,
            parentTaskId: record.parentTaskId,
            depth: Math.max(0, (record.depth ?? 1) - 1),
            taskQuota,
          },
          config: currentConfig,
          onTaskStarted: nested => {
            known.set(nested.record.id, nested.record);
            live.set(nested.record.id, nested);
            quotaTasks.add(nested.record.id);
          },
          onComplete: notifyCompletion,
        });
        live.set(record.id, resumed);
        quotaTasks.add(record.id);
        return taskResult([record], `Resumed ${record.description} in background.`);
      } catch (error) {
        taskQuota.release();
        return taskResult([record], error instanceof Error ? error.message : String(error), true);
      }
    },
  });

  pi.registerTool({
    name: "TaskOutput",
    label: "Task Output",
    description: "Read a child task snapshot or explicitly wait for completion. Background completion is delivered automatically, so do not use TaskOutput as a polling loop. Use it only when the user explicitly requests progress/status or for operational diagnosis.",
    parameters: TaskOutputParams,
    executionMode: "parallel",
    async execute(_id, params, signal) {
      const resolution = resolveTaskTarget([...known.values()], params.task_id);
      if (resolution.kind !== "found") return taskResult([], formatTaskTargetError(resolution), true);
      const record = resolution.task;
      const liveTask = live.get(record.id);
      if (params.block && liveTask) {
        const timeoutMs = params.timeout_ms ?? 300_000;
        await Promise.race([
          liveTask.promise,
          new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => resolve(), timeoutMs);
            signal?.addEventListener("abort", () => { clearTimeout(timeout); reject(new Error("TaskOutput aborted")); }, { once: true });
          }),
        ]);
      }
      const current = known.get(record.id) ?? liveTask?.record ?? record;
      return taskResult([current], `status: ${current.status}\ntask_id: ${current.id}\noutput_file: ${current.outputFile}\n\n${formatTaskOutputForModel(current, {
        bytes: currentConfig.maxOutputBytes,
        lines: currentConfig.maxOutputLines,
      })}`);
    },
  });

  pi.registerTool({
    name: "TaskStop",
    label: "Task Stop",
    description: "Stop a running child task. Partial output is preserved when available.",
    parameters: TaskStopParams,
    executionMode: "sequential",
    async execute(_id, params) {
      const resolution = resolveTaskTarget([...known.values()], params.task_id);
      if (resolution.kind !== "found") return taskResult([], formatTaskTargetError(resolution), true);
      const record = resolution.task;
      const task = live.get(record.id);
      if (!task) return taskResult([record], `Task ${record.id} is not running.`);
      await task.stop("manual_stop");
      const stopped = await task.promise;
      const current = known.get(stopped.id) ?? stopped;
      return taskResult([current], `Stopped ${current.description}.\n${formatTaskOutputForModel(current, {
        bytes: currentConfig.maxOutputBytes,
        lines: currentConfig.maxOutputLines,
      })}`);
    },
  });

  pi.registerCommand("agents", {
    description: "List Pi subagents and current tasks",
    handler: async (_args, ctx) => {
      reload(ctx);
      const agents = currentAgents.map(agent => `${agent.name} — ${agent.description}`).join("\n");
      const tasks = [...known.values()].slice(0, 20).map(task => `${task.status.padEnd(9)} ${task.id.slice(0, 8)} ${task.description}`).join("\n");
      ctx.ui.notify(`Agents:\n${agents || "none"}\n\nRecent tasks:\n${tasks || "none"}`, "info");
    },
  });

  pi.registerCommand("pi-subagents-doctor", {
    description: "Inspect pi-claude-subagents discovery and configuration",
    handler: async (_args, ctx) => {
      reload(ctx);
      const report = [
        `package: ${packageRoot}`,
        `agentDir: ${getAgentDir()}`,
        `projectTrusted: ${ctx.isProjectTrusted()}`,
        `agents: ${currentAgents.length}`,
        ...currentAgents.map(agent => `agentModel.${agent.name}: ${agent.model ?? "inherit parent"}${agent.thinking ? ` (thinking: ${agent.thinking})` : ""}`),
        ...(currentDiagnostics.length ? ["diagnostics:", ...currentDiagnostics.map(item => `  - ${item}`)] : []),
        `liveTasks: ${live.size}`,
        `sessionId: ${parentSessionId}`,
        `background: ${currentConfig.enableBackground}`,
        `fork: ${currentConfig.enableFork}`,
        `worktrees: ${currentConfig.enableWorktrees}`,
        ...[...known.values()].slice(0, 5).flatMap(record => ["", formatTaskDiagnostic(record)]),
      ].join("\n");
      ctx.ui.notify(report, "info");
    },
  });
}
