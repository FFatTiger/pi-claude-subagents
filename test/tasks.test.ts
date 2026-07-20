import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  appendTaskOutput,
  extractInvocationText,
  formatInvocationOutput,
  formatTaskTargetError,
  normalizeTaskRecord,
  resolveTaskTarget,
  type TaskRecord,
} from "../src/tasks.ts";

function record(options: Partial<TaskRecord> & Pick<TaskRecord, "id">): TaskRecord {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-task-test-"));
  const now = options.startedAt ?? "2026-07-19T00:00:00.000Z";
  return {
    parentSessionId: "parent",
    agent: "general-purpose",
    description: options.description ?? "task",
    prompt: "prompt",
    cwd: dir,
    startedAt: now,
    updatedAt: now,
    status: options.status ?? "running",
    background: true,
    forked: false,
    maxTurns: 8,
    maxToolCalls: 30,
    timeoutMs: 60_000,
    outputFile: path.join(dir, "output.md"),
    taskFile: path.join(dir, "task.json"),
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
    ...options,
  };
}

test("task target resolution prefers exact UUID then unique prefix then unique name", () => {
  const exact = record({
    id: "aaaaaaaa-1111-4111-8111-111111111111",
    name: "shared",
    description: "older",
    startedAt: "2026-07-19T00:00:00.000Z",
  });
  const newer = record({
    id: "bbbbbbbb-2222-4222-8222-222222222222",
    name: "shared",
    description: "newer",
    startedAt: "2026-07-19T01:00:00.000Z",
  });
  const unique = record({
    id: "cccccccc-3333-4333-8333-333333333333",
    name: "unique",
    description: "unique name",
  });

  assert.deepEqual(resolveTaskTarget([exact, newer, unique], exact.id), { kind: "found", task: exact });
  assert.deepEqual(resolveTaskTarget([exact, newer, unique], "cccccccc"), { kind: "found", task: unique });
  assert.deepEqual(resolveTaskTarget([exact, newer, unique], "unique"), { kind: "found", task: unique });

  const duplicate = resolveTaskTarget([exact, newer, unique], "shared");
  assert.equal(duplicate.kind, "ambiguous");
  if (duplicate.kind === "ambiguous") {
    assert.deepEqual(duplicate.candidates.map(candidate => candidate.id), [newer.id, exact.id]);
    const message = formatTaskTargetError(duplicate);
    assert.match(message, new RegExp(newer.id));
    assert.match(message, new RegExp(exact.id));
    assert.match(message, /newer/);
    assert.match(message, /shared/);
  }
});

test("task target resolution rejects empty and whitespace queries", () => {
  const task = record({ id: "aaaaaaaa-1111-4111-8111-111111111111", name: "named" });
  for (const query of ["", "   ", "\n\t"]) {
    const result = resolveTaskTarget([task], query);
    assert.deepEqual(result, { kind: "not_found", query });
    assert.equal(formatTaskTargetError(result), "Task target must be a non-empty task ID, prefix, or name.");
  }
});

test("task target resolution reports ambiguous prefixes and unknown targets", () => {
  const first = record({ id: "deadbeef-1111-4111-8111-111111111111", status: "partial", description: "first" });
  const second = record({ id: "deadbeef-2222-4222-8222-222222222222", status: "failed", description: "second" });

  const prefix = resolveTaskTarget([first, second], "deadbeef");
  assert.equal(prefix.kind, "ambiguous");
  if (prefix.kind === "ambiguous") {
    const message = formatTaskTargetError(prefix);
    assert.match(message, /partial/);
    assert.match(message, /failed/);
  }

  const missing = resolveTaskTarget([first, second], "missing");
  assert.deepEqual(missing, { kind: "not_found", query: "missing" });
  assert.match(formatTaskTargetError(missing), /Task not found: missing/);
});

test("normalizes legacy task usage and effective thinking without inventing termination", () => {
  const legacy = record({
    id: "legacy",
    thinking: "off",
    usage: {
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      cost: 5,
      turns: 6,
      toolCalls: 7,
    } as TaskRecord["usage"],
  });
  delete (legacy as Partial<TaskRecord>).terminationKind;
  delete (legacy as Partial<TaskRecord>).requestedThinking;
  delete (legacy as Partial<TaskRecord>).effectiveThinking;

  const normalized = normalizeTaskRecord(legacy);
  assert.deepEqual(normalized.usage, {
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    cost: 5,
    turns: 6,
    toolCalls: 7,
    toolCallsRequested: 7,
    toolCallsExecuted: 7,
    toolCallsBlocked: 0,
  });
  assert.equal(normalized.requestedThinking, undefined);
  assert.equal(normalized.effectiveThinking, "off");
  assert.equal(normalized.thinking, "off");
  assert.equal(normalized.terminationKind, undefined);
});

function assistant(options: { text?: string; stopReason: string; errorMessage?: string }): AgentMessage {
  return {
    role: "assistant",
    content: options.text ? [{ type: "text", text: options.text }] : [],
    api: "openai-completions",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: options.stopReason,
    errorMessage: options.errorMessage,
    timestamp: Date.now(),
  } as AgentMessage;
}

test("empty aborted terminal message does not reuse an earlier progress sentence", () => {
  const messages = [
    assistant({ text: "I am still researching.", stopReason: "toolUse" }),
    assistant({ stopReason: "aborted", errorMessage: "Request was aborted" }),
  ];
  assert.equal(extractInvocationText(messages), "");
});

test("invocation output formats terminal outcomes without historical fallback", () => {
  assert.equal(
    formatInvocationOutput({ text: "", status: "completed", terminationKind: "normal" }),
    "(Subagent completed without new text output.)",
  );
  assert.equal(
    formatInvocationOutput({ text: "", status: "partial", terminationKind: "timeout", error: "Task timed out after 300000ms" }),
    "[Subagent ended partial: timeout. Task timed out after 300000ms]",
  );
  assert.equal(
    formatInvocationOutput({ text: "Useful handoff", status: "partial", terminationKind: "tool_budget" }),
    "Useful handoff\n\n[Subagent ended partial: tool_budget.]",
  );
  assert.equal(
    formatInvocationOutput({ text: "", status: "failed", terminationKind: "provider_error", error: "Request was aborted" }),
    "[Subagent failed: provider_error. Request was aborted]",
  );
});

test("resume appends only the supplied invocation segment", async () => {
  const task = record({ id: "append" });
  fs.writeFileSync(task.outputFile, "Earlier invocation", "utf8");

  await appendTaskOutput(task, "New invocation only");

  assert.equal(fs.readFileSync(task.outputFile, "utf8"), "Earlier invocation\n\n---\n\nNew invocation only");
});
