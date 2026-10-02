import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import register, {
  AgentParams,
  TaskSpecSchema,
  buildNotificationMessage,
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

// --- Background parent-notification delivery (buffered steer dispatch) ---

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

function recordingPi(sent: SentCall[]): ParentPi {
  return {
    sendMessage(message: SentCall["message"], options: unknown) {
      sent.push({ message, options });
    },
  } as ParentPi;
}

function harnessWithPi(pi: ParentPi, sent: SentCall[]) {
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

function notifierHarness() {
  const sent: SentCall[] = [];
  return harnessWithPi(recordingPi(sent), sent);
}

async function drainMicrotasks() {
  await new Promise<void>(resolve => setImmediate(resolve));
}

function completedTask(id: string): TaskRecord {
  return { ...partialTask(), id, status: "completed" as const };
}

function runningTask(id: string): TaskRecord {
  return { ...partialTask(), id, status: "running" as const, completedAt: undefined };
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

test("busy-parent arrivals buffer until turn_end, then steer once as one merged message", async () => {
  const h = notifierHarness();
  h.onAgentStart();
  h.notifyCompletion(completedTask("task-a"));
  h.notifyProgressWarning(runningTask("task-b"), WARNING_DETAILS);
  // While the parent is streaming, nothing is delivered per arrival — not even on the microtask queue.
  await drainMicrotasks();
  assert.equal(h.sent.length, 0);
  h.onTurnEnd();
  assert.equal(h.sent.length, 1);
  const flushed = h.sent[0]!;
  assert.deepEqual(flushed.options, { triggerTurn: true, deliverAs: "steer" });
  assert.equal(flushed.message.customType, "pi-subagent-notification-batch");
  assert.equal(flushed.message.display, true);
  const content = String(flushed.message.content);
  assert.match(content, /<task-notification>[\s\S]*task-a[\s\S]*<\/task-notification>/);
  assert.match(content, /<progress-warning>[\s\S]*task-b[\s\S]*<\/progress-warning>/);
  // turn_end flush drained the buffer; a second turn_end does not resend.
  h.onTurnEnd();
  assert.equal(h.sent.length, 1);
});

test("idle arrivals in the same tick flush once; later arrivals flush separately", async () => {
  const h = notifierHarness();
  h.notifyCompletion(completedTask("task-a"));
  h.notifyCompletion(completedTask("task-b"));
  await drainMicrotasks();
  assert.equal(h.sent.length, 1);
  const content = String(h.sent[0]!.message.content);
  assert.match(content, /task-a/);
  assert.match(content, /task-b/);
  assert.deepEqual(h.sent[0]!.options, { triggerTurn: true, deliverAs: "steer" });
  h.notifyCompletion(completedTask("task-c"));
  await drainMicrotasks();
  assert.equal(h.sent.length, 2);
});

test("single-item flush keeps the legacy per-kind customType and details for renderer compatibility", async () => {
  const h = notifierHarness();
  const record = completedTask("task-a");
  h.notifyCompletion(record);
  await drainMicrotasks();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0]!.message.customType, "pi-subagent-notification");
  assert.equal(h.sent[0]!.message.details, record);
  const warningRecord = runningTask("task-b");
  h.notifyProgressWarning(warningRecord, WARNING_DETAILS);
  await drainMicrotasks();
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1]!.message.customType, "pi-subagent-progress-warning");
  assert.deepEqual(h.sent[1]!.message.details, { ...warningRecord, progressWarning: WARNING_DETAILS });
});

test("completion overwrites a pending warning for the same execution", () => {
  const h = notifierHarness();
  h.onAgentStart();
  h.notifyProgressWarning(runningTask("task-a"), WARNING_DETAILS);
  h.notifyCompletion(completedTask("task-a"));
  h.onTurnEnd();
  assert.equal(h.sent.length, 1);
  const content = String(h.sent[0]!.message.content);
  assert.match(content, /<task-notification>/);
  assert.equal(content.includes("<progress-warning>"), false);
});

test("warning after a terminal completion does not revive the warning", () => {
  const h = notifierHarness();
  h.onAgentStart();
  h.notifyCompletion(completedTask("task-a"));
  h.notifyProgressWarning(runningTask("task-a"), WARNING_DETAILS);
  h.onTurnEnd();
  assert.equal(h.sent.length, 1);
  const content = String(h.sent[0]!.message.content);
  assert.match(content, /<task-notification>/);
  assert.equal(content.includes("<progress-warning>"), false);
});

test("ackObservedFinal drops pending delivery for the current invocation without swallowing the next one", async () => {
  const h = notifierHarness();
  h.onAgentStart();
  h.notifyCompletion(completedTask("task-a"));
  // TaskOutput returned the final result: the buffered completion must not be re-delivered.
  h.ackObservedFinal("task-a");
  h.onTurnEnd();
  assert.equal(h.sent.length, 0);
  // A later invocation of the same task still notifies normally.
  const gen = h.beginInvocation("task-a");
  h.notifyCompletion({ ...completedTask("task-a"), status: "stopped" as const, terminationKind: "manual_stop" }, gen);
  h.onTurnEnd();
  assert.equal(h.sent.length, 1);
  assert.match(String(h.sent[0]!.message.content), /<status>stopped<\/status>/);
});

test("resume generation: the new execution notifies, a late old callback is dropped entirely", async () => {
  const h = notifierHarness();
  const first = completedTask("task-a");
  const gen1 = h.beginInvocation("task-a");
  h.notifyCompletion(first, gen1);
  await drainMicrotasks();
  assert.equal(h.sent.length, 1);
  const gen2 = h.beginInvocation("task-a");
  // Late callback from the finished execution: no send, and no bookkeeping corruption.
  const late = { ...first, error: "late duplicate" };
  h.notifyCompletion(late, gen1);
  await drainMicrotasks();
  assert.equal(h.sent.length, 1);
  assert.notEqual(h.known.get("task-a"), late);
  // The resumed execution's completion is delivered.
  h.notifyCompletion({ ...completedTask("task-a"), description: "Second run" }, gen2);
  await drainMicrotasks();
  assert.equal(h.sent.length, 2);
  assert.match(String(h.sent[1]!.message.content), /Second run/);
});

test("foreground-held first warning is suppressed; later warnings still notify", async () => {
  const h = notifierHarness();
  h.holdForegroundWarning("task-a");
  h.notifyProgressWarning(runningTask("task-a"), WARNING_DETAILS);
  await drainMicrotasks();
  // The releasing Agent tool result already carried this checkpoint to the model.
  assert.equal(h.sent.length, 0);
  h.notifyProgressWarning(runningTask("task-a"), { ...WARNING_DETAILS, turn: 65, nextWarningTurn: 90, warningCount: 2 });
  await drainMicrotasks();
  assert.equal(h.sent.length, 1);
  assert.match(String(h.sent[0]!.message.content), /turn="65"/);
  h.releaseForegroundWarning("task-a");
});

test("foreground completion returns through the tool call; no root notification even after flush", () => {
  const h = notifierHarness();
  h.onAgentStart();
  h.notifyCompletion({ ...completedTask("task-a"), background: false });
  h.onTurnEnd();
  assert.equal(h.sent.length, 0);
});

test("session shutdown cancels pending and late callbacks without crossing sessions", async () => {
  const h = notifierHarness();
  h.onAgentStart();
  h.notifyCompletion(completedTask("task-a"));
  h.onSessionShutdown();
  h.onTurnEnd();
  h.onAgentSettled();
  await drainMicrotasks();
  assert.equal(h.sent.length, 0);
  // Late callbacks after shutdown never buffer or send.
  h.notifyCompletion(completedTask("task-b"));
  h.notifyProgressWarning(runningTask("task-c"), WARNING_DETAILS);
  await drainMicrotasks();
  assert.equal(h.sent.length, 0);
});

test("agent_settled flushes leftovers when the run ends without another turn_end", () => {
  const h = notifierHarness();
  h.onAgentStart();
  h.notifyCompletion(completedTask("task-a"));
  h.onAgentSettled();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0]!.options, { triggerTurn: true, deliverAs: "steer" });
});

test("flush survives a stale parent ctx; real send failures stay observable", () => {
  const stale = harnessWithPi({ sendMessage() { throw new Error(STALE_CTX_MESSAGE); } }, []);
  stale.onAgentStart();
  stale.notifyCompletion(completedTask("task-a"));
  assert.doesNotThrow(() => stale.onTurnEnd());

  const broken = harnessWithPi({ sendMessage() { throw new Error("renderer queue exploded"); } }, []);
  broken.onAgentStart();
  broken.notifyCompletion(completedTask("task-a"));
  assert.throws(() => broken.onTurnEnd(), /renderer queue exploded/);
  // Near-miss stale messages are not swallowed.
  const nearMiss = harnessWithPi({ sendMessage() { throw new Error("This extension ctx was stale after session replacement or reload."); } }, []);
  nearMiss.onAgentStart();
  nearMiss.notifyCompletion(completedTask("task-a"));
  assert.throws(() => nearMiss.onTurnEnd(), /was stale after session replacement/);
});

test("fire-and-forget stale flush leaves no unhandled rejection", async () => {
  const notifiers = harnessWithPi({ sendMessage() { throw new Error(STALE_CTX_MESSAGE); } }, []);
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    // Idle arrival schedules the flush on the microtask queue, like a background task
    // completion on a path no runner handler guards.
    void Promise.resolve().then(() => notifiers.notifyCompletion(completedTask("task-a")));
    await new Promise(resolve => setTimeout(resolve, 25));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});

test("completion bookkeeping stays exact through the buffered path", () => {
  const sent: SentCall[] = [];
  const known = new Map<string, TaskRecord>();
  const taskQuota = createTaskQuota(4);
  const quotaTasks = new Set<string>(["task-a"]);
  taskQuota.tryAcquire();
  const notifiers = createBackgroundNotifiers({
    pi: recordingPi(sent),
    config: () => DEFAULT_CONFIG,
    taskQuota,
    quotaTasks,
    completionDeduper: createCompletionDeduper(),
    known,
    live: new Map<string, LiveTask>(),
  });
  const record = completedTask("task-a");
  notifiers.notifyCompletion(record);
  // Duplicate completion callback for this invocation is deduplicated before buffering.
  notifiers.notifyCompletion(record);
  notifiers.flushPending();
  assert.equal(sent.length, 1);
  assert.equal(taskQuota.inUse, 0);
  assert.equal(known.get("task-a"), record);
});

test("progress warning notification carries stage preview and honest freshness markers", () => {
  const task = runningTask("task-a");
  task.preview = "Tracing refresh callers";
  task.warningTurns = 30;
  task.warningIntervalTurns = 20;
  task.nextWarningTurn = 50;
  const details = { turn: 30, nextWarningTurn: 50, warningCount: 1, warningTurns: 30, warningIntervalTurns: 20 };
  const fresh = progressWarningNotification(task, details);
  assert.match(fresh, /<preview>Tracing refresh callers<\/preview>/);
  assert.match(fresh, /<output-file>/);
  assert.equal(fresh.includes("Inspect current state once with TaskOutput"), false);
  const stale = progressWarningNotification(task, { ...details, warningCount: 2 }, { previewUnchanged: true });
  assert.match(stale, /<preview_state>unchanged since the previous checkpoint<\/preview_state>/);
});

test("repeated warnings mark an unchanged preview instead of implying progress", async () => {
  const h = notifierHarness();
  const task = runningTask("task-a");
  task.preview = "same stage note";
  h.notifyProgressWarning(task, WARNING_DETAILS);
  await drainMicrotasks();
  h.notifyProgressWarning(task, { ...WARNING_DETAILS, turn: 65, nextWarningTurn: 90, warningCount: 2 });
  await drainMicrotasks();
  assert.equal(h.sent.length, 2);
  const first = String(h.sent[0]!.message.content);
  const second = String(h.sent[1]!.message.content);
  assert.equal(first.includes("<preview_state>"), false);
  assert.match(second, /<preview_state>unchanged since the previous checkpoint<\/preview_state>/);
});

test("batch notification message wraps per-task XML blocks with item records", () => {
  const completion = completedTask("task-a");
  const warning = runningTask("task-b");
  const message = buildNotificationMessage([
    { kind: "completion", record: completion, content: taskNotification(completion, "done") },
    { kind: "warning", record: warning, content: progressWarningNotification(warning, WARNING_DETAILS), progressWarning: WARNING_DETAILS },
  ]);
  assert.equal(message.customType, "pi-subagent-notification-batch");
  assert.equal(message.display, true);
  assert.match(String(message.content), /<task-notification>[\s\S]*<progress-warning>/);
  const items = (message.details as { items: Array<{ kind: string; record: TaskRecord }> }).items;
  assert.equal(items.length, 2);
  assert.equal(items[0]!.kind, "completion");
  assert.equal(items[0]!.record, completion);
  assert.equal(items[1]!.kind, "warning");
  assert.equal(items[1]!.record, warning);
});

// --- register() wiring ---

function registrationPi() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const renderers = new Map<string, unknown>();
  const tools = new Map<string, { name: string; description?: string }>();
  const commands = new Map<string, unknown>();
  const sent: SentCall[] = [];
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    registerMessageRenderer(type: string, renderer: unknown) { renderers.set(type, renderer); },
    registerTool(tool: { name: string; description?: string }) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: unknown) { commands.set(name, command); },
    sendMessage: recordingPi(sent).sendMessage,
    getActiveTools: () => [] as string[],
    getAllTools: () => [] as unknown[],
    getThinkingLevel: () => "medium" as const,
  };
  return { pi: pi as unknown as ExtensionAPI, handlers, renderers, tools, commands, sent };
}

test("register wires notification lifecycle to agent events and a batch renderer", () => {
  const reg = registrationPi();
  register(reg.pi);
  // Lifecycle hooks keep the dispatcher's parent-busy state consistent.
  for (const event of ["agent_start", "turn_end", "agent_settled", "session_shutdown"]) {
    assert.ok(reg.handlers.has(event), `missing handler for ${event}`);
  }
  assert.ok(reg.renderers.has("pi-subagent-notification-batch"));
  // Tool guidance no longer mandates a TaskOutput inspection per warning.
  const taskOutput = reg.tools.get("TaskOutput");
  assert.ok(taskOutput);
  assert.equal(/legitimizes one TaskOutput inspection/.test(String(taskOutput.description)), false);
});
