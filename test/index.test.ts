import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createCompletionDeduper, formatTaskDiagnostic, taskNotification } from "../src/index.ts";
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
