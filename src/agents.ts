import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentModelSettings } from "./config.ts";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentContextMode = "fresh" | "fork";
export type AgentIsolationMode = "worktree";
export type AgentShellPolicy = "inspect" | "verify" | "unrestricted";

export interface AgentDefinition {
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  thinking?: string;
  skills?: string[];
  readonly: boolean;
  shellPolicy: AgentShellPolicy;
  background?: boolean;
  context: AgentContextMode;
  maxTurns?: number;
  graceTurns?: number;
  maxToolCalls?: number;
  softToolCalls?: number;
  toolBudgetBlock?: string[] | "*";
  timeoutMs?: number;
  /** First progress-warning checkpoint override (absolute turns). */
  warningTurns?: number;
  /** Interval between subsequent progress-warning checkpoints. */
  warningIntervalTurns?: number;
  isolation?: AgentIsolationMode;
  oneShot?: boolean;
  source: "builtin" | "user" | "project";
  filePath: string;
}

export interface AgentDiscoveryResult {
  agents: AgentDefinition[];
  searched: string[];
  diagnostics: string[];
}

interface SourceDir {
  dir: string;
  source: AgentDefinition["source"];
}

const BOOLEAN_TRUE = new Set([true, "true", "yes", "1"]);
const BOOLEAN_FALSE = new Set([false, "false", "no", "0"]);

function parseBool(value: unknown, fallback = false): boolean {
  if (value === undefined) return fallback;
  return BOOLEAN_TRUE.has(value as true | string);
}

function parseOptionalBool(value: unknown): boolean | undefined {
  if (BOOLEAN_TRUE.has(value as true | string)) return true;
  if (BOOLEAN_FALSE.has(value as false | string)) return false;
  return undefined;
}

function parseStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value.map(String).map(item => item.trim()).filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  if (typeof value !== "string") return undefined;
  const items = value.split(",").map(item => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function parsePositiveInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseNonNegativeInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseToolBudgetBlock(value: unknown): string[] | "*" | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "*") return "*";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "*") return "*";
    const items = trimmed.split(",").map(item => item.trim()).filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  if (Array.isArray(value)) {
    const items = value.map(String).map(item => item.trim()).filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  return undefined;
}

function findFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(candidate);
      else if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md")) files.push(candidate);
    }
  }
  return files.sort();
}

function parseAgentFile(filePath: string, source: AgentDefinition["source"]): AgentDefinition | string {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    return `${filePath}: ${error instanceof Error ? error.message : String(error)}`;
  }
  const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(raw);
  const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : path.basename(filePath, ".md");
  const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
  const prompt = body.trim();
  if (!name || !description || !prompt) {
    return `${filePath}: agent requires non-empty name, description, and prompt body`;
  }
  const context = frontmatter.context === "fork" ? "fork" : "fresh";
  const isolation = frontmatter.isolation === "worktree" ? "worktree" : undefined;
  const readonly = parseBool(frontmatter.readonly);
  const requestedShellPolicy = frontmatter.shellPolicy === "verify"
    ? "verify"
    : frontmatter.shellPolicy === "inspect"
      ? "inspect"
      : frontmatter.shellPolicy === "unrestricted"
        ? "unrestricted"
        : undefined;
  const shellPolicy: AgentShellPolicy = requestedShellPolicy ?? (readonly ? "inspect" : "unrestricted");
  return {
    name,
    description,
    prompt,
    tools: parseStringList(frontmatter.tools),
    disallowedTools: parseStringList(frontmatter.disallowedTools),
    model: typeof frontmatter.model === "string" && frontmatter.model.trim() ? frontmatter.model.trim() : undefined,
    thinking: typeof frontmatter.thinking === "string" && frontmatter.thinking.trim() ? frontmatter.thinking.trim() : undefined,
    skills: parseStringList(frontmatter.skills),
    readonly,
    shellPolicy,
    background: parseOptionalBool(frontmatter.background),
    context,
    maxTurns: parsePositiveInt(frontmatter.maxTurns),
    graceTurns: parseNonNegativeInt(frontmatter.graceTurns),
    maxToolCalls: parsePositiveInt(frontmatter.maxToolCalls),
    softToolCalls: parsePositiveInt(frontmatter.softToolCalls),
    toolBudgetBlock: parseToolBudgetBlock(frontmatter.toolBudgetBlock),
    timeoutMs: parsePositiveInt(frontmatter.timeoutMs),
    warningTurns: parsePositiveInt(frontmatter.warningTurns),
    warningIntervalTurns: parsePositiveInt(frontmatter.warningIntervalTurns),
    isolation,
    oneShot: parseBool(frontmatter.oneShot),
    source,
    filePath,
  };
}

function projectSearchRoots(cwd: string): string[] {
  const resolved = path.resolve(cwd);
  const chain: string[] = [];
  let current = resolved;
  let gitRoot: string | undefined;
  while (true) {
    chain.push(current);
    if (fs.existsSync(path.join(current, ".git"))) {
      gitRoot = current;
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (!gitRoot) return [resolved];
  return chain.slice(0, chain.indexOf(gitRoot) + 1).reverse();
}

export function resolvePackageRoot(fromUrl = import.meta.url): string {
  const startDir = path.dirname(fileURLToPath(fromUrl));
  let current = startDir;
  while (true) {
    const packageJsonPath = path.join(current, "package.json");
    const agentsDir = path.join(current, "agents");
    if (fs.existsSync(packageJsonPath) && fs.existsSync(agentsDir)) {
      try {
        const raw = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { name?: string };
        if (raw.name === "pi-claude-subagents" || fs.readdirSync(agentsDir).some(name => name.endsWith(".md"))) {
          return current;
        }
      } catch {
        if (fs.readdirSync(agentsDir).some(name => name.endsWith(".md"))) return current;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const agentDir = getAgentDir();
  const fallbacks = [
    path.join(agentDir, "npm", "node_modules", "pi-claude-subagents"),
    path.resolve(agentDir, "..", "pi-claude-subagents"),
    path.resolve(startDir, ".."),
  ];
  for (const candidate of fallbacks) {
    if (fs.existsSync(path.join(candidate, "agents"))) return candidate;
  }
  return path.resolve(startDir, "..");
}

function sourceDirectories(cwd: string, packageRoot: string, includeProject: boolean): SourceDir[] {
  const agentDir = getAgentDir();
  const candidateRoots = [
    packageRoot,
    path.join(agentDir, "npm", "node_modules", "pi-claude-subagents"),
    path.resolve(agentDir, "..", "pi-claude-subagents"),
  ];
  const seen = new Set<string>();
  const dirs: SourceDir[] = [];
  for (const root of candidateRoots) {
    const resolved = path.resolve(root);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    dirs.push({ dir: path.join(resolved, "agents"), source: "builtin" });
  }
  dirs.push({ dir: path.join(agentDir, "agents"), source: "user" });
  if (includeProject) {
    for (const root of projectSearchRoots(cwd)) {
      dirs.push({ dir: path.join(root, CONFIG_DIR_NAME, "agents"), source: "project" });
    }
  }
  return dirs;
}

export function discoverAgents(options: {
  cwd: string;
  packageRoot: string;
  includeProject: boolean;
}): AgentDiscoveryResult {
  const agentMap = new Map<string, AgentDefinition>();
  const diagnostics: string[] = [];
  const dirs = sourceDirectories(options.cwd, options.packageRoot, options.includeProject);
  for (const { dir, source } of dirs) {
    const seenInDirectory = new Map<string, string>();
    for (const filePath of findFilesRecursive(dir)) {
      const parsed = parseAgentFile(filePath, source);
      if (typeof parsed === "string") {
        diagnostics.push(parsed);
        continue;
      }
      const duplicate = seenInDirectory.get(parsed.name);
      if (duplicate) diagnostics.push(`${dir}: duplicate agent name '${parsed.name}' in ${duplicate} and ${filePath}; filesystem order selected ${filePath}`);
      seenInDirectory.set(parsed.name, filePath);
      agentMap.set(parsed.name, parsed);
    }
  }
  return { agents: Array.from(agentMap.values()), searched: dirs.map(item => item.dir), diagnostics };
}

export function applyAgentModelSettings(agents: AgentDefinition[], settings: AgentModelSettings): { agents: AgentDefinition[]; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const known = new Set(agents.map(agent => agent.name));
  for (const name of Object.keys(settings.agentOverrides)) {
    if (!known.has(name)) diagnostics.push(`${settings.sourcePath}: subagents.agentOverrides.${name} does not match a discovered pi-claude-subagents agent and was ignored`);
  }
  return {
    diagnostics,
    agents: agents.map(agent => {
      const override = settings.agentOverrides[agent.name];
      return {
        ...agent,
        model: override?.model ?? agent.model ?? settings.defaultModel,
        thinking: override?.thinking ?? agent.thinking,
      };
    }),
  };
}

export function findAgent(agents: AgentDefinition[], name: string | undefined): AgentDefinition | undefined {
  const selectedName = name?.trim() || "general-purpose";
  const exact = agents.find(agent => agent.name === selectedName);
  if (exact) return exact;
  const lower = selectedName.toLowerCase();
  return agents.find(agent => agent.name.toLowerCase() === lower);
}
