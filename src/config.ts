import * as fs from "node:fs";
import * as path from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export interface AgentModelOverride {
  model?: string;
  thinking?: string;
}

export interface AgentModelSettings {
  defaultModel?: string;
  agentOverrides: Record<string, AgentModelOverride>;
  sourcePath: string;
}

export interface PiSubagentsConfig {
  maxConcurrentTasks: number;
  defaultTimeoutMs?: number;
  defaultMaxTurns?: number;
  defaultGraceTurns: number;
  defaultMaxToolCalls?: number;
  defaultSoftToolCalls?: number;
  defaultToolBudgetBlock: string[] | "*";
  /** First progress-warning checkpoint (absolute turns). Always a positive integer. */
  warningTurns: number;
  /** Interval between subsequent progress-warning checkpoints. Always a positive integer. */
  warningIntervalTurns: number;
  maxOutputBytes: number;
  maxOutputLines: number;
  /** @deprecated Prefer maxOutputBytes. Accepted as a fallback when loading config. */
  maxOutputChars?: number;
  maxTasksPerLaunch: number;
  maxAgentDepth: number;
  enableBackground: boolean;
  enableFork: boolean;
  enableWorktrees: boolean;
  enableNestedAgents: boolean;
  proactivePrompt: boolean;
  verificationPrompt: boolean;
  verificationFileThreshold: number;
  cleanupPeriodDays?: number;
}

export const DEFAULT_WARNING_TURNS = 30;
export const DEFAULT_WARNING_INTERVAL_TURNS = 20;

export const DEFAULT_CONFIG: PiSubagentsConfig = {
  maxConcurrentTasks: 20,
  defaultTimeoutMs: undefined,
  defaultMaxTurns: undefined,
  defaultGraceTurns: 1,
  defaultMaxToolCalls: undefined,
  defaultSoftToolCalls: undefined,
  defaultToolBudgetBlock: ["read", "grep", "find", "ls"],
  warningTurns: DEFAULT_WARNING_TURNS,
  warningIntervalTurns: DEFAULT_WARNING_INTERVAL_TURNS,
  maxOutputBytes: 200 * 1024,
  maxOutputLines: 5_000,
  maxTasksPerLaunch: 8,
  maxAgentDepth: 5,
  enableBackground: true,
  enableFork: true,
  enableWorktrees: true,
  enableNestedAgents: true,
  proactivePrompt: true,
  verificationPrompt: true,
  verificationFileThreshold: 3,
  cleanupPeriodDays: undefined,
};

function readJson(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${filePath} must contain a JSON object`);
  }
  return value as Record<string, unknown>;
}

function parseAgentModelSettings(raw: Record<string, unknown>, sourcePath: string, diagnostics: string[]): AgentModelSettings {
  const settings: AgentModelSettings = { agentOverrides: {}, sourcePath };
  const subagents = raw.subagents;
  if (subagents === undefined) return settings;
  if (!subagents || typeof subagents !== "object" || Array.isArray(subagents)) {
    diagnostics.push(`${sourcePath}: subagents must be an object`);
    return settings;
  }
  const value = subagents as Record<string, unknown>;
  if (value.defaultModel !== undefined) {
    if (typeof value.defaultModel === "string" && value.defaultModel.trim()) settings.defaultModel = value.defaultModel.trim();
    else diagnostics.push(`${sourcePath}: subagents.defaultModel must be a non-empty string`);
  }
  const overrides = value.agentOverrides;
  if (overrides === undefined) return settings;
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    diagnostics.push(`${sourcePath}: subagents.agentOverrides must be an object`);
    return settings;
  }
  for (const [name, entry] of Object.entries(overrides)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      diagnostics.push(`${sourcePath}: subagents.agentOverrides.${name} must be an object`);
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    const override: AgentModelOverride = {};
    if (candidate.model !== undefined) {
      if (typeof candidate.model === "string" && candidate.model.trim()) override.model = candidate.model.trim();
      else diagnostics.push(`${sourcePath}: subagents.agentOverrides.${name}.model must be a non-empty string`);
    }
    if (candidate.thinking !== undefined) {
      if (typeof candidate.thinking === "string" && candidate.thinking.trim()) override.thinking = candidate.thinking.trim();
      else diagnostics.push(`${sourcePath}: subagents.agentOverrides.${name}.thinking must be a non-empty string`);
    }
    if (override.model || override.thinking) settings.agentOverrides[name] = override;
  }
  return settings;
}

export function loadAgentModelSettings(cwd: string, includeProject: boolean, agentDir = getAgentDir()): { settings: AgentModelSettings; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const globalPath = path.join(agentDir, "settings.json");
  let globalRaw: Record<string, unknown> = {};
  try {
    globalRaw = readJson(globalPath);
  } catch (error) {
    diagnostics.push(error instanceof Error ? error.message : String(error));
  }
  const global = parseAgentModelSettings(globalRaw, globalPath, diagnostics);
  if (!includeProject) return { settings: global, diagnostics };

  const projectPath = path.join(cwd, CONFIG_DIR_NAME, "settings.json");
  let projectRaw: Record<string, unknown> = {};
  try {
    projectRaw = readJson(projectPath);
  } catch (error) {
    diagnostics.push(error instanceof Error ? error.message : String(error));
  }
  const project = parseAgentModelSettings(projectRaw, projectPath, diagnostics);
  return {
    settings: {
      defaultModel: project.defaultModel ?? global.defaultModel,
      agentOverrides: { ...global.agentOverrides, ...project.agentOverrides },
      sourcePath: project.defaultModel || Object.keys(project.agentOverrides).length ? projectPath : globalPath,
    },
    diagnostics,
  };
}

function numberValue(value: unknown, fallback: number, min: number, max?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) return fallback;
  const normalized = Math.floor(value);
  return max === undefined ? normalized : Math.min(normalized, max);
}

/** Mandatory positive integer; null/0/invalid fall back rather than disabling the feature. */
function positiveNumberValue(value: unknown, fallback: number): number {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

function optionalNumberValue(value: unknown, fallback: number | undefined, min: number, max?: number): number | undefined {
  // Explicit JSON null unsets an inherited optional default.
  if (value === null) return undefined;
  if (value === undefined || value === "") return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) return fallback;
  const normalized = Math.floor(value);
  return max === undefined ? normalized : Math.min(normalized, max);
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parseToolBudgetBlock(value: unknown, fallback: string[] | "*"): string[] | "*" {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === "*") return "*";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "*") return "*";
    const items = trimmed.split(",").map(item => item.trim()).filter(Boolean);
    return items.length > 0 ? items : fallback;
  }
  if (Array.isArray(value)) {
    const items = value.map(String).map(item => item.trim()).filter(Boolean);
    return items.length > 0 ? items : fallback;
  }
  return fallback;
}

/** Apply raw JSON overrides onto a base config. Exported for unit tests of inheritance/null-unset. */
export function applyConfig(base: PiSubagentsConfig, raw: Record<string, unknown>): PiSubagentsConfig {
  const maxOutputBytesFallback = raw.maxOutputBytes === undefined && typeof raw.maxOutputChars === "number"
    ? numberValue(raw.maxOutputChars, base.maxOutputBytes, 1000)
    : numberValue(raw.maxOutputBytes, base.maxOutputBytes, 1000);

  return {
    maxConcurrentTasks: numberValue(raw.maxConcurrentTasks, base.maxConcurrentTasks, 1),
    defaultTimeoutMs: optionalNumberValue(raw.defaultTimeoutMs, base.defaultTimeoutMs, 1000),
    defaultMaxTurns: optionalNumberValue(raw.defaultMaxTurns, base.defaultMaxTurns, 1),
    defaultGraceTurns: numberValue(raw.defaultGraceTurns, base.defaultGraceTurns, 0),
    defaultMaxToolCalls: optionalNumberValue(raw.defaultMaxToolCalls, base.defaultMaxToolCalls, 1),
    defaultSoftToolCalls: optionalNumberValue(raw.defaultSoftToolCalls, base.defaultSoftToolCalls, 1),
    defaultToolBudgetBlock: parseToolBudgetBlock(raw.defaultToolBudgetBlock, base.defaultToolBudgetBlock),
    warningTurns: positiveNumberValue(raw.warningTurns, base.warningTurns),
    warningIntervalTurns: positiveNumberValue(raw.warningIntervalTurns, base.warningIntervalTurns),
    maxOutputBytes: maxOutputBytesFallback,
    maxOutputLines: numberValue(raw.maxOutputLines, base.maxOutputLines, 1),
    maxTasksPerLaunch: numberValue(raw.maxTasksPerLaunch, base.maxTasksPerLaunch, 1),
    maxAgentDepth: numberValue(raw.maxAgentDepth, base.maxAgentDepth, 1, 5),
    enableBackground: booleanValue(raw.enableBackground, base.enableBackground),
    enableFork: booleanValue(raw.enableFork, base.enableFork),
    enableWorktrees: booleanValue(raw.enableWorktrees, base.enableWorktrees),
    enableNestedAgents: booleanValue(raw.enableNestedAgents, base.enableNestedAgents),
    proactivePrompt: booleanValue(raw.proactivePrompt, base.proactivePrompt),
    verificationPrompt: booleanValue(raw.verificationPrompt, base.verificationPrompt),
    verificationFileThreshold: numberValue(raw.verificationFileThreshold, base.verificationFileThreshold, 1),
    cleanupPeriodDays: optionalNumberValue(raw.cleanupPeriodDays, base.cleanupPeriodDays, 1),
  };
}

export function loadConfig(cwd: string, includeProject: boolean): { config: PiSubagentsConfig; diagnostics: string[] } {
  const diagnostics: string[] = [];
  let config = DEFAULT_CONFIG;
  const globalPath = path.join(getAgentDir(), "pi-claude-subagents.json");
  try {
    config = applyConfig(config, readJson(globalPath));
  } catch (error) {
    diagnostics.push(error instanceof Error ? error.message : String(error));
  }
  if (includeProject) {
    const projectPath = path.join(cwd, CONFIG_DIR_NAME, "pi-claude-subagents.json");
    try {
      config = applyConfig(config, readJson(projectPath));
    } catch (error) {
      diagnostics.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { config, diagnostics };
}
