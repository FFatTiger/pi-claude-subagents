import test from "node:test";
import assert from "node:assert/strict";
import {
  createChildLifecycleController,
  statusForTermination,
  type TerminationKind,
} from "../src/lifecycle.ts";

test("unconfigured lifecycle has no turn or tool budget", () => {
  const lifecycle = createChildLifecycleController({});

  for (let i = 0; i < 100; i++) {
    lifecycle.onTurnStart();
    assert.equal(lifecycle.admitTool("read").allowed, true);
    assert.deepEqual(lifecycle.onTurnEnd({ messageHasText: false, wouldContinue: true }), {
      queueFinalHandoff: false,
      stopAfterTurn: false,
    });
  }

  assert.equal(lifecycle.snapshot.usage.turns, 100);
  assert.equal(lifecycle.snapshot.usage.toolCallsExecuted, 100);
  assert.equal(lifecycle.snapshot.toolBudgetExhausted, false);
});

test("turn budget requests wrap-up at the soft threshold and allows one grace turn", () => {
  const lifecycle = createChildLifecycleController({ maxTurns: 2, graceTurns: 1 });

  lifecycle.onTurnStart();
  assert.deepEqual(lifecycle.onTurnEnd({ messageHasText: false, wouldContinue: true }), {
    queueFinalHandoff: false,
    stopAfterTurn: false,
  });

  lifecycle.onTurnStart();
  assert.deepEqual(lifecycle.onTurnEnd({ messageHasText: false, wouldContinue: true }), {
    queueFinalHandoff: true,
    stopAfterTurn: false,
  });

  lifecycle.onTurnStart();
  assert.equal(lifecycle.snapshot.phase, "final_handoff");
  assert.equal(lifecycle.admitTool("read").allowed, true);
  assert.deepEqual(lifecycle.onTurnEnd({ messageHasText: true, wouldContinue: false }), {
    queueFinalHandoff: false,
    stopAfterTurn: false,
  });

  const terminal = lifecycle.finishProvider({ stopReason: "stop", hasInvocationText: true });
  assert.equal(terminal.usage.turns, 3);
  assert.equal(terminal.terminationKind, "normal");
  assert.equal(terminal.status, "completed");
});

test("continuing beyond turn budget plus grace becomes partial turn_budget", () => {
  const lifecycle = createChildLifecycleController({ maxTurns: 2, graceTurns: 1 });

  for (let turn = 1; turn <= 3; turn++) {
    lifecycle.onTurnStart();
    const completion = lifecycle.onTurnEnd({ messageHasText: false, wouldContinue: true });
    if (turn === 2) assert.equal(completion.queueFinalHandoff, true);
    if (turn === 3) assert.equal(completion.stopAfterTurn, true);
  }

  const terminal = lifecycle.finishProvider({
    stopReason: "aborted",
    errorMessage: "Request was aborted",
    hasInvocationText: false,
  });
  assert.equal(terminal.usage.turns, 3);
  assert.equal(terminal.terminationKind, "turn_budget");
  assert.equal(terminal.status, "partial");
});

test("one-turn budget keeps the first turn usable and wraps up in grace", () => {
  const lifecycle = createChildLifecycleController({ maxTurns: 1, graceTurns: 1 });

  lifecycle.onTurnStart();
  assert.equal(lifecycle.snapshot.phase, "working");
  assert.equal(lifecycle.admitTool("read").allowed, true);
  assert.deepEqual(lifecycle.onTurnEnd({ messageHasText: false, wouldContinue: true }), {
    queueFinalHandoff: true,
    stopAfterTurn: false,
  });

  lifecycle.onTurnStart();
  assert.equal(lifecycle.snapshot.phase, "final_handoff");
  assert.equal(lifecycle.admitTool("grep").allowed, true);
});

test("tool budget nudges at soft threshold and blocks only configured tools after hard threshold", () => {
  const lifecycle = createChildLifecycleController({
    maxToolCalls: 2,
    softToolCalls: 1,
    toolBudgetBlock: ["read", "grep", "find", "ls"],
  });

  assert.deepEqual(lifecycle.admitTool("read"), { allowed: true, queueWrapUp: true });
  assert.deepEqual(lifecycle.admitTool("edit"), { allowed: true });
  assert.deepEqual(lifecycle.admitTool("edit"), { allowed: true });
  assert.deepEqual(lifecycle.admitTool("read"), {
    allowed: false,
    blockKind: "tool_budget",
    reason: "Tool budget hard limit reached (2); read is paused so the agent can finish from its current context.",
  });

  assert.deepEqual(lifecycle.snapshot.usage, {
    turns: 0,
    toolCallsRequested: 4,
    toolCallsExecuted: 3,
    toolCallsBlocked: 1,
  });
  assert.equal(lifecycle.snapshot.toolBudgetExhausted, true);
});

test("wildcard tool budget blocks every tool after the hard threshold", () => {
  const lifecycle = createChildLifecycleController({ maxToolCalls: 1, toolBudgetBlock: "*" });
  assert.equal(lifecycle.admitTool("read").allowed, true);
  assert.equal(lifecycle.admitTool("edit").allowed, false);
});

test("valid report after tool-budget blocking completes normally", () => {
  const lifecycle = createChildLifecycleController({ maxToolCalls: 1, toolBudgetBlock: ["read"] });
  lifecycle.onTurnStart();
  lifecycle.admitTool("read");
  lifecycle.admitTool("read");
  lifecycle.onTurnEnd({ messageHasText: true, wouldContinue: false });

  const terminal = lifecycle.finishProvider({ stopReason: "stop", hasInvocationText: true });
  assert.equal(terminal.terminationKind, "normal");
  assert.equal(terminal.status, "completed");
});

test("missing report after tool-budget blocking is partial tool_budget", () => {
  const lifecycle = createChildLifecycleController({ maxToolCalls: 1, toolBudgetBlock: ["read"] });
  lifecycle.onTurnStart();
  lifecycle.admitTool("read");
  lifecycle.admitTool("read");
  lifecycle.onTurnEnd({ messageHasText: false, wouldContinue: false });

  const terminal = lifecycle.finishProvider({ stopReason: "stop", hasInvocationText: false });
  assert.equal(terminal.terminationKind, "tool_budget");
  assert.equal(terminal.status, "partial");
});

test("policy blocks do not masquerade as tool budget exhaustion", () => {
  const lifecycle = createChildLifecycleController({ maxToolCalls: 2 });
  const readonly = lifecycle.admitTool("edit", { kind: "readonly", reason: "Plan is read-only." });
  const shell = lifecycle.admitTool("bash", { kind: "shell_policy", reason: "Command is not inspect-only." });

  assert.deepEqual(readonly, { allowed: false, blockKind: "readonly", reason: "Plan is read-only." });
  assert.deepEqual(shell, { allowed: false, blockKind: "shell_policy", reason: "Command is not inspect-only." });
  assert.equal(lifecycle.snapshot.toolBudgetExhausted, false);
});

test("explicit stop causes win over an aborted provider message", () => {
  for (const [kind, expected] of [
    ["timeout", "partial"],
    ["manual_stop", "stopped"],
    ["parent_shutdown", "stopped"],
  ] as const) {
    const lifecycle = createChildLifecycleController({});
    lifecycle.requestStop(kind);
    const terminal = lifecycle.finishProvider({
      stopReason: "aborted",
      errorMessage: "Request was aborted",
      hasInvocationText: false,
    });
    assert.equal(terminal.terminationKind, kind);
    assert.equal(terminal.status, expected);
  }
});

test("provider failures remain failed when no controlled stop occurred", () => {
  const lifecycle = createChildLifecycleController({});
  lifecycle.onTurnStart();
  lifecycle.onTurnEnd({ messageHasText: false, wouldContinue: false });
  const terminal = lifecycle.finishProvider({
    stopReason: "aborted",
    errorMessage: "Request was aborted",
    hasInvocationText: false,
  });
  assert.equal(terminal.terminationKind, "provider_error");
  assert.equal(terminal.status, "failed");
});

test("termination kinds map to stable public statuses", () => {
  const expected: Record<TerminationKind, string> = {
    normal: "completed",
    turn_budget: "partial",
    tool_budget: "partial",
    timeout: "partial",
    manual_stop: "stopped",
    parent_shutdown: "stopped",
    provider_error: "failed",
    startup_error: "failed",
  };
  for (const [kind, status] of Object.entries(expected) as Array<[TerminationKind, string]>) {
    assert.equal(statusForTermination(kind), status);
  }
});

test("startup failure terminates before any turn", () => {
  const lifecycle = createChildLifecycleController({});
  const terminal = lifecycle.failStartup("No API key");
  assert.equal(terminal.terminationKind, "startup_error");
  assert.equal(terminal.status, "failed");
  assert.equal(terminal.usage.turns, 0);
});

test("rejects inconsistent optional budgets", () => {
  assert.throws(() => createChildLifecycleController({ maxTurns: 0 }), /maxTurns/);
  assert.throws(() => createChildLifecycleController({ graceTurns: -1 }), /graceTurns/);
  assert.throws(() => createChildLifecycleController({ softToolCalls: 3 }), /maxToolCalls/);
  assert.throws(() => createChildLifecycleController({ maxToolCalls: 2, softToolCalls: 3 }), /softToolCalls/);
});
