import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  defineTool,
  getAgentDir,
  resolveCliModel,
  type ExtensionFactory,
  type Skill,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentDefinition, AgentShellPolicy } from "./agents.ts";
import { agentAllowsNestedAgents, resolveAgentTools, type ToolDescriptor } from "./capabilities.ts";
import type { PiSubagentsConfig } from "./config.ts";
import {
  createChildLifecycleController,
  resolveWarningSchedule,
  type ChildLifecycleController,
  type LifecycleUsage,
  type ProgressWarning,
} from "./lifecycle.ts";
import { buildChildBoundary, resolveTaskIsolation } from "./prompts.ts";
import {
  appendTaskOutput,
  createUnpersistedTaskRecord,
  extractFinalText,
  extractInvocationText,
  formatInvocationOutput,
  formatTaskOutputForModel,
  persistTask,
  saveTaskOutput,
  type LiveTask,
  type TaskRecord,
} from "./tasks.ts";

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function shellSegments(command: string): string[] | null {
  if (!command.trim() || /[><`{}$*?\[]/.test(command)) return null;
  return command.split(/\s*(?:&&|\|\||;|\||&|\r?\n)\s*/).filter(Boolean);
}

function commandWords(segment: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;
  for (const char of segment.trim()) {
    if (escaping) {
      word += char;
      escaping = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (word) {
        words.push(word);
        word = "";
      }
      continue;
    }
    word += char;
  }
  if (escaping || quote) return null;
  if (word) words.push(word);
  if (words.some(item => /^[A-Za-z_][A-Za-z0-9_]*=/.test(item))) return null;
  return words;
}

function hasDangerousGitOption(words: string[], segment: string): boolean {
  if (/(?:^|\s)(?:GIT_EXTERNAL_DIFF|GIT_PAGER|PAGER|GIT_CONFIG(?:_GLOBAL|_SYSTEM|_COUNT|_PARAMETERS)?|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+)\s*=/.test(segment)) return true;
  return words.slice(2).some(word =>
    word === "--ext-diff"
    || word === "--textconv"
    || word === "--paginate"
    || word === "-p"
    || word === "--config-env"
    || word === "--exec-path"
    || word === "--open-files-in-pager"
    || word.startsWith("--open-files-in-pager=")
    || word === "--output"
    || word.startsWith("--output=")
  );
}

function hasDangerousInspectionOption(program: string, words: string[]): boolean {
  const args = words.slice(1);
  if (program === "rg") {
    return args.some(word => word === "--pre" || word.startsWith("--pre=") || word === "--pre-glob" || word.startsWith("--pre-glob=") || word === "--path-separator");
  }
  return false;
}

function isInspectionSegment(segment: string): boolean {
  const words = commandWords(segment);
  if (!words) return false;
  const program = words[0];
  if (!program) return false;
  if (program === "pwd") return words.length === 1;
  if (program === "ls") return !words.slice(1).some(word => word.startsWith("--quoting-style") || word === "--hyperlink" || word.startsWith("--hyperlink="));
  if (["cat", "head", "tail", "wc", "cut", "stat", "du", "grep"].includes(program)) return true;
  if (program === "uniq") return words.length <= 2;
  if (program === "git") {
    const subcommand = words[1];
    return subcommand === "status" || subcommand === "rev-parse" || subcommand === "ls-files" || (subcommand === "branch" && words.length === 3 && words[2] === "--show-current");
  }
  if (program === "sort") return words.length === 1;
  if (program === "find") return !words.some(word => /^-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(word));
  return false;
}

function isVerificationSegment(segment: string): boolean {
  if (isInspectionSegment(segment)) return true;
  const words = commandWords(segment);
  if (!words) return false;
  const program = words[0];
  const args = words.slice(1);
  if (!program) return false;
  if (["npm", "pnpm", "yarn", "bun"].includes(program)) {
    if (program === "npm" && args[0] === "pack") {
      return args.length === 2 && args[1] === "--dry-run";
    }
    const script = program === "yarn" ? args[0] : args[0] === "run" ? args[1] : args[0];
    return Boolean(script && /^(?:test|check|typecheck|lint|build)(?::[\w.-]+)?$/.test(script));
  }
  if (program === "npx") return args[0] === "tsc" && args.includes("--noEmit");
  if (program === "tsc") return args.includes("--noEmit");
  if (program === "node") return args[0] === "--test" && !args.slice(1).some(arg => arg === "--test");
  if (program === "python" || program === "python3") return args[0] === "-m" && args[1] === "pytest";
  if (program === "pytest") return true;
  if (program === "cargo") return args[0] === "test" || args[0] === "check";
  if (program === "go") return args[0] === "test";
  if (program === "make") return args.length === 0 || args.every(arg => /^(?:test|check|lint|build)$/.test(arg));
  return false;
}

export function isShellCommandAllowed(command: string, policy: AgentShellPolicy): boolean {
  if (policy === "unrestricted") return true;
  const segments = shellSegments(command);
  if (!segments) return false;
  return segments.every(segment => policy === "verify" ? isVerificationSegment(segment) : isInspectionSegment(segment));
}

export function isReadOnlyShellCommand(command: string): boolean {
  return isShellCommandAllowed(command, "inspect");
}

export function isMutatingShellCommand(command: string): boolean {
  return !isReadOnlyShellCommand(command);
}

export async function prepareForkSession(options: {
  parentSessionFile: string;
  parentLeafId: string;
  taskDir: string;
  cwd: string;
}): Promise<SessionManager> {
  if (!fs.existsSync(options.parentSessionFile)) {
    throw new Error("unable to create persisted fork session; the selected parent branch has not been durably written yet");
  }
  const durableDeadline = Date.now() + 1500;
  while (Date.now() < durableDeadline) {
    const contents = fs.readFileSync(options.parentSessionFile, "utf8");
    if (contents.includes(options.parentLeafId)) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const durableContents = fs.readFileSync(options.parentSessionFile, "utf8");
  if (!durableContents.includes(options.parentLeafId)) {
    throw new Error("unable to create persisted fork session; the selected parent branch has not been durably written yet");
  }
  const parentManager = SessionManager.open(options.parentSessionFile);
  const forked = parentManager.createBranchedSession(options.parentLeafId);
  if (!forked || !fs.existsSync(forked)) {
    throw new Error("unable to create persisted fork session; the selected parent branch has not been durably written yet");
  }
  const childSessionFile = path.join(options.taskDir, "session.jsonl");
  await fs.promises.mkdir(path.dirname(childSessionFile), { recursive: true });
  await fs.promises.rename(forked, childSessionFile);
  const sessionManager = SessionManager.open(childSessionFile, options.taskDir, options.cwd);
  const branch = sessionManager.getBranch();
  const resolvedToolCalls = new Set(
    branch
      .filter(entry => entry.type === "message" && entry.message.role === "toolResult")
      .map(entry => entry.type === "message" && entry.message.role === "toolResult" ? entry.message.toolCallId : ""),
  );
  const pendingCalls = branch
    .filter(entry => entry.type === "message" && entry.message.role === "assistant")
    .flatMap(entry => entry.type === "message" && entry.message.role === "assistant"
      ? entry.message.content.filter(part => part.type === "toolCall")
      : [])
    .filter(call => !resolvedToolCalls.has(call.id));
  for (const call of pendingCalls) {
    sessionManager.appendMessage({
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: "Fork started; this sibling tool call continues outside the child context." }],
      isError: false,
      timestamp: Date.now(),
    });
  }
  return sessionManager;
}

export interface TaskQuota {
  readonly inUse: number;
  readonly limit: number;
  setLimit(limit: number): void;
  tryAcquire(count?: number): boolean;
  acquire(count?: number, signal?: AbortSignal): Promise<void>;
  acquireDependency(signal?: AbortSignal): Promise<void>;
  release(count?: number): void;
}

export function createTaskQuota(initialLimit: number): TaskQuota {
  let limit = Math.max(1, initialLimit);
  let inUse = 0;
  const waiters: Array<{ count: number; resolve: () => void; reject: (error: Error) => void; signal?: AbortSignal; onAbort?: () => void }> = [];

  const tryStartWaiters = () => {
    while (waiters.length > 0) {
      const next = waiters[0]!;
      if (next.count > limit) {
        waiters.shift();
        if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
        next.reject(new Error(`Task quota acquire count ${next.count} exceeds limit ${limit}`));
        continue;
      }
      if (inUse + next.count > limit) break;
      waiters.shift();
      if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
      inUse += next.count;
      next.resolve();
    }
  };

  return {
    get inUse() { return inUse; },
    get limit() { return limit; },
    setLimit(value) {
      limit = Math.max(1, value);
      tryStartWaiters();
    },
    tryAcquire(count = 1) {
      if (count < 1 || count > limit || inUse + count > limit) return false;
      inUse += count;
      return true;
    },
    acquire(count = 1, signal) {
      if (count < 1) return Promise.reject(new Error("Task quota acquire count must be >= 1"));
      if (count > limit) {
        return Promise.reject(new Error(`Task quota acquire count ${count} exceeds limit ${limit}`));
      }
      if (signal?.aborted) return Promise.reject(new Error("Task quota acquisition aborted"));
      if (inUse + count <= limit && waiters.length === 0) {
        inUse += count;
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        const entry: (typeof waiters)[number] = { count, resolve, reject, signal };
        if (signal) {
          entry.onAbort = () => {
            const index = waiters.indexOf(entry);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error("Task quota acquisition aborted"));
            tryStartWaiters();
          };
          signal.addEventListener("abort", entry.onAbort, { once: true });
        }
        waiters.push(entry);
      });
    },
    acquireDependency(signal) {
      if (signal?.aborted) return Promise.reject(new Error("Task quota acquisition aborted"));
      if (inUse >= limit) {
        return Promise.reject(new Error(`Synchronous dependency requires spare task capacity; ${inUse}/${limit} slots are already in use.`));
      }
      return this.acquire(1, signal);
    },
    release(count = 1) {
      inUse = Math.max(0, inUse - Math.max(0, count));
      tryStartWaiters();
    },
  };
}

export interface LaunchSpec {
  agent: AgentDefinition;
  prompt: string;
  description: string;
  cwd: string;
  background: boolean;
  forked: boolean;
  model?: string;
  thinking?: string;
  timeoutMs?: number;
  maxTurns?: number;
  graceTurns?: number;
  maxToolCalls?: number;
  softToolCalls?: number;
  toolBudgetBlock?: string[] | "*";
  warningTurns: number;
  warningIntervalTurns: number;
  toolInventory?: ToolDescriptor[];
  allowNestedAgent?: boolean;
  containmentRoot?: string;
  isolation?: "worktree" | "none";
  name?: string;
}

export interface ProgressWarningDetails {
  turn: number;
  nextWarningTurn: number;
  warningCount: number;
  warningTurns: number;
  warningIntervalTurns: number;
}

export interface ParentLaunchContext {
  parentSessionId: string;
  rootParentSessionId?: string;
  parentTaskId?: string;
  depth?: number;
  parentSessionFile?: string;
  parentLeafId?: string | null;
  parentModel?: string;
  parentThinking?: string;
  parentSystemPrompt?: string;
  appendSubagentSystemPrompt?: string;
  toolInventory?: ToolDescriptor[];
  taskQuota?: TaskQuota;
  availableModels?: Array<{ provider: string; id: string }>;
  projectTrusted: boolean;
}

interface WorktreeInfo {
  root: string;
  path: string;
  cwd: string;
  branch: string;
  baseCommit: string;
}

function asThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  return levels.includes(value as ThinkingLevel) ? (value as ThinkingLevel) : undefined;
}

export function finalNewTurnText(messages: AgentMessage[]): string {
  return extractFinalText(messages) || "(Subagent completed without new text output.)";
}

async function createWorktree(cwd: string, taskId: string): Promise<WorktreeInfo> {
  const probe = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (probe.code !== 0) throw new Error("worktree isolation requires a git repository");
  const root = probe.stdout.trim();
  const status = await runGit(root, ["status", "--porcelain"]);
  if (status.code !== 0) throw new Error(status.stderr || "unable to inspect git status");
  if (status.stdout.trim()) throw new Error("worktree isolation requires a clean git working tree");
  const head = await runGit(root, ["rev-parse", "HEAD"]);
  if (head.code !== 0) throw new Error(head.stderr || "unable to resolve HEAD");
  const worktreeDir = path.join(os.tmpdir(), "pi-subagents", taskId);
  const relativeCwd = path.relative(root, path.resolve(cwd));
  if (relativeCwd.startsWith("..") || path.isAbsolute(relativeCwd)) throw new Error("worktree cwd must be inside the git repository");
  const branch = `pi-agent-${taskId.slice(0, 8)}`;
  await fs.promises.mkdir(path.dirname(worktreeDir), { recursive: true });
  const add = await runGit(root, ["worktree", "add", "-b", branch, worktreeDir, head.stdout.trim()]);
  if (add.code !== 0) throw new Error(add.stderr || "git worktree add failed");
  try {
    const worktreeCwd = path.join(worktreeDir, relativeCwd);
    const canonicalRoot = fs.realpathSync(worktreeDir);
    const canonicalCwd = fs.realpathSync(worktreeCwd);
    const canonicalRelative = path.relative(canonicalRoot, canonicalCwd);
    if (canonicalRelative.startsWith("..") || path.isAbsolute(canonicalRelative)) throw new Error("worktree cwd resolves outside the isolated checkout");
    return { root, path: worktreeDir, cwd: canonicalCwd, branch, baseCommit: head.stdout.trim() };
  } catch (error) {
    await runGit(root, ["worktree", "remove", "--force", worktreeDir]);
    await runGit(root, ["branch", "-D", branch]);
    throw error;
  }
}

async function finalizeWorktree(info: WorktreeInfo | undefined): Promise<{ kept?: WorktreeInfo }> {
  if (!info) return {};
  const status = await runGit(info.path, ["status", "--porcelain"]);
  const head = await runGit(info.path, ["rev-parse", "HEAD"]);
  if (status.code !== 0 || head.code !== 0) return { kept: info };
  const changed = status.stdout.trim().length > 0 || head.stdout.trim() !== info.baseCommit;
  if (changed) return { kept: info };
  const removed = await runGit(info.root, ["worktree", "remove", "--force", info.path]);
  if (removed.code !== 0) return { kept: info };
  const deleted = await runGit(info.root, ["branch", "-D", info.branch]);
  if (deleted.code !== 0) return {};
  return {};
}

function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise(resolve => {
    const proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", data => (stdout += data.toString()));
    proc.stderr.on("data", data => (stderr += data.toString()));
    proc.on("error", error => resolve({ stdout, stderr: `${stderr}${error.message}`, code: 1 }));
    proc.on("close", code => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

export function validateAgentDefinition(agent: AgentDefinition): void {
  if (agent.readonly && agent.shellPolicy === "unrestricted") {
    throw new Error(`Agent '${agent.name}' requires shellPolicy: inspect or verify when readonly is true.`);
  }
  resolveTools(agent);
}

function resolveTools(agent: AgentDefinition, options?: { inventory?: ToolDescriptor[]; allowNestedAgent?: boolean }): string[] {
  return resolveAgentTools({
    agent,
    inventory: options?.inventory,
    allowNestedAgent: options?.allowNestedAgent ?? false,
  });
}


function selectedSkills(agent: AgentDefinition, skills: Skill[]): Skill[] {
  if (!agent.skills?.length) return skills;
  const wanted = new Set(agent.skills.map(name => name.toLowerCase()));
  return skills.filter(skill => wanted.has(skill.name.toLowerCase()));
}

function preloadedSkillPrompt(agent: AgentDefinition, skills: Skill[]): string | undefined {
  if (!agent.skills?.length) return undefined;
  const selected = selectedSkills(agent, skills);
  const missing = agent.skills.filter(name => !selected.some(skill => skill.name.toLowerCase() === name.toLowerCase()));
  const sections: string[] = [];
  for (const skill of selected) {
    try {
      sections.push(`## Preloaded skill: ${skill.name}\n\n${fs.readFileSync(skill.filePath, "utf8")}`);
    } catch {
      // Pi discovery reports unreadable skills separately.
    }
  }
  if (missing.length) sections.push(`Missing requested skills: ${missing.join(", ")}`);
  return sections.length ? `# Preloaded skills\n\n${sections.join("\n\n")}` : undefined;
}

export const FINAL_HANDOFF_DIRECTIVE = "You have reached a wrap-up checkpoint. Finish any concise final step needed, keep additional browsing minimal, and return a clear factual handoff using evidence already collected. Include incomplete work or blockers explicitly.";
export const TOOL_BUDGET_WRAP_UP_DIRECTIVE = "You are approaching the configured tool budget. Prefer finishing from evidence already collected and prepare a concise final report.";

export interface LifecycleUsageBaseline {
  turns: number;
  toolCallsRequested: number;
  toolCallsExecuted: number;
  toolCallsBlocked: number;
}

export function applyAssistantTokenUsage(
  record: TaskRecord,
  message: Extract<AgentMessage, { role: "assistant" }>,
): void {
  record.usage.input += message.usage.input || 0;
  record.usage.output += message.usage.output || 0;
  record.usage.cacheRead += message.usage.cacheRead || 0;
  record.usage.cacheWrite += message.usage.cacheWrite || 0;
  record.usage.cost += message.usage.cost?.total || 0;
}

export function applyLifecycleUsage(record: TaskRecord, baseline: LifecycleUsageBaseline, usage: LifecycleUsage): void {
  record.usage.turns = baseline.turns + usage.turns;
  record.usage.toolCallsRequested = baseline.toolCallsRequested + usage.toolCallsRequested;
  record.usage.toolCallsExecuted = baseline.toolCallsExecuted + usage.toolCallsExecuted;
  record.usage.toolCallsBlocked = baseline.toolCallsBlocked + usage.toolCallsBlocked;
  record.usage.toolCalls = record.usage.toolCallsExecuted;
}

export function finalizeInvocationRecord(options: {
  record: TaskRecord;
  lifecycle: ChildLifecycleController;
  baseline: LifecycleUsageBaseline;
  messages: AgentMessage[];
  error?: string;
  startupFailure?: boolean;
}): string {
  const lastAssistant = [...options.messages].reverse().find(
    (message): message is Extract<AgentMessage, { role: "assistant" }> => message.role === "assistant",
  );
  const terminal = options.startupFailure
    ? options.lifecycle.failStartup(options.error ?? "Subagent failed to start.")
    : options.lifecycle.finishProvider({
      stopReason: lastAssistant?.stopReason,
      errorMessage: lastAssistant?.errorMessage ?? options.error,
      hasInvocationText: Boolean(extractInvocationText(options.messages)),
    });
  applyLifecycleUsage(options.record, options.baseline, terminal.usage);
  if (!terminal.status || !terminal.terminationKind) {
    throw new Error("Lifecycle did not produce a terminal task result.");
  }
  options.record.status = terminal.status;
  options.record.terminationKind = terminal.terminationKind;
  const error = options.error ?? lastAssistant?.errorMessage;
  options.record.error = error;
  return formatInvocationOutput({
    text: extractInvocationText(options.messages),
    status: terminal.status,
    terminationKind: terminal.terminationKind,
    error,
  });
}

/**
 * @deprecated Soft grace keeps normal Pi queue/continuation behavior.
 * Queue clearing is no longer tied to wrap-up phase; retained as a no-op for compatibility.
 */
export function clearQueuedMessagesAfterFinalHandoff(
  _session: { clearQueue(): { steering: string[]; followUp: string[] } },
  _lifecycle: ChildLifecycleController,
): void {
  // Soft grace retains normal Pi queue/continuation until the invocation terminates.
}

export function deriveThinkingClampReason(options: {
  requested?: string;
  effective?: string;
  modelReasoning?: boolean;
  availableLevels: string[];
}): string | undefined {
  if (!options.requested || !options.effective || options.requested === options.effective) return undefined;
  if (options.modelReasoning === false) {
    return `Model metadata reports reasoning unsupported; requested ${options.requested}, effective ${options.effective}.`;
  }
  return `Requested thinking ${options.requested} is unavailable; effective ${options.effective}. Available levels: ${options.availableLevels.join(", ") || "off"}.`;
}

function assistantText(message: AgentMessage): string {
  if (message.role !== "assistant") return "";
  return message.content
    .filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
    .map(part => part.text)
    .join("\n")
    .trim();
}

function assistantToolCalls(message: AgentMessage): Array<Extract<Extract<AgentMessage, { role: "assistant" }>["content"][number], { type: "toolCall" }>> {
  if (message.role !== "assistant") return [];
  return message.content.filter((part): part is Extract<(typeof message.content)[number], { type: "toolCall" }> => part.type === "toolCall");
}

function toolPolicyBlock(agent: AgentDefinition, toolName: string, input: Record<string, unknown>): { kind: "readonly" | "shell_policy"; reason: string } | undefined {
  if (agent.readonly && (toolName === "edit" || toolName === "write")) {
    return { kind: "readonly", reason: `${agent.name} is read-only.` };
  }
  if (toolName === "bash" && agent.shellPolicy !== "unrestricted") {
    const command = typeof input.command === "string" ? input.command : "";
    if (!isShellCommandAllowed(command, agent.shellPolicy)) {
      return { kind: "shell_policy", reason: `${agent.name} only permits its configured ${agent.shellPolicy} shell-command allowlist.` };
    }
  }
  return undefined;
}

export function createChildLifecycleExtension(
  agent: AgentDefinition,
  lifecycle: ChildLifecycleController,
  options: {
    maxTurns?: number;
    onProgressWarning?: (warning: ProgressWarning) => void;
  } = {},
): ExtensionFactory {
  return pi => {
    let finalHandoffSent = false;
    const enterFinalHandoff = () => {
      if (finalHandoffSent) return;
      finalHandoffSent = true;
      pi.sendUserMessage(FINAL_HANDOFF_DIRECTIVE, { deliverAs: "steer" });
    };
    const enterToolWrapUp = () => {
      pi.sendUserMessage(TOOL_BUDGET_WRAP_UP_DIRECTIVE, { deliverAs: "steer" });
    };

    pi.on("turn_start", () => {
      lifecycle.onTurnStart();
    });
    pi.on("tool_call", event => {
      const policy = toolPolicyBlock(agent, event.toolName, event.input);
      const admission = lifecycle.admitTool(event.toolName, policy);
      if (admission.queueWrapUp) enterToolWrapUp();
      if (!admission.allowed) return { block: true, reason: admission.reason };
    });
    pi.on("turn_end", (event, ctx) => {
      const completion = lifecycle.onTurnEnd({
        messageHasText: Boolean(assistantText(event.message)),
        wouldContinue: ctx.hasPendingMessages() || (assistantToolCalls(event.message).length > 0
          && event.message.role === "assistant"
          && event.message.stopReason !== "error"
          && event.message.stopReason !== "aborted"),
      });
      // Progress warnings never abort, restrict tools, inject wrap-up, or change running status.
      if (completion.progressWarning) options.onProgressWarning?.(completion.progressWarning);
      if (completion.queueFinalHandoff) enterFinalHandoff();
      if (completion.stopAfterTurn) ctx.abort();
    });
  };
}

export interface NestedAgentAdapterOptions {
  agent: AgentDefinition;
  agents: AgentDefinition[];
  config: PiSubagentsConfig;
  parent: ParentLaunchContext;
  parentTask: TaskRecord;
  taskQuota: TaskQuota;
  onComplete: (record: TaskRecord) => void;
  onProgressWarning?: (record: TaskRecord, details: ProgressWarningDetails) => void;
  onTaskStarted?: (task: LiveTask) => void;
  deliverNestedResult?: (record: TaskRecord) => Promise<void>;
}

function resolveNestedCwd(base: string, requested: string | undefined, worktreeRoot: string | undefined): string {
  const resolved = path.resolve(base, requested ?? ".");
  if (worktreeRoot) {
    const relative = path.relative(worktreeRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Nested agent cwd must remain inside the isolated worktree.");
    const canonicalRoot = fs.realpathSync(worktreeRoot);
    const canonicalResolved = fs.realpathSync(resolved);
    const canonicalRelative = path.relative(canonicalRoot, canonicalResolved);
    if (canonicalRelative.startsWith("..") || path.isAbsolute(canonicalRelative)) throw new Error("Nested agent cwd resolves outside the isolated worktree.");
    return canonicalResolved;
  }
  return resolved;
}

function canonicalModelReference(modelRef: string, availableModels: Array<{ provider: string; id: string }> | undefined): string {
  const trimmed = modelRef.trim();
  if (!trimmed || trimmed === "inherit" || trimmed === "default") return trimmed;
  const exact = availableModels?.find(model => `${model.provider}/${model.id}` === trimmed);
  if (exact) return `${exact.provider}/${exact.id}`;
  if (!trimmed.includes("/")) {
    const matches = availableModels?.filter(model => model.id === trimmed) ?? [];
    if (matches.length === 1) return `${matches[0]!.provider}/${matches[0]!.id}`;
  }
  throw new Error(`Model '${trimmed}' is not available in the parent Pi model registry. Omit model to use the selected agent's configured model.`);
}

export function createNestedAgentAdapter(options: NestedAgentAdapterOptions): ToolDefinition {
  const paramsSchema = Type.Object({
    description: Type.String(),
    prompt: Type.String(),
    subagent_type: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    isolation: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("worktree")])),
    cwd: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
    warning_turns: Type.Integer({ minimum: 1, description: "Required first checkpoint for this nested task. Typical ranges: 8-12 for narrow/high-risk work, 15-25 for routine investigation, 25-35 for broad research, 30-45 for multi-file implementation, and 10-15 for external/deployment work." }),
    warning_interval_turns: Type.Integer({ minimum: 1, description: "Required reassessment interval for this nested task. Typical ranges: 5-8 for narrow/high-risk work, 8-12 for routine investigation, 12-20 for broad research, 15-25 for multi-file implementation, and 5-10 for external/deployment work." }),
  });
  return defineTool({
    name: "Agent",
    label: "Agent",
    description: `Launch a nested named agent for a genuinely independent subtask or better-matched specialist, then synthesize its result into this worker's handoff. Named children start Fresh and require a complete brief. Choose warning_turns and warning_interval_turns from this nested task's scope and risk rather than copying one universal pair. Typical first/interval ranges: narrow or high-risk 8-12/5-8; routine investigation 15-25/8-12; broad research 25-35/12-20; multi-file implementation 30-45/15-25; external or deployment work 10-15/5-10. Do not delegate understanding, duplicate work, poll background tasks, or request a nested fork. Nesting is bounded at depth ${options.config.maxAgentDepth}; all children share the root concurrency quota.`,
    parameters: paramsSchema,
    async execute(_id, params, signal, onUpdate) {
      const nextDepth = options.parentTask.depth ?? 1;
      if (!options.config.enableNestedAgents || nextDepth >= options.config.maxAgentDepth) {
        throw new Error(`Nested subagent depth limit reached (${options.config.maxAgentDepth}).`);
      }
      if ((params.subagent_type ?? "general-purpose").toLowerCase() === "fork") {
        throw new Error("Nested Agent accepts named agent types; inherited-context workers are launched from the root session.");
      }
      const selected = options.agents.find(agent => agent.name === (params.subagent_type ?? "general-purpose"))
        ?? options.agents.find(agent => agent.name.toLowerCase() === (params.subagent_type ?? "general-purpose").toLowerCase());
      if (!selected) throw new Error(`Unknown nested agent '${params.subagent_type ?? "general-purpose"}'.`);
      await options.taskQuota.acquireDependency(signal ?? undefined);
      try {
        const nestedSchedule = resolveWarningSchedule({
          warningTurns: params.warning_turns,
          warningIntervalTurns: params.warning_interval_turns,
          fallbackTurns: options.config.warningTurns,
          fallbackInterval: options.config.warningIntervalTurns,
        });
        const task = await launchTask({
          spec: {
            agent: selected,
            prompt: params.prompt,
            description: params.description,
            cwd: resolveNestedCwd(options.parentTask.worktreeCwd ?? options.parentTask.worktreePath ?? options.parentTask.cwd, params.cwd, options.parentTask.containmentRoot ?? options.parentTask.worktreePath),
            background: false,
            forked: false,
            model: params.model ? canonicalModelReference(params.model, options.parent.availableModels) : undefined,
            timeoutMs: selected.timeoutMs ?? options.config.defaultTimeoutMs,
            maxTurns: selected.maxTurns ?? options.config.defaultMaxTurns,
            graceTurns: selected.graceTurns ?? options.config.defaultGraceTurns,
            maxToolCalls: selected.maxToolCalls ?? options.config.defaultMaxToolCalls,
            softToolCalls: selected.softToolCalls ?? options.config.defaultSoftToolCalls,
            toolBudgetBlock: selected.toolBudgetBlock ?? options.config.defaultToolBudgetBlock,
            warningTurns: nestedSchedule.warningTurns,
            warningIntervalTurns: nestedSchedule.warningIntervalTurns,
            isolation: resolveTaskIsolation(params.isolation as "none" | "worktree" | undefined, selected.isolation),
            name: params.name,
            toolInventory: options.parent.toolInventory,
            allowNestedAgent: options.config.enableNestedAgents && agentAllowsNestedAgents(selected) && nextDepth + 1 < options.config.maxAgentDepth,
            containmentRoot: options.parentTask.containmentRoot ?? options.parentTask.worktreePath,
          },
          parent: {
            ...options.parent,
            parentSessionId: options.parentTask.rootParentSessionId ?? options.parent.parentSessionId,
            rootParentSessionId: options.parentTask.rootParentSessionId ?? options.parent.parentSessionId,
            parentTaskId: options.parentTask.id,
            depth: nextDepth,
            parentSessionFile: options.parentTask.sessionFile,
            parentLeafId: undefined,
            parentModel: options.parentTask.model ?? options.parent.parentModel,
            parentThinking: options.parentTask.thinking ?? options.parent.parentThinking,
            parentSystemPrompt: options.agent.prompt,
          },
          config: options.config,
          onComplete: record => {
            options.onComplete(record);
            if (record.background) void options.deliverNestedResult?.(record);
          },
          onProgressWarning: options.onProgressWarning,
          onUpdate: record => onUpdate?.({ content: [{ type: "text", text: `${record.description}: ${record.preview ?? "running"}` }], details: record }),
        });
        options.onTaskStarted?.(task);
        await task.promise;
        return {
          content: [{ type: "text", text: formatTaskOutputForModel(task.record, {
            bytes: options.config.maxOutputBytes,
            lines: options.config.maxOutputLines,
          }) }],
          details: task.record,
        };
      } catch (error) {
        options.taskQuota.release();
        throw error;
      }
    },
  });
}

async function makeChildSession(options: {
  spec: LaunchSpec;
  parent: ParentLaunchContext;
  record: TaskRecord;
  config: PiSubagentsConfig;
  agents?: AgentDefinition[];
  onComplete: (record: TaskRecord) => void;
  onProgressWarning?: (record: TaskRecord, details: ProgressWarningDetails) => void;
  onTaskStarted?: (task: LiveTask) => void;
  deliverNestedResult?: (record: TaskRecord) => Promise<void>;
  worktree?: WorktreeInfo;
  lifecycle: ChildLifecycleController;
  onLifecycleProgressWarning?: (warning: ProgressWarning) => void;
}) {
  const cwd = options.worktree?.cwd ?? options.spec.cwd;
  const containmentRoot = options.worktree?.path ?? options.spec.containmentRoot;
  if (containmentRoot) options.record.containmentRoot = containmentRoot;
  const agentDir = getAgentDir();
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
  });
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: options.parent.projectTrusted });
  const guardFactory = createChildLifecycleExtension(options.spec.agent, options.lifecycle, {
    maxTurns: options.spec.maxTurns,
    onProgressWarning: options.onLifecycleProgressWarning,
  });
  // Optional budgets are enforced by the lifecycle controller; wrap-up is advisory.
  const requestedTools = resolveTools(options.spec.agent, { inventory: options.spec.toolInventory ?? options.parent.toolInventory, allowNestedAgent: options.spec.allowNestedAgent });
  options.record.effectiveTools = requestedTools;
  options.record.effectiveReadonly = options.spec.agent.readonly;
  options.record.effectiveShellPolicy = options.spec.agent.shellPolicy;
  const skillLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await skillLoader.reload();
  const skillPrompt = preloadedSkillPrompt(options.spec.agent, skillLoader.getSkills().skills);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: false,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      { name: "pi-subagent-guard", factory: guardFactory },
    ],
    systemPromptOverride: () => options.spec.forked && options.parent.parentSystemPrompt
      ? options.parent.parentSystemPrompt
      : [options.spec.agent.prompt, skillPrompt].filter(Boolean).join("\n\n"),
    appendSystemPromptOverride: base => [
      ...base,
      buildChildBoundary({
        agent: options.spec.agent,
        forked: options.spec.forked,
        cwd,
        parentCwd: options.spec.cwd,
        worktree: Boolean(options.worktree),
        depth: (options.parent.depth ?? 0) + 1,
        maxDepth: options.config.maxAgentDepth,
      }),
      ...(options.parent.appendSubagentSystemPrompt ? [options.parent.appendSubagentSystemPrompt] : []),
    ],
  });
  await loader.reload();

  let sessionManager: SessionManager;
  if (options.spec.forked && options.parent.parentSessionFile && options.parent.parentLeafId) {
    sessionManager = await prepareForkSession({
      parentSessionFile: options.parent.parentSessionFile,
      parentLeafId: options.parent.parentLeafId,
      taskDir: path.dirname(options.record.taskFile),
      cwd,
    });
  } else {
    sessionManager = SessionManager.create(cwd, path.dirname(options.record.taskFile));
  }

  const frontmatterModel = options.spec.agent.model === "inherit" ? undefined : options.spec.agent.model;
  const modelRef = options.spec.forked
    ? options.parent.parentModel
    : options.spec.model ?? frontmatterModel ?? options.parent.parentModel;
  if (!modelRef) throw new Error(`Unable to resolve a model for agent '${options.spec.agent.name}'.`);
  const resolved = resolveCliModel({ cliModel: modelRef, modelRuntime });
  if (resolved.error || !resolved.model) throw new Error(resolved.error ?? `Unable to resolve model '${modelRef}'.`);
  const requestedThinking = asThinkingLevel(options.spec.forked
    ? options.parent.parentThinking ?? resolved.thinkingLevel
    : options.spec.thinking ?? options.spec.agent.thinking ?? options.parent.parentThinking ?? resolved.thinkingLevel);
  const nestedTool = options.spec.allowNestedAgent && options.parent.taskQuota && options.agents
    ? createNestedAgentAdapter({
      agent: options.spec.agent,
      agents: options.agents,
      config: options.config,
      parent: options.parent,
      parentTask: options.record,
      taskQuota: options.parent.taskQuota,
      onComplete: options.onComplete,
      onProgressWarning: options.onProgressWarning,
      onTaskStarted: options.onTaskStarted,
      deliverNestedResult: options.deliverNestedResult,
    })
    : undefined;
  const result = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    settingsManager,
    resourceLoader: loader,
    sessionManager,
    model: resolved.model,
    thinkingLevel: requestedThinking,
    tools: requestedTools,
    customTools: nestedTool ? [nestedTool] : undefined,
  });
  options.record.sessionFile = result.session.sessionFile;
  options.record.model = result.session.model ? `${result.session.model.provider}/${result.session.model.id}` : modelRef;
  options.record.requestedThinking = requestedThinking;
  options.record.effectiveThinking = result.session.thinkingLevel;
  options.record.thinking = result.session.thinkingLevel;
  options.record.thinkingClampReason = deriveThinkingClampReason({
    requested: requestedThinking,
    effective: result.session.thinkingLevel,
    modelReasoning: result.session.model?.reasoning,
    availableLevels: result.session.getAvailableThinkingLevels(),
  });
  await persistTask(options.record);
  return result.session;
}

export async function launchTask(options: {
  spec: LaunchSpec;
  parent: ParentLaunchContext;
  config: PiSubagentsConfig;
  agents?: AgentDefinition[];
  onComplete: (record: TaskRecord) => void;
  onProgressWarning?: (record: TaskRecord, details: ProgressWarningDetails) => void;
  onTaskStarted?: (task: LiveTask) => void;
  onUpdate?: (record: TaskRecord) => void;
}): Promise<LiveTask> {
  validateAgentDefinition(options.spec.agent);
  const schedule = resolveWarningSchedule({
    warningTurns: options.spec.warningTurns,
    warningIntervalTurns: options.spec.warningIntervalTurns,
    fallbackTurns: options.config.warningTurns,
    fallbackInterval: options.config.warningIntervalTurns,
  });
  const record = await createUnpersistedTaskRecord({
    parentSessionId: options.parent.parentSessionId,
    rootParentSessionId: options.parent.rootParentSessionId ?? options.parent.parentSessionId,
    parentTaskId: options.parent.parentTaskId,
    depth: (options.parent.depth ?? 0) + 1,
    parentSessionFile: options.parent.parentSessionFile,
    projectTrusted: options.parent.projectTrusted,
    oneShot: options.spec.agent.oneShot ?? false,
    agent: options.spec.agent.name,
    description: options.spec.description,
    prompt: options.spec.prompt,
    cwd: options.spec.cwd,
    background: options.spec.background,
    forked: options.spec.forked,
    model: options.spec.model,
    thinking: options.spec.thinking,
    maxTurns: options.spec.maxTurns,
    graceTurns: options.spec.graceTurns,
    maxToolCalls: options.spec.maxToolCalls,
    softToolCalls: options.spec.softToolCalls,
    toolBudgetBlock: options.spec.toolBudgetBlock,
    timeoutMs: options.spec.timeoutMs,
    warningTurns: schedule.warningTurns,
    warningIntervalTurns: schedule.warningIntervalTurns,
    nextWarningTurn: schedule.warningTurns,
    warningCount: 0,
    forkSystemPrompt: options.spec.forked ? options.parent.parentSystemPrompt : undefined,
    name: options.spec.name,
  });
  const abortController = new AbortController();
  let resolveForegroundReleased!: () => void;
  const foregroundReleased = new Promise<void>(resolve => {
    resolveForegroundReleased = resolve;
  });
  // Background launches never block the parent Agent tool on foreground wait.
  if (options.spec.background) resolveForegroundReleased();
  const lifecycle = createChildLifecycleController({
    maxToolCalls: options.spec.maxToolCalls,
    softToolCalls: options.spec.softToolCalls,
    toolBudgetBlock: options.spec.toolBudgetBlock,
    maxTurns: options.spec.maxTurns,
    graceTurns: options.spec.graceTurns,
    warningTurns: schedule.warningTurns,
    warningIntervalTurns: schedule.warningIntervalTurns,
  });
  const usageBaseline: LifecycleUsageBaseline = {
    turns: record.usage.turns,
    toolCallsRequested: record.usage.toolCallsRequested,
    toolCallsExecuted: record.usage.toolCallsExecuted,
    toolCallsBlocked: record.usage.toolCallsBlocked,
  };
  const handleProgressWarning = (warning: ProgressWarning) => {
    record.nextWarningTurn = warning.nextWarningTurn;
    record.warningCount = warning.warningCount;
    record.lastWarningAt = new Date().toISOString();
    record.lastWarningTurn = warning.turn;
    // A foreground invocation cannot be supervised while its parent is blocked inside Agent.
    // Promote it before notifying/releasing so actual completion follows the background path.
    if (!record.background) record.background = true;
    applyLifecycleUsage(record, usageBaseline, lifecycle.snapshot.usage);
    void persistTask(record).catch(() => {});
    options.onUpdate?.(record);
    options.onProgressWarning?.(record, warning);
    // First warning releases a blocked foreground Agent wait without completing the task.
    resolveForegroundReleased();
  };
  let stopError: string | undefined;
  let startupComplete = false;
  let childSession: Awaited<ReturnType<typeof makeChildSession>> | undefined;
  let sendQueue = Promise.resolve();
  let acceptingMessages = true;
  let resolveChildReady!: () => void;
  let rejectChildReady!: (error: unknown) => void;
  const childReady = new Promise<void>((resolve, reject) => {
    resolveChildReady = resolve;
    rejectChildReady = reject;
  });
  void childReady.catch(() => {});
  let worktree: WorktreeInfo | undefined;

  const promise = (async () => {
    let messages: AgentMessage[] = [];
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (options.spec.isolation === "worktree") {
        if (!options.config.enableWorktrees) throw new Error("worktree isolation is disabled by configuration");
        worktree = await createWorktree(options.spec.cwd, record.id);
        record.worktreePath = worktree.path;
        record.worktreeCwd = worktree.cwd;
        record.worktreeBranch = worktree.branch;
      }
      if (abortController.signal.aborted) throw new Error("Task was stopped before child startup completed.");
      childSession = await makeChildSession({
        spec: options.spec,
        parent: options.parent,
        record,
        config: options.config,
        agents: options.agents,
        onComplete: options.onComplete,
        onProgressWarning: options.onProgressWarning,
        onTaskStarted: options.onTaskStarted,
        onLifecycleProgressWarning: handleProgressWarning,
        deliverNestedResult: async nestedRecord => {
          if (!childSession) return;
          const nestedResult = formatTaskOutputForModel(nestedRecord, {
            bytes: options.config.maxOutputBytes,
            lines: options.config.maxOutputLines,
          });
          const notification = [
            "<task-notification>",
            `<task-id>${escapeXml(nestedRecord.id)}</task-id>`,
            `<status>${nestedRecord.status}</status>`,
            `<summary>${escapeXml(nestedRecord.description)}</summary>`,
            `<output-file>${escapeXml(nestedRecord.outputFile)}</output-file>`,
            `<result>${escapeXml(nestedResult)}</result>`,
            "</task-notification>",
          ].join("\n");
          if (childSession.isStreaming) await childSession.followUp(notification);
          else await childSession.prompt(notification, { expandPromptTemplates: false, source: "extension" });
        },
        worktree,
        lifecycle,
      });
      startupComplete = true;
      if (abortController.signal.aborted) {
        await childSession.abort();
        throw new Error("Task was stopped during child startup.");
      }
      await persistTask(record);
      const unsubscribe = childSession.subscribe(event => {
        if (event.type === "message_end") {
          messages.push(event.message);
          if (event.message.role === "assistant") {
            applyAssistantTokenUsage(record, event.message);
          }
          const preview = extractFinalText(messages);
          if (preview) record.preview = preview.split("\n")[0]?.slice(0, 300);
          applyLifecycleUsage(record, usageBaseline, lifecycle.snapshot.usage);
          options.onUpdate?.(record);
        }
      });
      const stopChild = () => void childSession?.abort();
      abortController.signal.addEventListener("abort", stopChild, { once: true });
      if (abortController.signal.aborted) {
        await childSession.abort();
        throw new Error("Task was stopped before prompting the child.");
      }
      if (options.spec.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          stopError = `Task timed out after ${options.spec.timeoutMs}ms`;
          lifecycle.requestStop("timeout");
          abortController.abort(new Error(stopError));
        }, options.spec.timeoutMs);
      }

      const kickoff = options.spec.prompt;
      const initialPrompt = childSession.prompt(kickoff, { expandPromptTemplates: false, source: "extension" });
      resolveChildReady();
      try {
        await initialPrompt;
      } finally {
        acceptingMessages = false;
        await sendQueue;
        abortController.signal.removeEventListener("abort", stopChild);
        unsubscribe();
      }
      const output = finalizeInvocationRecord({
        record,
        lifecycle,
        baseline: usageBaseline,
        messages,
        error: stopError,
      });
      await saveTaskOutput(record, output);
    } catch (error) {
      rejectChildReady(error);
      const message = stopError ?? (error instanceof Error ? error.message : String(error));
      const output = finalizeInvocationRecord({
        record,
        lifecycle,
        baseline: usageBaseline,
        messages,
        error: message,
        startupFailure: !startupComplete,
      });
      await saveTaskOutput(record, output);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (childSession) childSession.dispose();
      const finalized = await finalizeWorktree(worktree);
      const cleanedResumableWorktree = Boolean(worktree && !finalized.kept && !record.oneShot);
      if (!finalized.kept) {
        delete record.worktreePath;
        delete record.worktreeCwd;
        delete record.worktreeBranch;
        if (worktree && !record.oneShot) record.worktreeCleaned = true;
      }
      if (cleanedResumableWorktree && record.status === "completed") {
        record.worktreeCleaned = true;
      }
      // Always release any remaining foreground wait so callers cannot hang after terminal.
      resolveForegroundReleased();
      if (record.status === "failed" && !record.sessionFile) {
        record.completedAt = new Date().toISOString();
        await fs.promises.rm(path.dirname(record.taskFile), { recursive: true, force: true });
        options.onComplete(record);
      } else {
        record.completedAt = new Date().toISOString();
        await persistTask(record);
        options.onComplete(record);
      }
    }
    return record;
  })();

  return {
    record,
    abortController,
    promise,
    foregroundReleased,
    send: async message => {
      await childReady;
      if (!childSession) throw new Error("child session failed to start");
      if (!acceptingMessages) throw new Error("child task is no longer accepting live messages; resume the persisted task instead");
      const delivery = sendQueue.then(async () => {
        if (abortController.signal.aborted) throw new Error("child task is no longer accepting live messages");
        if (!childSession) throw new Error("child session is unavailable");
        if (childSession.isStreaming) await childSession.steer(message);
        else await childSession.prompt(message, { expandPromptTemplates: false, source: "extension" });
      });
      sendQueue = delivery.catch(error => {
        if (!abortController.signal.aborted) abortController.abort(error instanceof Error ? error : new Error(String(error)));
      });
      await delivery;
    },
    stop: async kind => {
      if (lifecycle.snapshot.phase === "terminal") return;
      lifecycle.requestStop(kind);
      stopError = kind === "manual_stop" ? "Stopped by parent." : "Parent session shut down.";
      abortController.abort(new Error(stopError));
      if (childSession) await childSession.abort();
    },
  };
}

export async function resumeCompletedTask(options: {
  record: TaskRecord;
  message: string;
  agent: AgentDefinition;
  config: PiSubagentsConfig;
  agents?: AgentDefinition[];
  parent?: ParentLaunchContext;
  onTaskStarted?: (task: LiveTask) => void;
  onComplete: (record: TaskRecord) => void;
  onProgressWarning?: (record: TaskRecord, details: ProgressWarningDetails) => void;
}): Promise<LiveTask> {
  validateAgentDefinition(options.agent);
  const sessionFile = options.record.sessionFile;
  if (!sessionFile || !fs.existsSync(sessionFile)) {
    throw new Error(`No persisted child session for task ${options.record.id}`);
  }
  if (options.record.status === "running") {
    throw new Error(`Task ${options.record.id} is already running and cannot be resumed concurrently.`);
  }
  if (options.record.oneShot) {
    throw new Error(`Task ${options.record.id} uses one-shot execution and cannot be resumed.`);
  }
  if (options.record.worktreeCleaned) {
    throw new Error(`Task ${options.record.id} used a cleaned isolated worktree; start a new isolated task instead of resuming it.`);
  }
  if (options.record.effectiveTools === undefined || options.record.effectiveReadonly === undefined || !options.record.effectiveShellPolicy) {
    throw new Error(`Task ${options.record.id} lacks its original effective capability snapshot and cannot be resumed safely.`);
  }
  if (options.record.effectiveTools.includes("Agent") && (!options.agents || !options.parent?.taskQuota)) {
    throw new Error(`Task ${options.record.id} originally had nested Agent capability, but Resume lacks the original registry or shared quota. Start a new task instead.`);
  }
  const resumeTools = [...options.record.effectiveTools];
  const resumeAgent: AgentDefinition = {
    ...options.agent,
    readonly: options.record.effectiveReadonly,
    shellPolicy: options.record.effectiveShellPolicy,
  };
  const persistedMaxToolCalls = options.record.maxToolCalls ?? options.config.defaultMaxToolCalls;
  const persistedSoftToolCalls = options.record.softToolCalls ?? options.config.defaultSoftToolCalls;
  const persistedToolBudgetBlock = options.record.toolBudgetBlock ?? options.config.defaultToolBudgetBlock;
  const persistedMaxTurns = options.record.maxTurns ?? options.config.defaultMaxTurns;
  const persistedGraceTurns = options.record.graceTurns ?? options.config.defaultGraceTurns;
  const persistedTimeoutMs = options.record.timeoutMs ?? options.config.defaultTimeoutMs;
  const resumeSchedule = resolveWarningSchedule({
    warningTurns: options.record.warningTurns ?? options.config.warningTurns,
    warningIntervalTurns: options.record.warningIntervalTurns ?? options.config.warningIntervalTurns,
    fallbackTurns: options.config.warningTurns,
    fallbackInterval: options.config.warningIntervalTurns,
  });
  options.record.maxToolCalls = persistedMaxToolCalls;
  options.record.softToolCalls = persistedSoftToolCalls;
  options.record.toolBudgetBlock = persistedToolBudgetBlock;
  options.record.maxTurns = persistedMaxTurns;
  options.record.graceTurns = persistedGraceTurns;
  options.record.timeoutMs = persistedTimeoutMs;
  options.record.warningTurns = resumeSchedule.warningTurns;
  options.record.warningIntervalTurns = resumeSchedule.warningIntervalTurns;
  options.record.nextWarningTurn = options.record.nextWarningTurn
    ?? resumeSchedule.warningTurns;
  options.record.warningCount = options.record.warningCount ?? 0;
  const lifecycle = createChildLifecycleController({
    maxToolCalls: persistedMaxToolCalls,
    softToolCalls: persistedSoftToolCalls,
    toolBudgetBlock: persistedToolBudgetBlock,
    maxTurns: persistedMaxTurns,
    graceTurns: persistedGraceTurns,
    warningTurns: resumeSchedule.warningTurns,
    warningIntervalTurns: resumeSchedule.warningIntervalTurns,
    initialTurns: options.record.usage.turns,
    nextWarningTurn: options.record.nextWarningTurn,
    warningCount: options.record.warningCount,
  });
  const usageBaseline: LifecycleUsageBaseline = {
    turns: options.record.usage.turns,
    toolCallsRequested: options.record.usage.toolCallsRequested,
    toolCallsExecuted: options.record.usage.toolCallsExecuted,
    toolCallsBlocked: options.record.usage.toolCallsBlocked,
  };
  const abortController = new AbortController();
  let stopError: string | undefined;
  let startupComplete = false;
  let childSession: Awaited<ReturnType<typeof makeChildSession>> | undefined;
  let sendQueue = Promise.resolve();
  let acceptingMessages = true;
  let resolveChildReady!: () => void;
  let rejectChildReady!: (error: unknown) => void;
  const childReady = new Promise<void>((resolve, reject) => {
    resolveChildReady = resolve;
    rejectChildReady = reject;
  });
  void childReady.catch(() => {});
  let unsubscribe: (() => void) | undefined;
  let stopChild: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const handleResumeProgressWarning = (warning: ProgressWarning) => {
    options.record.nextWarningTurn = warning.nextWarningTurn;
    options.record.warningCount = warning.warningCount;
    options.record.lastWarningAt = new Date().toISOString();
    options.record.lastWarningTurn = warning.turn;
    applyLifecycleUsage(options.record, usageBaseline, lifecycle.snapshot.usage);
    void persistTask(options.record).catch(() => {});
    options.onProgressWarning?.(options.record, warning);
  };
  options.record.status = "running";
  options.record.terminationKind = undefined;
  options.record.background = true;
  options.record.error = undefined;
  options.record.completedAt = undefined;
  await persistTask(options.record);
  const promise = (async () => {
    const messages: AgentMessage[] = [];
    try {
      const cwd = options.record.worktreeCwd ?? options.record.worktreePath ?? options.record.cwd;
      if (options.record.worktreePath) {
        const canonicalRoot = fs.realpathSync(options.record.worktreePath);
        const canonicalCwd = fs.realpathSync(cwd);
        const relative = path.relative(canonicalRoot, canonicalCwd);
        if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Persisted worktree cwd resolves outside the isolated checkout.");
      }
      const agentDir = getAgentDir();
      const modelRuntime = await ModelRuntime.create({
        authPath: path.join(agentDir, "auth.json"),
        modelsPath: path.join(agentDir, "models.json"),
      });
      const runProjectTrusted = options.record.projectTrusted ?? false;
      options.record.projectTrusted = runProjectTrusted;
      const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: runProjectTrusted });
      const guard = createChildLifecycleExtension(resumeAgent, lifecycle, {
        maxTurns: persistedMaxTurns,
        onProgressWarning: handleResumeProgressWarning,
      });
      const skillLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
      await skillLoader.reload();
      const skillPrompt = preloadedSkillPrompt(resumeAgent, skillLoader.getSkills().skills);
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        noExtensions: true,
        noSkills: false,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [
          { name: "pi-subagent-guard", factory: guard },
        ],
        systemPromptOverride: () => options.record.forked && options.record.forkSystemPrompt
          ? options.record.forkSystemPrompt
          : [resumeAgent.prompt, skillPrompt].filter(Boolean).join("\n\n"),
        appendSystemPromptOverride: base => [...base, buildChildBoundary({
          agent: resumeAgent,
          forked: options.record.forked,
          cwd,
          parentCwd: options.record.cwd,
          worktree: Boolean(options.record.worktreePath),
          depth: options.record.depth ?? 1,
          maxDepth: options.config.maxAgentDepth,
        })],
      });
      await loader.reload();
      const sessionManager = SessionManager.open(sessionFile, path.dirname(options.record.taskFile), cwd);
      const resolved = options.record.model ? resolveCliModel({ cliModel: options.record.model, modelRuntime }) : undefined;
      const restoredTools = [...resumeTools];
      const resumeNestedTool = resumeTools.includes("Agent") && options.agents && options.parent?.taskQuota
        ? createNestedAgentAdapter({
          agent: resumeAgent,
          agents: options.agents,
          config: options.config,
          parent: options.parent,
          parentTask: options.record,
          taskQuota: options.parent.taskQuota,
          onComplete: options.onComplete,
          onProgressWarning: options.onProgressWarning,
          onTaskStarted: options.onTaskStarted,
        })
        : undefined;
      const requestedThinking = asThinkingLevel(
        options.record.requestedThinking ?? options.record.effectiveThinking ?? options.record.thinking,
      );
      childSession = (await createAgentSession({
        cwd, agentDir, modelRuntime, settingsManager, resourceLoader: loader, sessionManager,
        model: resolved?.model, thinkingLevel: requestedThinking, tools: restoredTools,
        customTools: resumeNestedTool ? [resumeNestedTool] : undefined,
      })).session;
      startupComplete = true;
      options.record.requestedThinking = requestedThinking;
      options.record.effectiveThinking = childSession.thinkingLevel;
      options.record.thinking = childSession.thinkingLevel;
      options.record.thinkingClampReason = deriveThinkingClampReason({
        requested: requestedThinking,
        effective: childSession.thinkingLevel,
        modelReasoning: childSession.model?.reasoning,
        availableLevels: childSession.getAvailableThinkingLevels(),
      });
      unsubscribe = childSession.subscribe(event => {
        if (event.type !== "message_end") return;
        messages.push(event.message);
        if (event.message.role === "assistant") applyAssistantTokenUsage(options.record, event.message);
        applyLifecycleUsage(options.record, usageBaseline, lifecycle.snapshot.usage);
      });
      stopChild = () => void childSession?.abort();
      abortController.signal.addEventListener("abort", stopChild, { once: true });
      if (abortController.signal.aborted) {
        await childSession.abort();
        throw new Error("Task was stopped before the resumed prompt.");
      }
      await persistTask(options.record);
      if (persistedTimeoutMs !== undefined) {
        timeout = setTimeout(() => {
          stopError = `Task timed out after ${persistedTimeoutMs}ms`;
          lifecycle.requestStop("timeout");
          abortController.abort(new Error(stopError));
        }, persistedTimeoutMs);
      }
      try {
        const resumedPrompt = childSession.prompt(options.message, { expandPromptTemplates: false, source: "extension" });
        resolveChildReady();
        await resumedPrompt;
      } finally {
        acceptingMessages = false;
        await sendQueue;
        clearTimeout(timeout);
        if (stopChild) abortController.signal.removeEventListener("abort", stopChild);
        unsubscribe?.();
        unsubscribe = undefined;
      }
      const output = finalizeInvocationRecord({
        record: options.record,
        lifecycle,
        baseline: usageBaseline,
        messages,
        error: stopError,
      });
      await appendTaskOutput(options.record, output);
    } catch (error) {
      rejectChildReady(error);
      const message = stopError ?? (error instanceof Error ? error.message : String(error));
      const output = finalizeInvocationRecord({
        record: options.record,
        lifecycle,
        baseline: usageBaseline,
        messages,
        error: message,
        startupFailure: !startupComplete,
      });
      await appendTaskOutput(options.record, output);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (stopChild) abortController.signal.removeEventListener("abort", stopChild);
      unsubscribe?.();
      childSession?.dispose();
      options.record.completedAt = new Date().toISOString();
      await persistTask(options.record);
      options.onComplete(options.record);
    }
    return options.record;
  })();
  return {
    record: options.record,
    abortController,
    promise,
    foregroundReleased: Promise.resolve(),
    send: async message => {
      await childReady;
      if (!childSession) throw new Error("child session failed to resume");
      if (!acceptingMessages) throw new Error("resumed child task is no longer accepting live messages");
      const delivery = sendQueue.then(async () => {
        if (abortController.signal.aborted) throw new Error("resumed child task is no longer accepting live messages");
        if (!childSession) throw new Error("child session is unavailable");
        if (childSession.isStreaming) await childSession.steer(message);
        else await childSession.prompt(message, { expandPromptTemplates: false, source: "extension" });
      });
      sendQueue = delivery.catch(error => {
        if (!abortController.signal.aborted) abortController.abort(error instanceof Error ? error : new Error(String(error)));
      });
      await delivery;
    },
    stop: async kind => {
      if (lifecycle.snapshot.phase === "terminal") return;
      lifecycle.requestStop(kind);
      stopError = kind === "manual_stop" ? "Stopped by parent." : "Parent session shut down.";
      abortController.abort(new Error(stopError));
      if (childSession) await childSession.abort();
    },
  };
}
