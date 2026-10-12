import test from "node:test";
import assert from "node:assert/strict";
import {
  formatInterruptedTasksNotice,
  isInterruptedByParent,
  isResumableInterruptedTask,
  selectInterruptedTasks,
} from "../src/interrupted.ts";
import type { TaskRecord } from "../src/tasks.ts";

function record(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    parentSessionId: "parent-session",
    agent: "verification",
    description: "Verify release baseline fixes",
    prompt: "verify",
    cwd: "/tmp",
    startedAt: "2026-10-12T00:00:00.000Z",
    updatedAt: "2026-10-12T00:00:00.000Z",
    status: "stopped",
    terminationKind: "parent_shutdown",
    background: true,
    forked: false,
    sessionFile: "/tmp/child-session.jsonl",
    taskFile: "/tmp/task.json",
    outputFile: "/tmp/output.md",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 39,
      toolCalls: 65,
      toolCallsRequested: 65,
      toolCallsExecuted: 65,
      toolCallsBlocked: 0,
    },
    ...overrides,
  };
}

test("only parent_shutdown stops count as interrupted", () => {
  assert.equal(isInterruptedByParent(record()), true);
  assert.equal(isInterruptedByParent(record({ terminationKind: "manual_stop" })), false);
  assert.equal(isInterruptedByParent(record({ terminationKind: "timeout", status: "partial" })), false);
  assert.equal(isInterruptedByParent(record({ status: "completed", terminationKind: "normal" })), false);
  assert.equal(isInterruptedByParent(record({ status: "failed", terminationKind: "provider_error" })), false);
  // Orphaned tasks from a previous process were re-labeled failed by reload(); not interrupted.
  assert.equal(isInterruptedByParent(record({ status: "failed", error: "orphaned" })), false);
});

test("resumable requires a persisted session, non-one-shot, and a live worktree", () => {
  const exists = (file: string) => file === "/tmp/child-session.jsonl";
  assert.equal(isResumableInterruptedTask(record(), exists), true);
  assert.equal(isResumableInterruptedTask(record({ oneShot: true }), exists), false, "one-shot Explore tasks cannot resume");
  assert.equal(isResumableInterruptedTask(record({ worktreeCleaned: true }), exists), false);
  assert.equal(isResumableInterruptedTask(record({ sessionFile: "/tmp/missing.jsonl" }), exists), false);
  assert.equal(isResumableInterruptedTask(record({ sessionFile: undefined }), exists), false);
});

test("selectInterruptedTasks reports session-file presence and sorts oldest first", () => {
  const newer = record({ id: "b", startedAt: "2026-10-12T02:00:00.000Z", sessionFile: "/tmp/missing.jsonl" });
  const older = record({ id: "a", startedAt: "2026-10-12T01:00:00.000Z" });
  const others = [
    record({ id: "c", status: "running" }),
    record({ id: "d", status: "completed", terminationKind: "normal" }),
  ];
  const candidates = selectInterruptedTasks([newer, others[0]!, older, others[1]!], (file) => file === "/tmp/child-session.jsonl");
  assert.deepEqual(candidates.map((candidate) => candidate.record.id), ["a", "b"]);
  assert.deepEqual(candidates.map((candidate) => candidate.hasSessionFile), [true, false]);
});

test("notice lists only recoverable tasks and teaches SendMessage recovery", () => {
  const recoverable = record({ id: "a" });
  const missingSession = record({ id: "b", sessionFile: "/tmp/missing.jsonl" });
  const notice = formatInterruptedTasksNotice(
    selectInterruptedTasks([recoverable, missingSession], (file) => file === "/tmp/child-session.jsonl"),
  );
  assert.ok(notice);
  assert.match(notice, /<interrupted-tasks>/);
  assert.match(notice, /- Verify release baseline fixes \(verification, 39 turns so far, task_id: a\)/);
  assert.ok(!notice.includes("task_id: b"), "tasks without a persisted session are not listed as recoverable");
  assert.match(notice, /SendMessage/);

  const autoNotice = formatInterruptedTasksNotice(
    selectInterruptedTasks([recoverable], () => true),
    { autoResumed: true },
  );
  assert.match(autoNotice!, /resumed automatically/);
});

test("notice returns null when nothing is recoverable", () => {
  assert.equal(
    formatInterruptedTasksNotice(
      selectInterruptedTasks([record({ status: "completed", terminationKind: "normal" })], () => true),
    ),
    null,
  );
  assert.equal(
    formatInterruptedTasksNotice(
      selectInterruptedTasks([record({ sessionFile: "/tmp/missing.jsonl" })], () => false),
    ),
    null,
  );
});

test("config accepts interruptedTaskResume modes", async () => {
  const { applyConfig, DEFAULT_CONFIG } = await import("../src/config.ts");
  assert.equal(applyConfig(DEFAULT_CONFIG, { interruptedTaskResume: "off" }).interruptedTaskResume, "off");
  assert.equal(applyConfig(DEFAULT_CONFIG, { interruptedTaskResume: "auto" }).interruptedTaskResume, "auto");
  assert.equal(applyConfig(DEFAULT_CONFIG, { interruptedTaskResume: "notify" }).interruptedTaskResume, "notify");
  assert.equal(applyConfig(DEFAULT_CONFIG, { interruptedTaskResume: "bogus" as unknown }).interruptedTaskResume, "notify");
  assert.equal(DEFAULT_CONFIG.interruptedTaskResume, "notify");
});
