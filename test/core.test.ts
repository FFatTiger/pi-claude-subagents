import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { applyAgentModelSettings, discoverAgents, findAgent } from "../src/agents.ts";
import { agentAllowsNestedAgents, resolveAgentTools } from "../src/capabilities.ts";
import { applyConfig, DEFAULT_CONFIG, loadAgentModelSettings } from "../src/config.ts";
import { buildAgentToolDescription, buildParentPolicy, classifyDispatch, resolveTaskIsolation } from "../src/prompts.ts";
import { createTaskQuota, finalNewTurnText, isMutatingShellCommand, isReadOnlyShellCommand, isShellCommandAllowed, prepareForkSession, validateAgentDefinition } from "../src/runtime.ts";
import { formatTaskOutputForModel, type TaskRecord } from "../src/tasks.ts";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function agents() {
  return discoverAgents({ cwd: packageRoot, packageRoot, includeProject: false }).agents;
}

test("discovers bundled Pi agents", () => {
  const result = discoverAgents({ cwd: packageRoot, packageRoot, includeProject: false });
  assert.equal(result.diagnostics.length, 0);
  assert.equal(findAgent(result.agents, "Explore")?.oneShot, true);
  assert.equal(findAgent(result.agents, "Plan")?.oneShot, true);
  assert.equal(findAgent(result.agents, "verification")?.background, true);
  assert.ok(findAgent(result.agents, undefined));
});

test("closest nested project agent overrides ancestor and bundled agent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-test-"));
  fs.mkdirSync(path.join(root, ".git"));
  const nested = path.join(root, "packages", "app");
  const rootAgents = path.join(root, ".pi", "agents");
  const nestedAgents = path.join(nested, ".pi", "agents");
  fs.mkdirSync(rootAgents, { recursive: true });
  fs.mkdirSync(nestedAgents, { recursive: true });
  fs.writeFileSync(path.join(rootAgents, "explore.md"), `---\nname: Explore\ndescription: Root override\ntools: read\n---\nRoot prompt\n`);
  fs.writeFileSync(path.join(nestedAgents, "explore.md"), `---\nname: Explore\ndescription: Closest override\ntools: read\n---\nNested prompt\n`);
  const result = discoverAgents({ cwd: nested, packageRoot, includeProject: true });
  const agent = findAgent(result.agents, "Explore");
  assert.equal(agent?.description, "Closest override");
  assert.equal(agent?.source, "project");
});

test("parses Pi-native agent frontmatter fields", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-frontmatter-"));
  const dir = path.join(cwd, ".pi", "agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "worker.md"), `---
name: worker
description: Full worker
tools: Agent, read, grep
disallowedTools: write
model: inherit
thinking: high
skills: research, code-review
readonly: true
background: true
isolation: worktree
oneShot: true
---
Worker prompt
`);
  const agent = findAgent(discoverAgents({ cwd, packageRoot, includeProject: true }).agents, "worker");
  assert.equal(agent?.readonly, true);
  assert.deepEqual(agent?.tools, ["Agent", "read", "grep"]);
  assert.deepEqual(agent?.disallowedTools, ["write"]);
  assert.deepEqual(agent?.skills, ["research", "code-review"]);
  assert.equal(agent?.thinking, "high");
  assert.equal(agent?.oneShot, true);
});

test("parses optional graceful budget frontmatter", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-budget-frontmatter-"));
  const dir = path.join(cwd, ".pi", "agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "scout.md"), `---
name: scout
description: Bounded scout
tools: read, grep
maxTurns: 12
graceTurns: 2
maxToolCalls: 40
softToolCalls: 30
toolBudgetBlock: read, grep, find, ls
timeoutMs: 900000
---
Scout prompt
`);
  const agent = findAgent(discoverAgents({ cwd, packageRoot, includeProject: true }).agents, "scout");
  assert.equal(agent?.maxTurns, 12);
  assert.equal(agent?.graceTurns, 2);
  assert.equal(agent?.maxToolCalls, 40);
  assert.equal(agent?.softToolCalls, 30);
  assert.deepEqual(agent?.toolBudgetBlock, ["read", "grep", "find", "ls"]);
  assert.equal(agent?.timeoutMs, 900000);
});

test("runtime defaults leave budgets and cleanup unset", () => {
  assert.equal(DEFAULT_CONFIG.maxConcurrentTasks, 20);
  assert.equal(DEFAULT_CONFIG.defaultTimeoutMs, undefined);
  assert.equal(DEFAULT_CONFIG.defaultMaxTurns, undefined);
  assert.equal(DEFAULT_CONFIG.defaultGraceTurns, 1);
  assert.equal(DEFAULT_CONFIG.defaultMaxToolCalls, undefined);
  assert.equal(DEFAULT_CONFIG.defaultSoftToolCalls, undefined);
  assert.deepEqual(DEFAULT_CONFIG.defaultToolBudgetBlock, ["read", "grep", "find", "ls"]);
  assert.equal(DEFAULT_CONFIG.maxOutputBytes, 200 * 1024);
  assert.equal(DEFAULT_CONFIG.maxOutputLines, 5000);
  assert.equal(DEFAULT_CONFIG.cleanupPeriodDays, undefined);
  for (const agent of agents()) {
    assert.equal(agent.maxTurns, undefined, `${agent.name} should inherit the unlimited default`);
    assert.equal(agent.maxToolCalls, undefined, `${agent.name} should inherit the unlimited default`);
    assert.equal(agent.timeoutMs, undefined, `${agent.name} should inherit the no-timeout default`);
  }
});

test("applies settings model overrides and reports stale role names", () => {
  const discovered = agents();
  const applied = applyAgentModelSettings(discovered, {
    defaultModel: "provider/default",
    agentOverrides: {
      verification: { model: "provider/verifier", thinking: "high" },
      reviewer: { model: "provider/legacy" },
    },
    sourcePath: "/tmp/settings.json",
  });
  assert.equal(findAgent(applied.agents, "verification")?.model, "provider/verifier");
  assert.equal(findAgent(applied.agents, "verification")?.thinking, "high");
  assert.equal(findAgent(applied.agents, "Plan")?.model, "provider/default");
  assert.match(applied.diagnostics.join("\n"), /reviewer.*ignored/);
});

test("loads user subagent model settings", () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-settings-"));
  const settingsPath = path.join(agentDir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ subagents: { defaultModel: "provider/default", agentOverrides: { Explore: { model: "provider/explore" } } } }));
  const loaded = loadAgentModelSettings(agentDir, false, agentDir);
  assert.equal(loaded.settings.defaultModel, "provider/default");
  assert.equal(loaded.settings.agentOverrides.Explore?.model, "provider/explore");
});

test("parent policy encodes routing fan-out continuation fork verification and nesting", () => {
  const prompt = buildParentPolicy(agents(), DEFAULT_CONFIG);
  assert.match(prompt, /two or three non-overlapping angles/);
  assert.match(prompt, /implementation and data flow/);
  assert.match(prompt, /wait for completion notifications/);
  assert.match(prompt, /subagent_type: "fork"/);
  assert.match(prompt, /parent converts research into concrete follow-up instructions/);
  assert.match(prompt, /Explore and Plan are one-shot/);
  assert.match(prompt, /same verifier after fixes/);
  assert.match(prompt, /depth 5/);
});

test("tool description explains fresh fork background and parallel dispatch", () => {
  const description = buildAgentToolDescription(agents(), DEFAULT_CONFIG);
  assert.match(description, /Named agents start fresh/);
  assert.match(description, /subagent_type: "fork"/);
  assert.match(description, /background by default/);
  assert.match(description, /tasks array/);
});

test("dispatch matches the Pi orchestration contract", () => {
  const discovered = agents();
  const general = classifyDispatch({ input: {}, agents: discovered, config: DEFAULT_CONFIG, mode: "tui", parentCanFork: true });
  assert.equal(general.agent.name, "general-purpose");
  assert.equal(general.forked, false);
  assert.equal(general.background, true);
  const fork = classifyDispatch({ input: { subagent_type: "fork" }, agents: discovered, config: DEFAULT_CONFIG, mode: "tui", parentCanFork: true });
  assert.equal(fork.forked, true);
  assert.equal(fork.background, true);
  const print = classifyDispatch({ input: { subagent_type: "Explore" }, agents: discovered, config: DEFAULT_CONFIG, mode: "print", parentCanFork: true });
  assert.equal(print.background, false);
  assert.throws(() => classifyDispatch({ input: { subagent_type: "fork" }, agents: discovered, config: DEFAULT_CONFIG, mode: "tui", parentCanFork: false }), /persisted parent session branch/);
  assert.throws(() => classifyDispatch({ input: { subagent_type: "fork" }, agents: discovered, config: DEFAULT_CONFIG, mode: "tui", parentCanFork: true, parentForked: true }), /inherited-context branching stays at the root/);
});

test("isolation selection honors explicit override and agent default", () => {
  assert.equal(resolveTaskIsolation(undefined, "worktree"), "worktree");
  assert.equal(resolveTaskIsolation("none", "worktree"), undefined);
  assert.equal(resolveTaskIsolation("worktree", undefined), "worktree");
  assert.equal(resolveTaskIsolation(undefined, undefined), undefined);
});

test("capability resolver selects Pi child-session tools", () => {
  const general = findAgent(agents(), "general-purpose")!;
  assert.equal(agentAllowsNestedAgents(general), true);
  const custom = { ...general, name: "custom", tools: ["read", "search_docs", "Agent"], disallowedTools: ["write"] };
  const resolved = resolveAgentTools({
    agent: custom,
    inventory: [{ name: "read" }, { name: "write" }, { name: "search_docs" }],
    allowNestedAgent: true,
  });
  assert.deepEqual(resolved.sort(), ["Agent", "read"].sort());
});

test("task quota waits in FIFO order for shared capacity", async () => {
  const quota = createTaskQuota(2);
  await quota.acquire(2);
  assert.equal(quota.inUse, 2);

  let firstStarted = false;
  let secondStarted = false;
  const first = quota.acquire().then(() => { firstStarted = true; });
  const second = quota.acquire().then(() => { secondStarted = true; });
  await Promise.resolve();
  assert.equal(firstStarted, false);
  assert.equal(secondStarted, false);

  quota.release();
  await first;
  assert.equal(firstStarted, true);
  assert.equal(secondStarted, false);

  quota.release();
  await second;
  assert.equal(secondStarted, true);
  quota.release(2);
  assert.equal(quota.inUse, 0);
});

test("task quota rejects acquire counts above the current limit", async () => {
  const quota = createTaskQuota(2);
  await assert.rejects(() => quota.acquire(3), /exceeds|above|limit/i);
  assert.equal(quota.inUse, 0);
});

test("aborted quota waiter is removed and the next eligible waiter starts", async () => {
  const quota = createTaskQuota(1);
  await quota.acquire();
  const controller = new AbortController();
  let abortedRejected = false;
  let secondStarted = false;

  const firstWaiter = quota.acquire(1, controller.signal).then(
    () => { throw new Error("aborted waiter should not start"); },
    () => { abortedRejected = true; },
  );
  const secondWaiter = quota.acquire().then(() => { secondStarted = true; });
  await Promise.resolve();
  assert.equal(secondStarted, false);

  controller.abort();
  await firstWaiter;
  assert.equal(abortedRejected, true);
  assert.equal(secondStarted, false);

  quota.release();
  await secondWaiter;
  assert.equal(secondStarted, true);
  quota.release();
  assert.equal(quota.inUse, 0);
});

test("progressive single-slot acquisition starts tasks as capacity frees", async () => {
  const quota = createTaskQuota(1);
  const started: number[] = [];
  const runners = [0, 1, 2].map(async index => {
    await quota.acquire();
    started.push(index);
    await Promise.resolve();
    quota.release();
  });
  await Promise.all(runners);
  assert.deepEqual(started, [0, 1, 2]);
  assert.equal(quota.inUse, 0);
});

test("task quota rejects a synchronous dependency when its parent holds the only slot", async () => {
  const quota = createTaskQuota(1);
  await quota.acquire();
  await assert.rejects(() => quota.acquireDependency(), /synchronous dependency.*capacity/i);
  quota.release();
  assert.equal(quota.inUse, 0);
});

test("read-only shell guard blocks mutations", () => {
  assert.equal(isReadOnlyShellCommand("git status --short"), true);
  assert.equal(isReadOnlyShellCommand("grep -R token src | head"), true);
  assert.equal(isReadOnlyShellCommand("find src -type f"), true);
  assert.equal(isReadOnlyShellCommand("find src -delete"), false);
  assert.equal(isReadOnlyShellCommand("ls\nrm -rf /tmp/x"), false);
  assert.equal(isReadOnlyShellCommand("ls & rm -rf /tmp/x"), false);
  assert.equal(isReadOnlyShellCommand("git status\ngit reset --hard"), false);
  assert.equal(isReadOnlyShellCommand("find src -fprintf /tmp/x %p"), false);
  assert.equal(isReadOnlyShellCommand("sort -o out.txt in.txt"), false);
  assert.equal(isReadOnlyShellCommand("python3 -c 'open(\"x\",\"w\").write(\"y\")'"), false);
  assert.equal(isShellCommandAllowed("npm test && npx tsc --noEmit", "verify"), true);
  assert.equal(isShellCommandAllowed("npm pack --dry-run", "verify"), true);
  assert.equal(isShellCommandAllowed("npm pack", "verify"), false);
  assert.equal(isShellCommandAllowed("python3 -m pytest", "verify"), true);
  assert.equal(isShellCommandAllowed("npm install left-pad", "verify"), false);
  assert.equal(isMutatingShellCommand("git commit -am test"), true);
  assert.equal(isMutatingShellCommand("echo data > file.txt"), true);
  assert.equal(isMutatingShellCommand("rm -rf build"), true);
});

test("agent validation rejects unsafe definitions", () => {
  const base = findAgent(agents(), "general-purpose")!;
  assert.throws(() => validateAgentDefinition({ ...base, name: "bad", readonly: true, shellPolicy: "unrestricted" }), /requires shellPolicy/);
});

test("fork preparation rejects non-durable parent branch", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fork-test-"));
  const sessionDir = path.join(cwd, "sessions");
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const manager = SessionManager.create(cwd, sessionDir);
  const leaf = manager.appendMessage({ role: "user", content: "not durable yet", timestamp: Date.now() });
  const headerPath = manager.getSessionFile();
  assert.ok(headerPath);
  await assert.rejects(
    prepareForkSession({ parentSessionFile: headerPath!, parentLeafId: leaf, taskDir: path.join(cwd, "task"), cwd }),
    /not been durably written/,
  );
});

test("resume fallback does not reuse historical output", () => {
  assert.equal(finalNewTurnText([]), "(Subagent completed without new text output.)");
});

test("task output uses byte and line bounds and names the full output file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-output-test-"));
  const outputFile = path.join(dir, "output.md");
  fs.writeFileSync(outputFile, "first\nsecond\nthird\nfourth\n");
  const record = {
    id: "id",
    parentSessionId: "parent",
    agent: "Explore",
    description: "test",
    prompt: "test",
    cwd: dir,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "completed",
    background: false,
    forked: false,
    oneShot: true,
    maxTurns: 10,
    maxToolCalls: 20,
    timeoutMs: 60_000,
    outputFile,
    taskFile: path.join(dir, "task.json"),
    usage: {
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
    },
  } satisfies TaskRecord;
  const output = formatTaskOutputForModel(record, { bytes: 1024, lines: 2 });
  assert.match(output, /Truncated/);
  assert.match(output, new RegExp(outputFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(output, /first\nsecond/);
  assert.doesNotMatch(output, /third/);
});

test("task output byte truncation is UTF-8 safe", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-output-utf8-"));
  const outputFile = path.join(dir, "output.md");
  // each emoji is 4 UTF-8 bytes
  fs.writeFileSync(outputFile, "a😀b😁c😂d");
  const record = {
    id: "id",
    parentSessionId: "parent",
    agent: "Explore",
    description: "test",
    prompt: "test",
    cwd: dir,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "completed",
    background: false,
    forked: false,
    oneShot: true,
    outputFile,
    taskFile: path.join(dir, "task.json"),
    usage: {
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
    },
  } satisfies TaskRecord;
  const output = formatTaskOutputForModel(record, { bytes: 6, lines: 100 });
  const body = output.split("\n\n").slice(1).join("\n\n");
  assert.match(output, /Truncated/);
  assert.ok(Buffer.byteLength(body, "utf8") <= 6);
  assert.doesNotThrow(() => Buffer.from(body, "utf8").toString("utf8"));
  assert.equal(body.includes("\uFFFD"), false);
  assert.match(body, /^a😀/);
});

test("task output byte truncation never returns a lone UTF-16 surrogate", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-output-surrogate-"));
  const outputFile = path.join(dir, "output.md");
  fs.writeFileSync(outputFile, "a😀b");
  const record = {
    id: "id",
    parentSessionId: "parent",
    agent: "Explore",
    description: "test",
    prompt: "test",
    cwd: dir,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "completed",
    background: false,
    forked: false,
    outputFile,
    taskFile: path.join(dir, "task.json"),
    usage: {
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
    },
  } satisfies TaskRecord;

  const output = formatTaskOutputForModel(record, { bytes: 4, lines: 100 });
  const body = output.split("\n\n").slice(1).join("\n\n");
  assert.equal(body, "a");
  assert.equal(/[\uD800-\uDFFF]/u.test(body), false);
  assert.equal(Buffer.byteLength(body, "utf8") <= 4, true);
});

test("project config null unsets inherited optional defaults", () => {
  const inherited = applyConfig(DEFAULT_CONFIG, {
    defaultTimeoutMs: 60_000,
    defaultMaxTurns: 10,
    defaultMaxToolCalls: 20,
    defaultSoftToolCalls: 15,
    cleanupPeriodDays: 7,
  });
  assert.equal(inherited.defaultTimeoutMs, 60_000);
  assert.equal(inherited.defaultMaxTurns, 10);
  assert.equal(inherited.defaultMaxToolCalls, 20);
  assert.equal(inherited.defaultSoftToolCalls, 15);
  assert.equal(inherited.cleanupPeriodDays, 7);

  const unset = applyConfig(inherited, {
    defaultTimeoutMs: null,
    defaultMaxTurns: null,
    defaultMaxToolCalls: null,
    defaultSoftToolCalls: null,
    cleanupPeriodDays: null,
  });
  assert.equal(unset.defaultTimeoutMs, undefined);
  assert.equal(unset.defaultMaxTurns, undefined);
  assert.equal(unset.defaultMaxToolCalls, undefined);
  assert.equal(unset.defaultSoftToolCalls, undefined);
  assert.equal(unset.cleanupPeriodDays, undefined);
});
