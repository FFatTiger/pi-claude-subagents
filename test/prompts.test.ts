import test from "node:test";
import assert from "node:assert/strict";
import { discoverAgents } from "../src/agents.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { buildAgentToolDescription, buildParentPolicy } from "../src/prompts.ts";

const packageRoot = new URL("..", import.meta.url).pathname;
const agents = discoverAgents({ cwd: packageRoot, packageRoot, includeProject: false }).agents;

test("parent policy delegates broad investigation before extensive direct search", () => {
  const policy = buildParentPolicy(agents, DEFAULT_CONFIG);
  assert.match(policy, /open-ended, cross-module, context-heavy, or path-uncertain/i);
  assert.match(policy, /before spending a large parent-context search budget/i);
  assert.match(policy, /launch an `Explore` or matching specialist/i);
});

test("parent policy immediately fans out two or more independent questions", () => {
  const policy = buildParentPolicy(agents, DEFAULT_CONFIG);
  assert.match(policy, /two or more questions are genuinely independent/i);
  assert.match(policy, /immediately.*one `Agent` call.*`tasks` array/is);
  assert.match(policy, /two or three non-overlapping angles/i);
});

test("parent policy sequences dependent research before concrete implementation", () => {
  const policy = buildParentPolicy(agents, DEFAULT_CONFIG);
  assert.match(policy, /research determines the implementation/i);
  assert.match(policy, /obtain and synthesize the research result before assigning implementation/i);
  assert.match(policy, /concrete implementation brief/i);
  assert.match(policy, /Never delegate understanding/i);
});

test("parent policy delegates substantial implementation and verifies proactively", () => {
  const policy = buildParentPolicy(agents, DEFAULT_CONFIG);
  assert.match(policy, /more than a couple of edits/i);
  assert.match(policy, /substantial intermediate tool output/i);
  assert.match(policy, /without waiting for the user to request verification/i);
  assert.match(policy, /3\+ files|3 or more files/i);
});

test("parent policy keeps known narrow work direct and forbids polling or prediction", () => {
  const policy = buildParentPolicy(agents, DEFAULT_CONFIG);
  assert.match(policy, /known file/i);
  assert.match(policy, /specific symbol/i);
  assert.match(policy, /two or three known files/i);
  assert.match(policy, /small edit/i);
  assert.match(policy, /Do not poll, peek.*duplicate.*predict/is);
  assert.doesNotMatch(policy, /Use agents proactively but not excessively\./);
});

test("parent policy uses inherited runtime defaults and targeted optional budgets", () => {
  const policy = buildParentPolicy(agents, DEFAULT_CONFIG);
  assert.match(policy, /normal tasks inherit the selected role and runtime defaults/i);
  assert.match(policy, /intentionally bounded.*probe|bounded read-only probe/is);
  assert.match(policy, /implementation.*enough room.*validation/is);
  assert.match(policy, /wrap-up.*concise.*report/is);
});

test("short Agent description carries constructive budget guidance", () => {
  const description = buildAgentToolDescription(agents, DEFAULT_CONFIG);
  assert.match(description, /normal tasks inherit/i);
  assert.match(description, /bounded read-only probe/i);
  assert.match(description, /implementation.*validation/is);
});
