import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import register, { AgentParams, TaskSpecSchema, createCompletionDeduper, formatTaskDiagnostic, inheritTaskWarningPolicy, progressWarningNotification, taskNotification } from "../src/index.ts";
import type { TaskRecord } from "../src/tasks.ts";

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
