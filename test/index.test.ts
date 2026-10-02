import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import register, {
  AgentParams,
  TaskSpecSchema,
  createBackgroundNotifiers,
  createCompletionDeduper,
  formatTaskDiagnostic,
  inheritTaskWarningPolicy,
  isStaleExtensionContextError,
  progressWarningNotification,
  taskNotification,
  waitForLaunchedForegroundTasks,
} from "../src/index.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { createTaskQuota, type ProgressWarningDetails } from "../src/runtime.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LiveTask, TaskRecord } from "../src/tasks.ts";

function partialTask(): TaskRecord {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-index-test-"));
  return {
    id: "task-id",
    parentSessionId: "parent",
    agent: "Plan",
    description: "Plan repair",
    prompt: "prompt",
    cwd: dir,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    status: "partial",
    terminationKind: "timeout",
    background: true,
    forked: false,
    maxTurns: 8,
    maxToolCalls: 30,
    timeoutMs: 300_000,
    outputFile: path.join(dir, "output.md"),
    taskFile: path.join(dir, "task.json"),
    error: "Task timed out after 300000ms",
    usage: {
      input: 90_807,
      output: 2_784,
      cacheRead: 101_376,
      cacheWrite: 0,
      cost: 0,
      turns: 6,
      toolCalls: 30,
      toolCallsRequested: 35,
      toolCallsExecuted: 30,
      toolCallsBlocked: 5,
    },
  };
}

test("public Agent schemas require explicit supervision and omit hard budgets", () => {
  const topLevel = AgentParams as unknown as { properties: Record<string, unknown>; required?: string[] };
  const taskLevel = TaskSpecSchema as unknown as { properties: Record<string, unknown>; required?: string[] };
  for (const schema of [topLevel, taskLevel]) {
    assert.equal("max_turns" in schema.properties, false);
    assert.equal("max_tool_calls" in schema.properties, false);
    assert.equal("timeout_ms" in schema.properties, false);
  }
  assert.equal("warning_turns" in topLevel.properties, true);
  assert.equal("warning_interval_turns" in topLevel.properties, true);
  assert.ok(topLevel.required?.includes("warning_turns"));
  assert.ok(topLevel.required?.includes("warning_interval_turns"));
  assert.equal("warning_turns" in taskLevel.properties, true);
  assert.equal("warning_interval_turns" in taskLevel.properties, true);
  assert.equal(taskLevel.required?.includes("warning_turns") ?? false, false);
  assert.equal(taskLevel.required?.includes("warning_interval_turns") ?? false, false);
  assert.equal(typeof register, "function");
});

test("tasks-array warning policy inherits top-level values and preserves overrides", () => {
  const tasks = inheritTaskWarningPolicy([
    { description: "inherit" },
    { description: "override first", warning_turns: 12 },
    { description: "override both", warning_turns: 8, warning_interval_turns: 3 },
  ], { warning_turns: 30, warning_interval_turns: 20 });
  assert.deepEqual(tasks, [
    { description: "inherit", warning_turns: 30, warning_interval_turns: 20 },
    { description: "override first", warning_turns: 12, warning_interval_turns: 20 },
    { description: "override both", warning_turns: 8, warning_interval_turns: 3 },
  ]);
});

test("progress warning notification is structured and actionable", () => {
  const task = partialTask();
  task.status = "running";
  task.preview = "Tracing refresh callers";
  task.warningTurns = 30;
  task.warningIntervalTurns = 20;
  task.nextWarningTurn = 50;
  const notification = progressWarningNotification(task, {
    turn: 30,
    nextWarningTurn: 50,
    warningCount: 1,
    warningTurns: 30,
    warningIntervalTurns: 20,
  });
  assert.match(notification, /<progress-warning>/);
  assert.match(notification, /turn="30" next="50"/);
  assert.match(notification, /TaskOutput/);
  assert.match(notification, /SendMessage/);
  assert.match(notification, /TaskStop/);
});


test("completion deduper suppresses duplicate callback for one invocation but permits resume", () => {
  const dedupe = createCompletionDeduper();
  assert.equal(dedupe.shouldHandle("task-id"), true);
  assert.equal(dedupe.shouldHandle("task-id"), false);
  dedupe.beginInvocation("task-id");
  assert.equal(dedupe.shouldHandle("task-id"), true);
});

test("task diagnostic exposes lifecycle, tool accounting, and thinking clamp", () => {
  const task = partialTask();
  task.requestedThinking = "high";
  task.effectiveThinking = "off";
  task.thinking = "off";
  task.thinkingClampReason = "Model metadata reports reasoning unsupported; requested high, effective off.";
  const diagnostic = formatTaskDiagnostic(task);
  assert.match(diagnostic, /termination: timeout \(partial\)/);
  assert.match(diagnostic, /usage\.tools: requested=35 executed=30 blocked=5/);
  assert.match(diagnostic, /thinking: requested=high effective=off/);
  assert.match(diagnostic, /reasoning unsupported/);
});

test("task notification preserves partial status and detailed tool accounting", () => {
  const notification = taskNotification(partialTask(), "partial output");
  assert.match(notification, /<status>partial<\/status>/);
  assert.match(notification, /<termination>timeout<\/termination>/);
  assert.match(notification, /<tool_uses>30<\/tool_uses>/);
  assert.match(notification, /<tool_calls_requested>35<\/tool_calls_requested>/);
  assert.match(notification, /<tool_calls_executed>30<\/tool_calls_executed>/);
  assert.match(notification, /<tool_calls_blocked>5<\/tool_calls_blocked>/);
});

function mockLiveTask(options: {
  background: boolean;
  stop?: () => void;
  settleMs?: number;
  releaseMs?: number;
}): LiveTask {
  const settleMs = options.settleMs ?? 50;
  let resolvePromise!: (record: TaskRecord) => void;
  let resolveReleased!: () => void;
  const record: TaskRecord = {
    ...partialTask(),
    status: "running",
    background: options.background,
    completedAt: undefined,
  };
  const promise = new Promise<TaskRecord>(resolve => {
    resolvePromise = resolve;
    if (options.releaseMs === undefined) {
      setTimeout(() => resolve(record), settleMs);
    }
  });
  const foregroundReleased = options.releaseMs === undefined
    ? undefined
    : new Promise<void>(resolve => {
      resolveReleased = resolve;
      setTimeout(() => {
        record.background = true;
        resolve();
      }, options.releaseMs);
    });
  return {
    record,
    abortController: new AbortController(),
    promise,
    foregroundReleased,
    send: async () => {},
    stop: async () => {
      options.stop?.();
      record.status = "stopped";
      record.terminationKind = "manual_stop";
      record.error = "Stopped by parent.";
      resolvePromise(record);
      resolveReleased?.();
    },
  };
}

test("parent AbortSignal stops a blocked foreground Agent wait", async () => {
  let stopped = 0;
  const task = mockLiveTask({
    background: false,
    settleMs: 60_000,
    stop: () => { stopped++; },
  });
  const controller = new AbortController();
  const wait = waitForLaunchedForegroundTasks([task], controller.signal);
  await Promise.resolve();
  controller.abort();
  await wait;
  assert.equal(stopped, 1);
  assert.equal(task.record.status, "stopped");
});

test("progress-promoted background children survive parent AbortSignal", async () => {
  let stopped = 0;
  const task = mockLiveTask({
    background: false,
    releaseMs: 5,
    stop: () => { stopped++; },
  });
  const controller = new AbortController();
  const wait = waitForLaunchedForegroundTasks([task], controller.signal);
  await wait;
  assert.equal(task.record.background, true);
  controller.abort();
  await Promise.resolve();
  assert.equal(stopped, 0);
  assert.equal(task.record.status, "running");
});

test("already-aborted signal stops foreground wait immediately", async () => {
  let stopped = 0;
  const task = mockLiveTask({
    background: false,
    settleMs: 60_000,
    stop: () => { stopped++; },
  });
  const controller = new AbortController();
  controller.abort();
  await waitForLaunchedForegroundTasks([task], controller.signal);
  assert.equal(stopped, 1);
  assert.equal(task.record.status, "stopped");
});

test("abort during in-flight launch is recovered by post-push aborted recheck pattern", async () => {
  // Models the production invariant: AbortSignal fires only once. If it fires while
  // launchTask is awaited (before push), the listener may see an empty launched array.
  // Production re-checks signal.aborted after push and calls abortBlocking again.
  const launched: LiveTask[] = [];
  let stopped = 0;
  const controller = new AbortController();
  const abortBlocking = () => {
    for (const task of launched) {
      if (!task.record.background) void task.stop("manual_stop");
    }
  };
  controller.signal.addEventListener("abort", abortBlocking, { once: true });

  // Abort before the child exists in `launched` (empty listener pass).
  controller.abort();
  abortBlocking(); // listener already ran with empty array
  assert.equal(stopped, 0);

  const task = mockLiveTask({
    background: false,
    settleMs: 60_000,
    stop: () => { stopped++; },
  });
  launched.push(task);
  // Post-push recovery — same check production performs after launchTask.
  if (controller.signal.aborted) abortBlocking();
  await waitForLaunchedForegroundTasks(launched, controller.signal);
  // stop may be invoked more than once (post-push recovery + already-aborted wait helper);
  // production stop is lifecycle-idempotent. Require at least one stop and terminal status.
  assert.ok(stopped >= 1);
  assert.equal(task.record.status, "stopped");
});

// --- Background parent-notification delivery (stale parent ctx contract) ---

const STALE_CTX_MESSAGE = "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().";

const WARNING_DETAILS: ProgressWarningDetails = {
  turn: 40,
  nextWarningTurn: 65,
  warningCount: 1,
  warningTurns: 40,
  warningIntervalTurns: 25,
};

type ParentPi = Pick<ExtensionAPI, "sendMessage">;
type SentCall = { message: { customType: string; content: unknown; display: boolean; details: unknown }; options: unknown };

function notifierHarness(onSend?: (message: SentCall["message"]) => void) {
  const sent: SentCall[] = [];
  const pi = {
    sendMessage(message: SentCall["message"], options: unknown) {
      sent.push({ message, options });
      onSend?.(message);
    },
  } as ParentPi;
  const known = new Map<string, TaskRecord>();
  const taskQuota = createTaskQuota(4);
  const notifiers = createBackgroundNotifiers({
    pi,
    config: () => DEFAULT_CONFIG,
    taskQuota,
    quotaTasks: new Set<string>(),
    completionDeduper: createCompletionDeduper(),
    known,
    live: new Map<string, LiveTask>(),
  });
  return { sent, known, taskQuota, ...notifiers };
}

function notifiersWithPi(pi: ParentPi) {
  return createBackgroundNotifiers({
    pi,
    config: () => DEFAULT_CONFIG,
    taskQuota: createTaskQuota(4),
    quotaTasks: new Set<string>(),
    completionDeduper: createCompletionDeduper(),
    known: new Map<string, TaskRecord>(),
    live: new Map<string, LiveTask>(),
  });
}

test("stale ctx detection matches exactly the runner invalidate contract", () => {
  assert.equal(isStaleExtensionContextError(new Error(STALE_CTX_MESSAGE)), true);
  assert.equal(isStaleExtensionContextError(new Error(`${STALE_CTX_MESSAGE} with extra trailing context`)), true);
  // Near-miss messages must not be treated as the stale contract.
  assert.equal(isStaleExtensionContextError(new Error("This extension ctx was stale after session replacement or reload.")), false);
  assert.equal(isStaleExtensionContextError(new Error("This extension ctx is stale after session replacement or reload (no period)")), false);
  assert.equal(isStaleExtensionContextError(new Error("Extension ctx is stale")), false);
  assert.equal(isStaleExtensionContextError(STALE_CTX_MESSAGE), false);
  assert.equal(isStaleExtensionContextError(undefined), false);
});

test("background completion survives a stale parent ctx without unhandled rejection", async () => {
  const notifiers = notifiersWithPi({ sendMessage() { throw new Error(STALE_CTX_MESSAGE); } });
  const record = { ...partialTask(), status: "completed" as const };
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    // Fire-and-forget like the runtime's background completion path (task promise finally).
    void Promise.resolve().then(() => notifiers.notifyCompletion(record));
    await new Promise(resolve => setTimeout(resolve, 25));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});

test("progress warning send survives a stale parent ctx", () => {
  const notifiers = notifiersWithPi({ sendMessage() { throw new Error(STALE_CTX_MESSAGE); } });
  const record = { ...partialTask(), status: "running" as const };
  assert.doesNotThrow(() => notifiers.notifyProgressWarning(record, WARNING_DETAILS));
  assert.equal(record.background, true);
});

test("background notifications keep real send failures observable", async () => {
  const notifiers = notifiersWithPi({ sendMessage() { throw new Error("renderer queue exploded"); } });
  const record = { ...partialTask(), status: "completed" as const };
  await assert.rejects(
    Promise.resolve().then(() => notifiers.notifyCompletion(record)),
    /renderer queue exploded/,
  );
  assert.throws(() => notifiers.notifyProgressWarning({ ...partialTask(), status: "running" as const }, WARNING_DETAILS), /renderer queue exploded/);
});

test("near-miss stale messages are not swallowed by background notifiers", async () => {
  const notifiers = notifiersWithPi({ sendMessage() { throw new Error("This extension ctx was stale after session replacement or reload."); } });
  await assert.rejects(
    Promise.resolve().then(() => notifiers.notifyCompletion({ ...partialTask(), status: "completed" as const })),
    /was stale after session replacement/,
  );
});

test("successful background notifications preserve content, options, and bookkeeping", () => {
  const harness = notifierHarness();
  const record = { ...partialTask(), status: "completed" as const };
  const quotaTasks = new Set<string>([record.id]);
  harness.taskQuota.tryAcquire();
  const tracked = createBackgroundNotifiers({
    pi: {
      sendMessage(message: SentCall["message"], options: unknown) {
        harness.sent.push({ message, options });
      },
    } as ParentPi,
    config: () => DEFAULT_CONFIG,
    taskQuota: harness.taskQuota,
    quotaTasks,
    completionDeduper: createCompletionDeduper(),
    known: harness.known,
    live: new Map<string, LiveTask>(),
  });

  tracked.notifyCompletion(record);
  assert.equal(harness.sent.length, 1);
  const completion = harness.sent[0]!;
  assert.equal(completion.message.customType, "pi-subagent-notification");
  assert.match(String(completion.message.content), /<task-notification>/);
  assert.equal(completion.message.display, true);
  assert.equal(completion.message.details, record);
  assert.deepEqual(completion.options, { triggerTurn: true, deliverAs: "followUp" });
  // Deduper suppresses the duplicate completion callback for this invocation.
  tracked.notifyCompletion(record);
  assert.equal(harness.sent.length, 1);
  // Quota slot released exactly once, and known/live bookkeeping updated.
  assert.equal(harness.taskQuota.inUse, 0);
  assert.equal(harness.known.get(record.id), record);
  // Foreground completions return through the tool call; no root notification.
  tracked.notifyCompletion({ ...partialTask(), id: "foreground-task", background: false, status: "completed" as const });
  assert.equal(harness.sent.length, 1);

  const warningRecord = { ...partialTask(), status: "running" as const };
  tracked.notifyProgressWarning(warningRecord, WARNING_DETAILS);
  assert.equal(harness.sent.length, 2);
  const warning = harness.sent[1]!;
  assert.equal(warning.message.customType, "pi-subagent-progress-warning");
  assert.match(String(warning.message.content), /<progress-warning>/);
  assert.equal(warning.message.display, true);
  assert.deepEqual(warning.message.details, { ...warningRecord, progressWarning: WARNING_DETAILS });
  assert.deepEqual(warning.options, { triggerTurn: true, deliverAs: "followUp" });
});
