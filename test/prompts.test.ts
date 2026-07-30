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

test("parent policy requires explicit recurring progress supervision", () => {
  const policy = buildParentPolicy(agents, DEFAULT_CONFIG);
  assert.match(policy, /root Agent call always supplies explicit positive/i);
  assert.match(policy, /warning_turns.*warning_interval_turns/is);
  assert.match(policy, /tasks array.*inherit.*top-level/is);
  assert.match(policy, /inspect once with TaskOutput/i);
  assert.match(policy, /continue.*SendMessage.*TaskStop/is);
  assert.match(policy, /foreground launches release.*supervised running task/is);
});

test("short Agent description requires explicit supervision values", () => {
  const description = buildAgentToolDescription(agents, DEFAULT_CONFIG);
  assert.match(description, /every root call explicitly supplies/i);
  assert.match(description, /warning_turns.*warning_interval_turns/is);
  assert.match(description, /tasks-array children inherit/i);
  assert.match(description, /TaskOutput.*continue.*SendMessage.*TaskStop/is);
});
