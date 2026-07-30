import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { TerminationKind } from "./lifecycle.ts";

export type TaskStatus = "running" | "completed" | "partial" | "failed" | "stopped";

export interface TaskUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
  /** Compatibility alias for executed tool calls. */
  toolCalls: number;
  toolCallsRequested: number;
  toolCallsExecuted: number;
  toolCallsBlocked: number;
}

export interface TaskRecord {
  id: string;
  name?: string;
  parentSessionId: string;
  rootParentSessionId?: string;
  parentTaskId?: string;
  depth?: number;
  parentSessionFile?: string;
  projectTrusted?: boolean;
  oneShot?: boolean;
  agent: string;
  description: string;
  prompt: string;
  cwd: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  status: TaskStatus;
  terminationKind?: TerminationKind;
  background: boolean;
  forked: boolean;
  model?: string;
  /** Compatibility alias for effectiveThinking. */
  thinking?: string;
  requestedThinking?: string;
  effectiveThinking?: string;
  thinkingClampReason?: string;
  maxTurns?: number;
  graceTurns?: number;
  maxToolCalls?: number;
  softToolCalls?: number;
  toolBudgetBlock?: string[] | "*";
  timeoutMs?: number;
  /** Effective first progress-warning checkpoint (absolute turns). Always set on new tasks. */
  warningTurns?: number;
  /** Effective interval between progress-warning checkpoints. Always set on new tasks. */
  warningIntervalTurns?: number;
  /** Next absolute turn that should emit a progress warning. */
  nextWarningTurn?: number;
  warningCount?: number;
  lastWarningAt?: string;
  lastWarningTurn?: number;
  forkSystemPrompt?: string;
  sessionFile?: string;
  outputFile: string;
  taskFile: string;
  worktreePath?: string;
  worktreeCwd?: string;
  containmentRoot?: string;
  worktreeBranch?: string;
  worktreeCleaned?: boolean;
  effectiveTools?: string[];
  effectiveReadonly?: boolean;
  effectiveShellPolicy?: "inspect" | "verify" | "unrestricted";
  error?: string;
  preview?: string;
  usage: TaskUsage;
}

export interface LiveTask {
  record: TaskRecord;
  abortController: AbortController;
  promise: Promise<TaskRecord>;
  send: (message: string) => Promise<void>;
  stop: (kind: "manual_stop" | "parent_shutdown") => Promise<void>;
  /** Resolves once the first progress warning has released a foreground wait (if any). */
  foregroundReleased?: Promise<void>;
}

export function taskRoot(parentSessionId: string): string {
  return path.join(getAgentDir(), "pi-claude-subagents", parentSessionId);
}

function buildTaskRecord(options: {
  id: string;
  taskFile: string;
  now: string;
  parentSessionId: string;
  rootParentSessionId?: string;
  parentTaskId?: string;
  depth?: number;
  parentSessionFile?: string;
  projectTrusted?: boolean;
  oneShot?: boolean;
  agent: string;
  description: string;
  prompt: string;
  cwd: string;
  background: boolean;
  forked: boolean;
  model?: string;
  thinking?: string;
  maxTurns?: number;
  graceTurns?: number;
  maxToolCalls?: number;
  softToolCalls?: number;
  toolBudgetBlock?: string[] | "*";
  timeoutMs?: number;
  warningTurns?: number;
  warningIntervalTurns?: number;
  nextWarningTurn?: number;
  warningCount?: number;
  forkSystemPrompt?: string;
  name?: string;
}): TaskRecord {
  return {
    id: options.id,
    name: options.name,
    parentSessionId: options.parentSessionId,
    rootParentSessionId: options.rootParentSessionId ?? options.parentSessionId,
    parentTaskId: options.parentTaskId,
    depth: options.depth ?? 1,
    parentSessionFile: options.parentSessionFile,
    projectTrusted: options.projectTrusted,
    oneShot: options.oneShot ?? false,
    agent: options.agent,
    description: options.description,
    prompt: options.prompt,
    cwd: options.cwd,
    startedAt: options.now,
    updatedAt: options.now,
    status: "running",
    background: options.background,
    forked: options.forked,
    model: options.model,
    requestedThinking: options.thinking,
    maxTurns: options.maxTurns,
    graceTurns: options.graceTurns,
    maxToolCalls: options.maxToolCalls,
    softToolCalls: options.softToolCalls,
    toolBudgetBlock: options.toolBudgetBlock,
    timeoutMs: options.timeoutMs,
    warningTurns: options.warningTurns,
    warningIntervalTurns: options.warningIntervalTurns,
    nextWarningTurn: options.nextWarningTurn ?? options.warningTurns,
    warningCount: options.warningCount ?? 0,
    forkSystemPrompt: options.forkSystemPrompt,
    outputFile: path.join(path.dirname(options.taskFile), "output.md"),
    taskFile: options.taskFile,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 0,
      toolCalls: 0,
      toolCallsRequested: 0,
      toolCallsExecuted: 0,
      toolCallsBlocked: 0,
    },
  };
}

export async function createUnpersistedTaskRecord(options: Omit<Parameters<typeof buildTaskRecord>[0], "id" | "taskFile" | "now">): Promise<TaskRecord> {
  const id = randomUUID();
  const dir = path.join(taskRoot(options.parentSessionId), id);
  await fs.promises.mkdir(dir, { recursive: true });
  return buildTaskRecord({ ...options, id, taskFile: path.join(dir, "task.json"), now: new Date().toISOString() });
}

export async function createTaskRecord(options: {
  parentSessionId: string;
  rootParentSessionId?: string;
  parentTaskId?: string;
  depth?: number;
  parentSessionFile?: string;
  projectTrusted?: boolean;
  oneShot?: boolean;
  agent: string;
  description: string;
  prompt: string;
  cwd: string;
  background: boolean;
  forked: boolean;
  model?: string;
  thinking?: string;
  maxTurns?: number;
  graceTurns?: number;
  maxToolCalls?: number;
  softToolCalls?: number;
  toolBudgetBlock?: string[] | "*";
  timeoutMs?: number;
  warningTurns?: number;
  warningIntervalTurns?: number;
  nextWarningTurn?: number;
  warningCount?: number;
  forkSystemPrompt?: string;
  name?: string;
}): Promise<TaskRecord> {
  const record = await createUnpersistedTaskRecord(options);
  await persistTask(record);
  return record;
}

export async function persistTask(record: TaskRecord): Promise<void> {
  record.updatedAt = new Date().toISOString();
  await withFileMutationQueue(record.taskFile, async () => {
    const temp = `${record.taskFile}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
    await fs.promises.mkdir(path.dirname(record.taskFile), { recursive: true });
    await fs.promises.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await fs.promises.rename(temp, record.taskFile);
  });
}

export async function saveTaskOutput(record: TaskRecord, output: string): Promise<void> {
  await withFileMutationQueue(record.outputFile, async () => {
    await fs.promises.mkdir(path.dirname(record.outputFile), { recursive: true });
    await fs.promises.writeFile(record.outputFile, output, "utf8");
  });
  record.preview = output.trim().split("\n").find(Boolean)?.slice(0, 300) || "(no output)";
  await persistTask(record);
}

export async function appendTaskOutput(record: TaskRecord, output: string): Promise<void> {
  let prior = "";
  try {
    prior = await fs.promises.readFile(record.outputFile, "utf8");
  } catch {
    // First output segment.
  }
  const combined = prior.trim()
    ? `${prior.trimEnd()}\n\n---\n\n${output}`
    : output;
  await saveTaskOutput(record, combined);
}

export function extractFinalText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    const text = message.content
      .filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
      .map(part => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

/**
 * Extract the terminal handoff for one invocation only.
 *
 * The last assistant message is authoritative. If it is empty, errored, or
 * aborted, do not scan backwards and accidentally promote progress text from
 * an earlier turn into the invocation result.
 */
export function extractInvocationText(messages: AgentMessage[]): string {
  const terminal = [...messages].reverse().find(message => message?.role === "assistant");
  if (!terminal || terminal.role !== "assistant") return "";
  if (terminal.stopReason === "aborted" || terminal.stopReason === "error") return "";
  return terminal.content
    .filter((part): part is Extract<(typeof terminal.content)[number], { type: "text" }> => part.type === "text")
    .map(part => part.text)
    .join("\n")
    .trim();
}

export function formatInvocationOutput(options: {
  text: string;
  status: Exclude<TaskStatus, "running">;
  terminationKind?: TerminationKind;
  error?: string;
}): string {
  const text = options.text.trim();
  if (options.status === "completed") {
    return text || "(Subagent completed without new text output.)";
  }
  const kind = options.terminationKind ?? "unknown";
  const detail = options.error?.trim() ? ` ${options.error.trim()}` : "";
  const annotation = options.status === "partial"
    ? `[Subagent ended partial: ${kind}.${detail}]`
    : options.status === "stopped"
      ? `[Subagent stopped: ${kind}.${detail}]`
      : `[Subagent failed: ${kind}.${detail}]`;
  return text ? `${text}\n\n${annotation}` : annotation;
}

export async function cleanupExpiredTasks(cleanupPeriodDays?: number): Promise<number> {
  if (cleanupPeriodDays === undefined || cleanupPeriodDays <= 0) return 0;
  const base = path.join(getAgentDir(), "pi-claude-subagents");
  if (!fs.existsSync(base)) return 0;
  const cutoff = Date.now() - cleanupPeriodDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const session of fs.readdirSync(base, { withFileTypes: true })) {
    if (!session.isDirectory()) continue;
    const sessionPath = path.join(base, session.name);
    for (const task of fs.readdirSync(sessionPath, { withFileTypes: true })) {
      if (!task.isDirectory()) continue;
      const dir = path.join(sessionPath, task.name);
      const taskFile = path.join(dir, "task.json");
      try {
        const stat = fs.statSync(taskFile);
        const record = JSON.parse(fs.readFileSync(taskFile, "utf8")) as TaskRecord;
        if (record.status !== "running" && stat.mtimeMs < cutoff) {
          await fs.promises.rm(dir, { recursive: true, force: true });
          removed++;
        }
      } catch {
        // Leave unreadable or active-looking task directories for diagnosis.
      }
    }
    try {
      if (fs.readdirSync(sessionPath).length === 0) await fs.promises.rmdir(sessionPath);
    } catch {
      // Best-effort cleanup.
    }
  }
  return removed;
}

export function normalizeTaskRecord(record: TaskRecord): TaskRecord {
  const legacyToolCalls = Number.isFinite(record.usage?.toolCalls) ? record.usage.toolCalls : 0;
  const executed = Number.isFinite(record.usage?.toolCallsExecuted)
    ? record.usage.toolCallsExecuted
    : legacyToolCalls;
  const requested = Number.isFinite(record.usage?.toolCallsRequested)
    ? record.usage.toolCallsRequested
    : executed;
  const blocked = Number.isFinite(record.usage?.toolCallsBlocked)
    ? record.usage.toolCallsBlocked
    : Math.max(0, requested - executed);
  record.usage = {
    input: record.usage?.input ?? 0,
    output: record.usage?.output ?? 0,
    cacheRead: record.usage?.cacheRead ?? 0,
    cacheWrite: record.usage?.cacheWrite ?? 0,
    cost: record.usage?.cost ?? 0,
    turns: record.usage?.turns ?? 0,
    toolCalls: executed,
    toolCallsRequested: requested,
    toolCallsExecuted: executed,
    toolCallsBlocked: blocked,
  };
  if (record.effectiveThinking === undefined && record.thinking !== undefined) {
    record.effectiveThinking = record.thinking;
  }
  if (record.effectiveThinking !== undefined) record.thinking = record.effectiveThinking;
  return record;
}

export function loadTaskRecords(parentSessionId: string): TaskRecord[] {
  const root = taskRoot(parentSessionId);
  if (!fs.existsSync(root)) return [];
  const records: TaskRecord[] = [];
  for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const taskFile = path.join(root, dirent.name, "task.json");
    try {
      records.push(normalizeTaskRecord(JSON.parse(fs.readFileSync(taskFile, "utf8")) as TaskRecord));
    } catch {
      // Ignore corrupt historical entries; doctor/list can report current live state.
    }
  }
  return records.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export type TaskTargetResolution =
  | { kind: "found"; task: TaskRecord }
  | { kind: "not_found"; query: string }
  | { kind: "ambiguous"; query: string; candidates: TaskRecord[] };

function newestFirst(records: TaskRecord[]): TaskRecord[] {
  return records.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function resolveTaskTarget(records: Iterable<TaskRecord>, query: string): TaskTargetResolution {
  if (!query.trim()) return { kind: "not_found", query };
  const all = Array.from(records);
  const exactId = all.find(task => task.id === query);
  if (exactId) return { kind: "found", task: exactId };

  const prefixMatches = newestFirst(all.filter(task => task.id.startsWith(query)));
  if (prefixMatches.length === 1) return { kind: "found", task: prefixMatches[0]! };
  if (prefixMatches.length > 1) return { kind: "ambiguous", query, candidates: prefixMatches };

  const nameMatches = newestFirst(all.filter(task => task.name === query));
  if (nameMatches.length === 1) return { kind: "found", task: nameMatches[0]! };
  if (nameMatches.length > 1) return { kind: "ambiguous", query, candidates: nameMatches };
  return { kind: "not_found", query };
}

export function formatTaskTargetError(result: Exclude<TaskTargetResolution, { kind: "found" }>): string {
  if (!result.query.trim()) return "Task target must be a non-empty task ID, prefix, or name.";
  if (result.kind === "not_found") return `Task not found: ${result.query}`;
  const candidates = result.candidates.map(task => {
    const name = task.name ? ` name=${task.name}` : "";
    return `- ${task.id} [${task.status}]${name} — ${task.description}`;
  });
  return [`Task target is ambiguous: ${result.query}`, "Candidates:", ...candidates, "Use the full task ID or a unique ID prefix."].join("\n");
}

/** @deprecated Use resolveTaskTarget() so ambiguity can be reported. */
export function findTask(records: Iterable<TaskRecord>, idOrName: string): TaskRecord | undefined {
  const result = resolveTaskTarget(records, idOrName);
  return result.kind === "found" ? result.task : undefined;
}

function truncateUtf8ByBytes(text: string, maxBytes: number): string {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return "";
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) return text;

  // Binary search the largest code-unit prefix whose UTF-8 encoding fits maxBytes.
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) low = mid;
    else high = mid - 1;
  }
  let end = low;
  if (end > 0 && end < text.length) {
    const last = text.charCodeAt(end - 1);
    const next = text.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
  }
  return text.slice(0, end);
}

export function formatTaskOutputForModel(
  record: TaskRecord,
  bounds: number | { bytes?: number; lines?: number; chars?: number },
): string {
  let output = "";
  try {
    output = fs.readFileSync(record.outputFile, "utf8");
  } catch {
    output = record.error || record.preview || "(no output yet)";
  }

  const maxBytes = typeof bounds === "number"
    ? bounds
    : bounds.bytes ?? bounds.chars ?? Number.POSITIVE_INFINITY;
  const maxLines = typeof bounds === "number"
    ? Number.POSITIVE_INFINITY
    : bounds.lines ?? Number.POSITIVE_INFINITY;

  const lines = output.split("\n");
  const truncatedByLines = lines.length > maxLines;
  const byLines = truncatedByLines ? lines.slice(0, maxLines).join("\n") : output;
  const truncatedByBytes = Buffer.byteLength(byLines, "utf8") > maxBytes;
  const truncated = truncatedByBytes ? truncateUtf8ByBytes(byLines, maxBytes) : byLines;
  if (!truncatedByBytes && !truncatedByLines) return output;

  const header = `[Truncated. Full output: ${record.outputFile}]\n\n`;
  return header + truncated;
}
