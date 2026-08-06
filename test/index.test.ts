import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import register, {
  AgentParams,
  TaskSpecSchema,
  createCompletionDeduper,
  formatTaskDiagnostic,
  inheritTaskWarningPolicy,
  progressWarningNotification,
  taskNotification,
  waitForLaunchedForegroundTasks,
} from "../src/index.ts";
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
