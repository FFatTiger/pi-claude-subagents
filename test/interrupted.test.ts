import test from "node:test";
import assert from "node:assert/strict";
import {
  formatInterruptedTasksNotice,
  isInterruptedByParent,
  isResumableInterruptedTask,
  selectInterruptedTasks,
  shouldOfferInterruptedRecovery,
} from "../src/interrupted.ts";
import { attemptAutoResume, persistLiveTasksForParentShutdown, quotaAcquireSignal, shouldOrphanRestoredTask } from "../src/index.ts";
import type { LiveTask, TaskRecord } from "../src/tasks.ts";
import type { AgentDefinition } from "../src/agents.ts";

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
  assert.equal(autoNotice!.includes("SendMessage"), false);
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

test("notice escapes XML-sensitive task fields", () => {
  const notice = formatInterruptedTasksNotice(
    selectInterruptedTasks([
      record({
        id: "id<1>",
        description: "Fix <root> & friends",
        agent: "verify&plan",
      }),
    ], () => true),
  );
  assert.ok(notice);
  assert.match(notice, /Fix &lt;root&gt; &amp; friends/);
  assert.match(notice, /verify&amp;plan/);
  assert.match(notice, /task_id: id&lt;1&gt;/);
  assert.equal(notice.includes("<root>"), false);
});

test("auto failure notice keeps SendMessage guidance and escaped errors", () => {
  const recoverable = record({ description: "Fix <root>", agent: "verify" });
  const notice = formatInterruptedTasksNotice(
    selectInterruptedTasks([recoverable], () => true),
    {
      autoResumed: false,
      failures: [{ ok: false, record: recoverable, error: "Agent definition no longer exists: verify <gone>" }],
    },
  );
  assert.ok(notice);
  assert.match(notice, /Some auto-resumes failed; continue them with SendMessage/);
  assert.match(notice, /Agent definition no longer exists: verify &lt;gone&gt;/);
  assert.equal(notice.includes("resumed automatically"), false);
});

test("config accepts interruptedTaskResume modes", async () => {
  const { applyConfig, DEFAULT_CONFIG } = await import("../src/config.ts");
  assert.equal(applyConfig(DEFAULT_CONFIG, { interruptedTaskResume: "off" }).interruptedTaskResume, "off");
  assert.equal(applyConfig(DEFAULT_CONFIG, { interruptedTaskResume: "auto" }).interruptedTaskResume, "auto");
  assert.equal(applyConfig(DEFAULT_CONFIG, { interruptedTaskResume: "notify" }).interruptedTaskResume, "notify");
  assert.equal(applyConfig(DEFAULT_CONFIG, { interruptedTaskResume: "bogus" as unknown }).interruptedTaskResume, "notify");
  assert.equal(DEFAULT_CONFIG.interruptedTaskResume, "notify");
});

test("recovery eligibility is per parent session and ignores off or empty candidate lists", () => {
  const notified = new Set<string>();
  assert.equal(shouldOfferInterruptedRecovery({
    sessionId: "parent-a",
    notifiedSessionIds: notified,
    mode: "off",
    resumableCount: 1,
  }), false);
  assert.equal(shouldOfferInterruptedRecovery({
    sessionId: "parent-a",
    notifiedSessionIds: notified,
    mode: "notify",
    resumableCount: 0,
  }), false);
  assert.equal(shouldOfferInterruptedRecovery({
    sessionId: "parent-a",
    notifiedSessionIds: notified,
    mode: "notify",
    resumableCount: 1,
  }), true);
  notified.add("parent-a");
  assert.equal(shouldOfferInterruptedRecovery({
    sessionId: "parent-a",
    notifiedSessionIds: notified,
    mode: "notify",
    resumableCount: 1,
  }), false);
  assert.equal(shouldOfferInterruptedRecovery({
    sessionId: "parent-b",
    notifiedSessionIds: notified,
    mode: "auto",
    resumableCount: 2,
  }), true);
});

test("auto resume reports missing agent and resume throws as structured failures", async () => {
  const task = record();
  const missing = await attemptAutoResume({
    record: task,
    agent: undefined,
    acquire: async () => { throw new Error("should not acquire"); },
    resume: async () => { throw new Error("should not resume"); },
    release: () => { throw new Error("should not release"); },
  });
  assert.deepEqual(missing, {
    ok: false,
    record: task,
    error: "Agent definition no longer exists: verification",
  });

  let released = 0;
  const thrown = await attemptAutoResume({
    record: task,
    agent: { name: "verification" } as AgentDefinition,
    acquire: async () => {},
    resume: async () => { throw new Error("No persisted child session for task"); },
    release: () => { released++; },
  });
  assert.equal(thrown.ok, false);
  if (!thrown.ok) assert.match(thrown.error, /No persisted child session/);
  assert.equal(released, 1);
});

test("auto resume success is an explicit ok result, not a string prefix", async () => {
  const task = record({ status: "running", terminationKind: undefined });
  const outcome = await attemptAutoResume({
    record: task,
    agent: { name: "verification" } as AgentDefinition,
    acquire: async () => {},
    resume: async () => ({ record: task }) as LiveTask,
    release: () => { throw new Error("should not release on success"); },
  });
  assert.deepEqual(outcome, { ok: true, record: task });
});

test("auto resume failure from resumeCompletedTask is never classified by string prefix", async () => {
  const task = record();
  const outcome = await attemptAutoResume({
    record: task,
    agent: { name: "verification" } as AgentDefinition,
    acquire: async () => {},
    resume: async () => { throw new Error("Resume failed for Verify release baseline fixes: boom"); },
    release: () => {},
  });
  assert.equal(outcome.ok, false);
  const successNotice = formatInterruptedTasksNotice(
    selectInterruptedTasks([task], () => true),
    { autoResumed: true, failures: [outcome] },
  );
  assert.ok(successNotice);
  assert.equal(successNotice.includes("resumed automatically"), false);
  assert.match(successNotice, /SendMessage/);
});

test("quota acquire uses the parent signal when present and otherwise a timeout", () => {
  const parent = AbortSignal.abort();
  assert.equal(quotaAcquireSignal(parent), parent);
  const bounded = quotaAcquireSignal(undefined, 5);
  assert.equal(bounded.aborted, false);
});

test("auto resume reports quota abort as a structured failure", async () => {
  const task = record();
  const outcome = await attemptAutoResume({
    record: task,
    agent: { name: "verification" } as AgentDefinition,
    acquire: async () => { throw new Error("Task quota acquisition aborted"); },
    resume: async () => { throw new Error("should not resume"); },
    release: () => { throw new Error("should not release"); },
  });
  assert.deepEqual(outcome, {
    ok: false,
    record: task,
    error: "Task quota acquisition aborted",
  });
});

test("reload orphans only running records that are not live", () => {
  const live = new Set(["live-task"]);
  assert.equal(shouldOrphanRestoredTask({ id: "live-task", status: "running" }, live), false);
  assert.equal(shouldOrphanRestoredTask({ id: "dead-task", status: "running" }, live), true);
  assert.equal(shouldOrphanRestoredTask({ id: "stopped-task", status: "stopped" }, live), false);
});

test("parent shutdown persist writes stopped/parent_shutdown before awaiting stop", async () => {
  const persisted: TaskRecord[] = [];
  let resolveStop!: () => void;
  let stopStarted!: () => void;
  const stopGate = new Promise<void>(resolve => { stopStarted = resolve; });
  const recordState = record({
    id: "live-task",
    status: "running",
    terminationKind: undefined,
    completedAt: undefined,
  });
  const live: LiveTask = {
    record: recordState,
    abortController: new AbortController(),
    promise: new Promise(() => {}),
    send: async () => {},
    stop: async () => {
      stopStarted();
      await new Promise<void>(resolve => { resolveStop = resolve; });
    },
  };
  const liveIds = new Set([live.record.id]);

  const persistPromise = persistLiveTasksForParentShutdown([live], async (saved) => {
    persisted.push({ ...saved });
  });
  await stopGate;
  for (let i = 0; i < 20 && persisted.length === 0; i++) await Promise.resolve();
  assert.equal(persisted.length, 1, "owner persists before stop resolves");
  assert.equal(persisted[0]!.status, "stopped");
  assert.equal(persisted[0]!.terminationKind, "parent_shutdown");
  assert.equal(shouldOrphanRestoredTask(persisted[0]!, new Set()), false);
  assert.equal(shouldOrphanRestoredTask(recordState, liveIds), false);
  resolveStop();
  await persistPromise;
});
