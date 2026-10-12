import * as fs from "node:fs";

import type { TaskRecord } from "./tasks.ts";

/**
 * Interruption recovery: tasks stopped by `parent_shutdown` (the parent Pi
 * process quit, reloaded, or switched sessions while they were running) are
 * resumable, because their child sessions are persisted on disk. On the next
 * `session_start` for the same parent session we surface them so the parent
 * agent can continue them with `SendMessage` instead of losing the work.
 */

export interface InterruptedTaskCandidate {
  record: TaskRecord;
  /** True when the persisted child session file still exists on disk. */
  hasSessionFile: boolean;
}

export type AutoResumeOutcome =
  | { ok: true; record: TaskRecord }
  | { ok: false; record: TaskRecord; error: string };

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function shouldOfferInterruptedRecovery(options: {
  sessionId: string;
  notifiedSessionIds: ReadonlySet<string>;
  mode: "notify" | "auto" | "off" | undefined;
  resumableCount: number;
}): boolean {
  if ((options.mode ?? "notify") === "off") return false;
  if (options.resumableCount <= 0) return false;
  return !options.notifiedSessionIds.has(options.sessionId);
}

export function isInterruptedByParent(record: TaskRecord): boolean {
  return (
    record.status === "stopped" &&
    record.terminationKind === "parent_shutdown"
  );
}

export function isResumableInterruptedTask(
  record: TaskRecord,
  exists: (file: string) => boolean = (file) => fs.existsSync(file),
): boolean {
  return (
    isInterruptedByParent(record) &&
    !record.oneShot &&
    !record.worktreeCleaned &&
    Boolean(record.sessionFile && exists(record.sessionFile))
  );
}

export function selectInterruptedTasks(
  records: TaskRecord[],
  exists: (file: string) => boolean = (file) => fs.existsSync(file),
): InterruptedTaskCandidate[] {
  return records
    .filter((record) => isInterruptedByParent(record))
    .map((record) => ({ record, hasSessionFile: Boolean(record.sessionFile && exists(record.sessionFile)) }))
    .sort((a, b) => a.record.startedAt.localeCompare(b.record.startedAt));
}

export function formatInterruptedTasksNotice(
  candidates: InterruptedTaskCandidate[],
  options: { autoResumed?: boolean; failures?: AutoResumeOutcome[] } = {},
): string | null {
  const resumable = candidates.filter(
    (candidate) =>
      !candidate.record.oneShot &&
      !candidate.record.worktreeCleaned &&
      candidate.hasSessionFile,
  );
  if (resumable.length === 0) return null;
  const failures = (options.failures ?? []).filter((outcome): outcome is Extract<AutoResumeOutcome, { ok: false }> => !outcome.ok);
  const lines = resumable.map((candidate) => {
    const record = candidate.record;
    const turns = record.usage?.turns ?? 0;
    return `- ${escapeXml(record.description)} (${escapeXml(record.agent)}, ${turns} turns so far, task_id: ${escapeXml(record.id)})`;
  });
  const allAutoResumed = options.autoResumed === true && failures.length === 0;
  const guidance = allAutoResumed
    ? "These tasks have been resumed automatically in the background; their results will arrive as notifications."
    : failures.length > 0
      ? "Some auto-resumes failed; continue them with SendMessage (their persisted sessions are intact)."
      : "These tasks can be continued with SendMessage (their persisted sessions are intact); start fresh only if the prior approach should not be inherited.";
  const failureLines = failures.map((failure) => `- ${escapeXml(failure.record.description)}: ${escapeXml(failure.error)}`);
  return [
    "<interrupted-tasks>",
    "Background tasks were interrupted by the previous parent shutdown. Recoverable:",
    ...lines,
    guidance,
    ...(failureLines.length > 0 ? ["Failed auto-resumes:", ...failureLines] : []),
    "</interrupted-tasks>",
  ].join("\n");
}
