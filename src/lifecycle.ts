export type LifecyclePhase = "starting" | "working" | "final_handoff" | "terminal";

export type TerminationKind =
  | "normal"
  | "turn_budget"
  | "tool_budget"
  | "provider_error"
  | "timeout"
  | "manual_stop"
  | "parent_shutdown"
  | "startup_error";

export type TerminalTaskStatus = "completed" | "partial" | "failed" | "stopped";

export type ToolBlockKind = "tool_budget" | "final_handoff" | "readonly" | "shell_policy";

export interface LifecycleUsage {
  turns: number;
  toolCallsRequested: number;
  toolCallsExecuted: number;
  toolCallsBlocked: number;
}

export interface ToolAdmission {
  allowed: boolean;
  blockKind?: ToolBlockKind;
  reason?: string;
  queueWrapUp?: boolean;
}

export interface ProgressWarning {
  turn: number;
  nextWarningTurn: number;
  warningCount: number;
  warningTurns: number;
  warningIntervalTurns: number;
}

export interface TurnCompletion {
  queueFinalHandoff: boolean;
  stopAfterTurn: boolean;
  progressWarning?: ProgressWarning;
}

export interface LifecycleSnapshot {
  phase: LifecyclePhase;
  usage: LifecycleUsage;
  terminationKind?: TerminationKind;
  status?: TerminalTaskStatus;
  finalHandoffQueued: boolean;
  finalHandoffTurnStarted: boolean;
  toolBudgetExhausted: boolean;
  turnBudgetExhausted: boolean;
  nextWarningTurn: number;
  warningCount: number;
  warningTurns: number;
  warningIntervalTurns: number;
}

export type ToolPolicyBlock = { kind: "readonly" | "shell_policy"; reason: string };

export interface ChildLifecycleController {
  readonly snapshot: LifecycleSnapshot;
  onTurnStart(): void;
  admitTool(toolNameOrPolicy?: string | ToolPolicyBlock, policyBlock?: ToolPolicyBlock): ToolAdmission;
  onTurnEnd(options: { messageHasText: boolean; wouldContinue: boolean }): TurnCompletion;
  requestStop(kind: "timeout" | "manual_stop" | "parent_shutdown"): void;
  finishProvider(options: { stopReason?: string; errorMessage?: string; hasInvocationText: boolean }): LifecycleSnapshot;
  failStartup(errorMessage: string): LifecycleSnapshot;
}

export function statusForTermination(kind: TerminationKind): TerminalTaskStatus {
  switch (kind) {
    case "normal":
      return "completed";
    case "turn_budget":
    case "tool_budget":
    case "timeout":
      return "partial";
    case "manual_stop":
    case "parent_shutdown":
      return "stopped";
    case "provider_error":
    case "startup_error":
      return "failed";
  }
}

function isProviderFailure(stopReason: string | undefined, errorMessage: string | undefined): boolean {
  return stopReason === "error" || stopReason === "aborted" || Boolean(errorMessage?.trim());
}

function isInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value);
}

/** Resolve mandatory positive warning schedule values. Invalid/null/0 fall back safely. */
export function resolveWarningSchedule(options: {
  warningTurns?: number | null;
  warningIntervalTurns?: number | null;
  fallbackTurns?: number;
  fallbackInterval?: number;
}): { warningTurns: number; warningIntervalTurns: number } {
  const fallbackTurns = options.fallbackTurns !== undefined && Number.isInteger(options.fallbackTurns) && options.fallbackTurns >= 1
    ? options.fallbackTurns
    : 30;
  const fallbackInterval = options.fallbackInterval !== undefined && Number.isInteger(options.fallbackInterval) && options.fallbackInterval >= 1
    ? options.fallbackInterval
    : 20;
  const warningTurns = options.warningTurns !== undefined && options.warningTurns !== null
    && Number.isInteger(options.warningTurns) && options.warningTurns >= 1
    ? options.warningTurns
    : fallbackTurns;
  const warningIntervalTurns = options.warningIntervalTurns !== undefined && options.warningIntervalTurns !== null
    && Number.isInteger(options.warningIntervalTurns) && options.warningIntervalTurns >= 1
    ? options.warningIntervalTurns
    : fallbackInterval;
  return { warningTurns, warningIntervalTurns };
}

/** Advance nextWarningTurn strictly past absoluteTurns so the same checkpoint cannot fire twice. */
export function advanceWarningCheckpoint(
  absoluteTurns: number,
  nextWarningTurn: number,
  warningIntervalTurns: number,
): number {
  let next = nextWarningTurn;
  const interval = Math.max(1, warningIntervalTurns);
  while (next <= absoluteTurns) next += interval;
  return next;
}

export function createChildLifecycleController(options: {
  maxTurns?: number;
  graceTurns?: number;
  maxToolCalls?: number;
  softToolCalls?: number;
  toolBudgetBlock?: string[] | "*";
  /** Absolute turn number of the first warning checkpoint (defaults to warningTurns). */
  warningTurns?: number;
  warningIntervalTurns?: number;
  /** Cumulative turns already completed before this invocation (resume baseline). */
  initialTurns?: number;
  /** Persisted next checkpoint; defaults to warningTurns when unset/invalid. */
  nextWarningTurn?: number;
  warningCount?: number;
} = {}): ChildLifecycleController {
  if (options.maxTurns !== undefined && (!Number.isInteger(options.maxTurns) || options.maxTurns < 1)) {
    throw new Error("maxTurns must be an integer >= 1");
  }
  if (options.graceTurns !== undefined && (!Number.isInteger(options.graceTurns) || options.graceTurns < 0)) {
    throw new Error("graceTurns must be an integer >= 0");
  }
  if (options.maxToolCalls !== undefined && (!Number.isInteger(options.maxToolCalls) || options.maxToolCalls < 1)) {
    throw new Error("maxToolCalls must be an integer >= 1");
  }
  if (options.softToolCalls !== undefined) {
    if (!isInteger(options.maxToolCalls)) {
      throw new Error("softToolCalls requires maxToolCalls");
    }
    if (!Number.isInteger(options.softToolCalls) || options.softToolCalls < 1) {
      throw new Error("softToolCalls must be an integer >= 1");
    }
    if (options.softToolCalls > options.maxToolCalls) {
      throw new Error("softToolCalls must be <= maxToolCalls");
    }
  }

  const maxTurns = options.maxTurns;
  const graceTurns = maxTurns === undefined ? undefined : (options.graceTurns ?? 1);
  const maxToolCalls = options.maxToolCalls;
  const softToolCalls = options.softToolCalls;
  const toolBudgetBlock = options.toolBudgetBlock ?? ["read", "grep", "find", "ls"];
  const hardTurnLimit = maxTurns === undefined || graceTurns === undefined ? undefined : maxTurns + graceTurns;
  const schedule = resolveWarningSchedule({
    warningTurns: options.warningTurns,
    warningIntervalTurns: options.warningIntervalTurns,
  });
  const warningTurns = schedule.warningTurns;
  const warningIntervalTurns = schedule.warningIntervalTurns;
  const initialTurns = options.initialTurns !== undefined && Number.isInteger(options.initialTurns) && options.initialTurns >= 0
    ? options.initialTurns
    : 0;
  let nextWarningTurn = options.nextWarningTurn !== undefined
    && Number.isInteger(options.nextWarningTurn)
    && options.nextWarningTurn >= 1
    ? options.nextWarningTurn
    : warningTurns;
  // If resume starts past a stale checkpoint, skip it without firing.
  if (initialTurns >= nextWarningTurn) {
    nextWarningTurn = advanceWarningCheckpoint(initialTurns, nextWarningTurn, warningIntervalTurns);
  }
  let warningCount = options.warningCount !== undefined
    && Number.isInteger(options.warningCount)
    && options.warningCount >= 0
    ? options.warningCount
    : 0;

  let phase: LifecyclePhase = "starting";
  const usage: LifecycleUsage = {
    turns: 0,
    toolCallsRequested: 0,
    toolCallsExecuted: 0,
    toolCallsBlocked: 0,
  };
  let terminationKind: TerminationKind | undefined;
  let status: TerminalTaskStatus | undefined;
  let finalHandoffQueued = false;
  let finalHandoffTurnStarted = false;
  let toolBudgetExhausted = false;
  let turnBudgetExhausted = false;
  let toolWrapUpQueued = false;
  let explicitStop: "timeout" | "manual_stop" | "parent_shutdown" | undefined;
  let turnActive = false;

  const getSnapshot = (): LifecycleSnapshot => ({
    phase,
    usage: { ...usage },
    terminationKind,
    status,
    finalHandoffQueued,
    finalHandoffTurnStarted,
    toolBudgetExhausted,
    turnBudgetExhausted,
    nextWarningTurn,
    warningCount,
    warningTurns,
    warningIntervalTurns,
  });

  const finalize = (kind: TerminationKind): LifecycleSnapshot => {
    if (phase !== "terminal") {
      terminationKind = kind;
      status = statusForTermination(kind);
      phase = "terminal";
      turnActive = false;
    }
    return getSnapshot();
  };

  const toolIsBlockedByBudget = (toolName: string | undefined): boolean => {
    if (maxToolCalls === undefined || usage.toolCallsExecuted < maxToolCalls) return false;
    toolBudgetExhausted = true;
    if (toolBudgetBlock === "*") return true;
    if (!toolName) return false;
    return toolBudgetBlock.includes(toolName);
  };

  const parseAdmitArgs = (
    toolNameOrPolicy?: string | ToolPolicyBlock,
    policyBlock?: ToolPolicyBlock,
  ): { toolName?: string; policy?: ToolPolicyBlock } => {
    if (typeof toolNameOrPolicy === "string" || toolNameOrPolicy === undefined) {
      return { toolName: toolNameOrPolicy, policy: policyBlock };
    }
    return { policy: toolNameOrPolicy };
  };

  return {
    get snapshot() {
      return getSnapshot();
    },

    onTurnStart() {
      if (phase === "terminal") throw new Error("Cannot start a turn on a terminal lifecycle.");
      if (turnActive) throw new Error("Cannot start a new turn before the current turn ends.");
      if (hardTurnLimit !== undefined && usage.turns >= hardTurnLimit) {
        throw new Error(`Turn budget exceeded (${hardTurnLimit}).`);
      }
      usage.turns++;
      turnActive = true;
      if (finalHandoffQueued || (maxTurns !== undefined && usage.turns > maxTurns)) {
        phase = "final_handoff";
        finalHandoffTurnStarted = true;
      } else {
        phase = "working";
      }
    },

    admitTool(toolNameOrPolicy, policyBlock) {
      if (phase === "terminal") throw new Error("Cannot admit a tool on a terminal lifecycle.");
      const { toolName, policy } = parseAdmitArgs(toolNameOrPolicy, policyBlock);
      usage.toolCallsRequested++;

      if (policy) {
        usage.toolCallsBlocked++;
        return { allowed: false, blockKind: policy.kind, reason: policy.reason };
      }

      if (toolIsBlockedByBudget(toolName)) {
        usage.toolCallsBlocked++;
        return {
          allowed: false,
          blockKind: "tool_budget",
          reason: maxToolCalls === undefined
            ? "Tool budget hard limit reached."
            : `Tool budget hard limit reached (${maxToolCalls}); ${toolName ?? "tool"} is paused so the agent can finish from its current context.`,
        };
      }

      usage.toolCallsExecuted++;
      let queueWrapUp = false;
      if (
        softToolCalls !== undefined
        && !toolWrapUpQueued
        && usage.toolCallsExecuted >= softToolCalls
      ) {
        toolWrapUpQueued = true;
        queueWrapUp = true;
      }
      return queueWrapUp ? { allowed: true, queueWrapUp: true } : { allowed: true };
    },

    onTurnEnd({ wouldContinue }) {
      if (phase === "terminal") throw new Error("Cannot end a turn on a terminal lifecycle.");
      if (!turnActive) throw new Error("Cannot end a turn before it starts.");
      turnActive = false;

      let progressWarning: ProgressWarning | undefined;
      const absoluteTurns = initialTurns + usage.turns;
      // Warn only when the child would continue past a due checkpoint. Finishing exactly at a
      // checkpoint (wouldContinue=false) is ordinary completion and must not warn.
      if (wouldContinue && absoluteTurns >= nextWarningTurn) {
        warningCount++;
        nextWarningTurn = advanceWarningCheckpoint(absoluteTurns, nextWarningTurn, warningIntervalTurns);
        progressWarning = {
          turn: absoluteTurns,
          nextWarningTurn,
          warningCount,
          warningTurns,
          warningIntervalTurns,
        };
      }

      const completion = (queueFinalHandoff: boolean, stopAfterTurn: boolean): TurnCompletion => progressWarning
        ? { queueFinalHandoff, stopAfterTurn, progressWarning }
        : { queueFinalHandoff, stopAfterTurn };

      if (phase === "final_handoff") {
        if (wouldContinue && hardTurnLimit !== undefined && usage.turns >= hardTurnLimit) {
          turnBudgetExhausted = true;
          return completion(false, true);
        }
        return completion(false, false);
      }

      if (
        wouldContinue
        && maxTurns !== undefined
        && usage.turns >= maxTurns
        && !finalHandoffQueued
      ) {
        finalHandoffQueued = true;
        return completion(true, false);
      }

      return completion(false, false);
    },

    requestStop(kind) {
      if (phase === "terminal") return;
      explicitStop ??= kind;
    },

    finishProvider({ stopReason, errorMessage, hasInvocationText }) {
      if (phase === "terminal") return getSnapshot();
      if (explicitStop) return finalize(explicitStop);
      if (turnBudgetExhausted) return finalize("turn_budget");
      if (isProviderFailure(stopReason, errorMessage)) return finalize("provider_error");
      if (toolBudgetExhausted && !hasInvocationText) return finalize("tool_budget");
      return finalize("normal");
    },

    failStartup(_errorMessage) {
      return finalize(explicitStop ?? "startup_error");
    },
  };
}
