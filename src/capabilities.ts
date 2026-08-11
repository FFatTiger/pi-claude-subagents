import type { AgentDefinition } from "./agents.ts";

export interface ToolDescriptor {
  name: string;
  source?: string;
  path?: string;
  scope?: string;
}

const BUILTIN_CHILD_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const ORCHESTRATION_TOOLS = new Set(["Agent", "SendMessage", "TaskOutput", "TaskStop"]);

export function agentAllowsNestedAgents(agent: AgentDefinition): boolean {
  const selected = !agent.tools?.length || agent.tools.includes("*") || agent.tools.includes("Agent");
  return selected && !agent.disallowedTools?.includes("Agent");
}

export function resolveAgentTools(options: {
  agent: AgentDefinition;
  inventory?: ToolDescriptor[];
  allowNestedAgent: boolean;
}): string[] {
  const parentTools = options.inventory === undefined
    ? BUILTIN_CHILD_TOOLS
    : options.inventory.map(tool => tool.name);
  const childRuntimeTools = new Set(BUILTIN_CHILD_TOOLS.filter(name => parentTools.includes(name)));
  const requested = options.agent.tools;
  const nestedSelected = options.allowNestedAgent && agentAllowsNestedAgents(options.agent);

  for (const denied of options.agent.disallowedTools ?? []) childRuntimeTools.delete(denied);

  if (!requested?.length || requested.includes("*")) {
    return [...childRuntimeTools, ...(nestedSelected ? ["Agent"] : [])];
  }

  const selected: string[] = [];
  for (const name of requested) {
    if (name === "Agent") {
      if (nestedSelected) selected.push(name);
      continue;
    }
    if (ORCHESTRATION_TOOLS.has(name)) continue;
    if (childRuntimeTools.has(name)) selected.push(name);
  }
  return [...new Set(selected)];
}
