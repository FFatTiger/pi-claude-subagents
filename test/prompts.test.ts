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

test("parent policy requires task-specific recurring progress supervision", () => {
  const policy = buildParentPolicy(agents, DEFAULT_CONFIG);
  assert.match(policy, /chooses explicit positive warning_turns/i);
  assert.match(policy, /scope.*uncertainty.*drift risk.*tool cost/is);
  assert.match(policy, /narrow lookup.*8-12.*5-8/is);
  assert.match(policy, /routine code investigation.*15-25.*8-12/is);
  assert.match(policy, /broad cross-module research.*25-35.*12-20/is);
  assert.match(policy, /multi-file implementation.*30-45.*15-25/is);
  assert.match(policy, /do not mechanically reuse one pair/i);
  assert.match(policy, /tasks array.*inherit.*materially differs/is);
  assert.match(policy, /inspect once with TaskOutput/i);
});

test("short Agent description tells the caller how to choose supervision values", () => {
  const description = buildAgentToolDescription(agents, DEFAULT_CONFIG);
  assert.match(description, /chooses positive warning_turns/i);
  assert.match(description, /narrow.*8-12.*5-8/is);
  assert.match(description, /routine investigation.*15-25.*8-12/is);
  assert.match(description, /broad research.*25-35.*12-20/is);
  assert.match(description, /multi-file implementation.*30-45.*15-25/is);
  assert.match(description, /scope or risk materially differs/i);
  assert.match(description, /TaskOutput.*continue.*SendMessage.*TaskStop/is);
  assert.doesNotMatch(description, /normally 30|normally 20|30\/20/);
});
