import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { discoverAgents, findAgent } from "../src/agents.ts";
import { createChildLifecycleController } from "../src/lifecycle.ts";
import {
  FINAL_HANDOFF_DIRECTIVE,
  applyAssistantTokenUsage,
  applyLifecycleUsage,
  clearQueuedMessagesAfterFinalHandoff,
  createChildLifecycleExtension,
  deriveThinkingClampReason,
  finalizeInvocationRecord,
  type LifecycleUsageBaseline,
} from "../src/runtime.ts";
import type { TaskRecord } from "../src/tasks.ts";

const packageRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function taskRecord(): TaskRecord {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runtime-test-"));
  return {
    id: "task",
    parentSessionId: "parent",
    agent: "Plan",
    description: "test",
    prompt: "test",
    cwd: dir,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "running",
    background: false,
    forked: false,
    maxTurns: 8,
    maxToolCalls: 30,
    timeoutMs: 60_000,
    outputFile: path.join(dir, "output.md"),
    taskFile: path.join(dir, "task.json"),
    usage: {
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      cost: 1,
      turns: 2,
      toolCalls: 3,
      toolCallsRequested: 4,
      toolCallsExecuted: 3,
      toolCallsBlocked: 1,
    },
  };
}

function assistant(options: {
  text?: string;
  toolCalls?: number;
  stopReason?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
} = {}): Extract<AgentMessage, { role: "assistant" }> {
  const content: Array<Record<string, unknown>> = [];
  if (options.text) content.push({ type: "text", text: options.text });
  for (let i = 0; i < (options.toolCalls ?? 0); i++) {
    content.push({ type: "toolCall", id: `call-${i}`, name: "read", arguments: { path: "README.md" } });
  }
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "test",
    model: "test",
    usage: {
      input: options.input ?? 1,
      output: options.output ?? 2,
      cacheRead: options.cacheRead ?? 3,
      cacheWrite: options.cacheWrite ?? 4,
      totalTokens: 10,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: options.cost ?? 0.5,
      },
    },
    stopReason: options.stopReason ?? (options.toolCalls ? "toolUse" : "stop"),
    timestamp: Date.now(),
  } as unknown as Extract<AgentMessage, { role: "assistant" }>;
}

test("runtime usage keeps tokens cumulative and lifecycle tools authoritative", () => {
  const record = taskRecord();
  const baseline: LifecycleUsageBaseline = {
    turns: record.usage.turns,
    toolCallsRequested: record.usage.toolCallsRequested,
    toolCallsExecuted: record.usage.toolCallsExecuted,
    toolCallsBlocked: record.usage.toolCallsBlocked,
  };

  applyAssistantTokenUsage(record, assistant({ input: 5, output: 6, cacheRead: 7, cacheWrite: 8, cost: 2 }));
  applyLifecycleUsage(record, baseline, {
    turns: 1,
    toolCallsRequested: 35,
    toolCallsExecuted: 30,
    toolCallsBlocked: 5,
  });

  assert.deepEqual(record.usage, {
    input: 15,
    output: 26,
    cacheRead: 37,
    cacheWrite: 48,
    cost: 3,
    turns: 3,
    toolCalls: 33,
    toolCallsRequested: 39,
    toolCallsExecuted: 33,
    toolCallsBlocked: 6,
  });
});

test("invocation finalization preserves timeout cause and rejects stale progress fallback", () => {
  const record = taskRecord();
  record.usage = {
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
  };
  const lifecycle = createChildLifecycleController({
    maxTurns: 8,
    maxToolCalls: 30,
    toolBudgetBlock: "*",
  });
  for (let i = 0; i < 35; i++) lifecycle.admitTool("read");
  lifecycle.requestStop("timeout");
  const messages = [
    assistant({ text: "I am still researching.", stopReason: "toolUse" }),
    {
      ...assistant({ stopReason: "aborted" }),
      content: [],
      errorMessage: "Request was aborted",
    },
  ];

  const output = finalizeInvocationRecord({
    record,
    lifecycle,
    baseline: { turns: 0, toolCallsRequested: 0, toolCallsExecuted: 0, toolCallsBlocked: 0 },
    messages,
    error: "Task timed out after 300000ms",
  });

  assert.equal(record.status, "partial");
  assert.equal(record.terminationKind, "timeout");
  assert.equal(record.error, "Task timed out after 300000ms");
  assert.equal(record.usage.toolCallsRequested, 35);
  assert.equal(record.usage.toolCallsExecuted, 30);
  assert.equal(record.usage.toolCallsBlocked, 5);
  assert.doesNotMatch(output, /still researching/);
  assert.equal(output, "[Subagent ended partial: timeout. Task timed out after 300000ms]");
});

test("unexplained aborted invocation finalizes as provider failure", () => {
  const record = taskRecord();
  const lifecycle = createChildLifecycleController({ maxTurns: 8, maxToolCalls: 30 });
  lifecycle.onTurnStart();
  lifecycle.onTurnEnd({ messageHasText: false, wouldContinue: false });
  const aborted = {
    ...assistant({ stopReason: "aborted" }),
    content: [],
    errorMessage: "Request was aborted",
  };

  const output = finalizeInvocationRecord({
    record,
    lifecycle,
    baseline: {
      turns: record.usage.turns,
      toolCallsRequested: record.usage.toolCallsRequested,
      toolCallsExecuted: record.usage.toolCallsExecuted,
      toolCallsBlocked: record.usage.toolCallsBlocked,
    },
    messages: [aborted],
  });

  assert.equal(record.status, "failed");
  assert.equal(record.terminationKind, "provider_error");
  assert.equal(record.error, "Request was aborted");
  assert.equal(output, "[Subagent failed: provider_error. Request was aborted]");
});

test("startup failure is failed/startup_error without any turn", () => {
  const record = taskRecord();
  const lifecycle = createChildLifecycleController({ maxTurns: 8, maxToolCalls: 30 });
  const output = finalizeInvocationRecord({
    record,
    lifecycle,
    baseline: {
      turns: record.usage.turns,
      toolCallsRequested: record.usage.toolCallsRequested,
      toolCallsExecuted: record.usage.toolCallsExecuted,
      toolCallsBlocked: record.usage.toolCallsBlocked,
    },
    messages: [],
    error: "No API key",
    startupFailure: true,
  });
  assert.equal(record.status, "failed");
  assert.equal(record.terminationKind, "startup_error");
  assert.equal(output, "[Subagent failed: startup_error. No API key]");
});

test("thinking clamp diagnostics distinguish unsupported reasoning and unavailable levels", () => {
  assert.equal(
    deriveThinkingClampReason({ requested: "high", effective: "off", modelReasoning: false, availableLevels: ["off"] }),
    "Model metadata reports reasoning unsupported; requested high, effective off.",
  );
  assert.equal(
    deriveThinkingClampReason({ requested: "xhigh", effective: "high", modelReasoning: true, availableLevels: ["off", "low", "medium", "high"] }),
    "Requested thinking xhigh is unavailable; effective high. Available levels: off, low, medium, high.",
  );
  assert.equal(
    deriveThinkingClampReason({ requested: "high", effective: "high", modelReasoning: true, availableLevels: ["off", "high"] }),
    undefined,
  );
});

test("lifecycle extension blocks selected tools and queues a constructive wrap-up", async () => {
  const general = findAgent(discoverAgents({ cwd: packageRoot, packageRoot, includeProject: false }).agents, "general-purpose")!;
  const lifecycle = createChildLifecycleController({
    maxTurns: 2,
    graceTurns: 1,
    maxToolCalls: 1,
    toolBudgetBlock: ["read", "grep", "find", "ls"],
  });
  const handlers = new Map<string, Function>();
  const sent: Array<{ content: unknown; options: unknown }> = [];
  let aborts = 0;
  const fakePi = {
    on(event: string, handler: Function) { handlers.set(event, handler); },
    sendUserMessage(content: unknown, options: unknown) { sent.push({ content, options }); },
    getActiveTools() { return ["read", "grep", "edit"]; },
    setActiveTools() {},
  };

  (createChildLifecycleExtension(general, lifecycle, { maxTurns: 2 }) as ExtensionFactory)(fakePi as never);
  const ctx = { abort() { aborts++; }, hasPendingMessages() { return false; } };

  await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 0 }, ctx);
  assert.deepEqual(await handlers.get("tool_call")!({ toolName: "read", input: { path: "README.md" } }, ctx), undefined);
  assert.deepEqual(await handlers.get("tool_call")!({ toolName: "grep", input: { pattern: "x" } }, ctx), {
    block: true,
    reason: "Tool budget hard limit reached (1); grep is paused so the agent can finish from its current context.",
  });
  assert.deepEqual(await handlers.get("tool_call")!({ toolName: "edit", input: { path: "x.ts" } }, ctx), undefined);
  await handlers.get("turn_end")!({ type: "turn_end", turnIndex: 0, message: assistant({ toolCalls: 2 }), toolResults: [] }, ctx);

  assert.equal(sent.length, 0);

  await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 1 }, ctx);
  await handlers.get("turn_end")!({ type: "turn_end", turnIndex: 1, message: assistant({ toolCalls: 1 }), toolResults: [] }, ctx);
  assert.deepEqual(sent, [{ content: FINAL_HANDOFF_DIRECTIVE, options: { deliverAs: "steer" } }]);

  await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 2 }, ctx);
  assert.deepEqual(await handlers.get("tool_call")!({ toolName: "edit", input: { path: "x.ts" } }, ctx), undefined);
  await handlers.get("turn_end")!({ type: "turn_end", turnIndex: 2, message: assistant({ text: "Final report" }), toolResults: [] }, ctx);

  assert.equal(aborts, 0);
  assert.deepEqual(lifecycle.snapshot.usage, {
    turns: 3,
    toolCallsRequested: 4,
    toolCallsExecuted: 3,
    toolCallsBlocked: 1,
  });
});

test("soft grace does not clear the Pi message queue", () => {
  const lifecycle = createChildLifecycleController({ maxTurns: 1, graceTurns: 1, maxToolCalls: 10 });
  lifecycle.onTurnStart();
  lifecycle.onTurnEnd({ messageHasText: false, wouldContinue: true });
  lifecycle.onTurnStart();
  assert.equal(lifecycle.snapshot.phase, "final_handoff");
  let clears = 0;
  clearQueuedMessagesAfterFinalHandoff({ clearQueue() { clears++; return { steering: ["late"], followUp: [] }; } }, lifecycle);
  assert.equal(clears, 0);

  const working = createChildLifecycleController({ maxTurns: 3, graceTurns: 1, maxToolCalls: 10 });
  working.onTurnStart();
  clearQueuedMessagesAfterFinalHandoff({ clearQueue() { clears++; return { steering: [], followUp: [] }; } }, working);
  assert.equal(clears, 0);
});

test("pending Pi messages queue a constructive wrap-up at the soft turn threshold", async () => {
  const plan = findAgent(discoverAgents({ cwd: packageRoot, packageRoot, includeProject: false }).agents, "Plan")!;
  const lifecycle = createChildLifecycleController({ maxTurns: 1, graceTurns: 1, maxToolCalls: 10 });
  const handlers = new Map<string, Function>();
  const sent: unknown[] = [];
  const fakePi = {
    on(event: string, handler: Function) { handlers.set(event, handler); },
    sendUserMessage(content: unknown) { sent.push(content); },
    getActiveTools() { return ["read"]; },
    setActiveTools() {},
  };
  (createChildLifecycleExtension(plan, lifecycle, { maxTurns: 1 }) as ExtensionFactory)(fakePi as never);
  const ctx = { abort() {}, hasPendingMessages() { return true; } };

  await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 0 }, ctx);
  await handlers.get("turn_end")!({ type: "turn_end", turnIndex: 0, message: assistant({ text: "Progress" }), toolResults: [] }, ctx);

  assert.deepEqual(sent, [FINAL_HANDOFF_DIRECTIVE]);
  assert.equal(lifecycle.admitTool("read").allowed, true);
});

test("one-turn budget keeps the first turn usable and wraps up in grace", async () => {
  const plan = findAgent(discoverAgents({ cwd: packageRoot, packageRoot, includeProject: false }).agents, "Plan")!;
  const lifecycle = createChildLifecycleController({ maxTurns: 1, graceTurns: 1, maxToolCalls: 10 });
  const handlers = new Map<string, Function>();
  const sent: Array<{ content: unknown; options: unknown }> = [];
  const fakePi = {
    on(event: string, handler: Function) { handlers.set(event, handler); },
    sendUserMessage(content: unknown, options: unknown) { sent.push({ content, options }); },
    getActiveTools() { return ["read"]; },
    setActiveTools() {},
  };
  (createChildLifecycleExtension(plan, lifecycle, { maxTurns: 1 }) as ExtensionFactory)(fakePi as never);
  const ctx = { abort() {}, hasPendingMessages() { return false; } };

  await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 0 }, ctx);
  assert.equal(lifecycle.snapshot.phase, "working");
  assert.deepEqual(await handlers.get("tool_call")!({ toolName: "read", input: { path: "README.md" } }, ctx), undefined);
  await handlers.get("turn_end")!({ type: "turn_end", turnIndex: 0, message: assistant({ toolCalls: 1 }), toolResults: [] }, ctx);
  assert.deepEqual(sent, [{ content: FINAL_HANDOFF_DIRECTIVE, options: { deliverAs: "steer" } }]);

  await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 1 }, ctx);
  assert.equal(lifecycle.snapshot.phase, "final_handoff");
  assert.deepEqual(await handlers.get("tool_call")!({ toolName: "read", input: { path: "README.md" } }, ctx), undefined);
});
