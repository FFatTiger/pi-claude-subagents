// Requires --experimental-test-module-mocks and --experimental-strip-types.
// No LLM calls. All filesystem writes are intercepted in memory.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { syncBuiltinESMExports } from "node:module";

const root = fileURLToPath(new URL("../", import.meta.url));
const virtualRoot = path.resolve("/virtual");
const agentDir = path.join(virtualRoot, "agent");
const url = p => pathToFileURL(path.join(root, p)).href;
const sdkURL = url("node_modules/@earendil-works/pi-coding-agent/dist/index.js");
const sdk = await import(sdkURL);

const files = new Map();
const sessions = [];
const quotas = [];
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(r => resolve = r);
  return { promise, resolve };
};
async function until(predicate) {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await tick();
  }
  throw Error("Probe condition did not occur");
}

const realRead = fs.readFileSync;
const realExists = fs.existsSync;
const realDir = fs.readdirSync;
fs.readFileSync = (p, ...args) =>
  files.has(String(p)) ? files.get(String(p)) : realRead(p, ...args);
fs.existsSync = p =>
  String(p).startsWith(virtualRoot) ? files.has(String(p)) : realExists(p);
fs.readdirSync = (p, ...args) =>
  String(p).startsWith(virtualRoot) ? [] : realDir(p, ...args);
syncBuiltinESMExports();

let outputBarrier;
let mkdirBarrier;
let failNextMkdir = false;
let denyPersist;
mock.method(fs.promises, "mkdir", async () => {
  if (failNextMkdir) {
    failNextMkdir = false;
    throw Error("offline task directory denied");
  }
  if (mkdirBarrier) {
    const barrier = mkdirBarrier;
    mkdirBarrier = undefined;
    barrier.started.resolve();
    await barrier.release.promise;
  }
});
mock.method(fs.promises, "rm", async () => {});
mock.method(fs.promises, "writeFile", async (p, value) => {
  if (denyPersist && path.basename(String(p)).startsWith("task.json.tmp-")) {
    const record = JSON.parse(String(value));
    if (record.description === denyPersist && record.status === "running") {
      denyPersist = undefined;
      throw Error("offline initial persist denied");
    }
  }
  if (path.basename(String(p)) === "output.md" && outputBarrier) {
    const barrier = outputBarrier;
    outputBarrier = undefined;
    barrier.started.resolve();
    await barrier.release.promise;
  }
  files.set(String(p), String(value));
});
mock.method(fs.promises, "rename", async (a, b) => {
  files.set(String(b), files.get(String(a)));
  files.delete(String(a));
});
mock.method(fs.promises, "readFile", async p => {
  if (!files.has(String(p))) throw Error("ENOENT");
  return files.get(String(p));
});

class Loader {
  constructor(options) { this.options = options; }
  async reload() {}
  getSkills() { return { skills: [] }; }
}
const model = { provider: "offline", id: "test", reasoning: false };
let prompt;

mock.module(sdkURL, {
  namedExports: {
    ...sdk,
    getAgentDir: () => agentDir,
    withFileMutationQueue: async (_p, fn) => fn(),
    ModelRuntime: { create: async () => ({}) },
    SettingsManager: { create: () => ({}) },
    DefaultResourceLoader: Loader,
    SessionManager: { create: () => ({}), open: () => ({}) },
    resolveCliModel: () => ({ model }),
    createAgentSession: async options => {
      const handlers = new Map();
      const listeners = new Set();
      for (const item of options.resourceLoader.options.extensionFactories) {
        item.factory({
          on: (e, f) => handlers.set(e, f),
          sendUserMessage() {},
        });
      }
      const session = {
        sessionFile: path.join(virtualRoot, `session-${sessions.length}`),
        model,
        thinkingLevel: "off",
        getAvailableThinkingLevels: () => ["off"],
        subscribe(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        dispose() {},
        async abort() { session.finish?.resolve(); },
        async prompt(text) {
          session.text = text;
          return prompt(session);
        },
        async emit(text, final = false) {
          const message = {
            role: "assistant",
            content: [
              { type: "text", text },
              ...(final ? [] : [{
                type: "toolCall", id: "call", name: "read", arguments: {},
              }]),
            ],
            stopReason: final ? "stop" : "toolUse",
            usage: {
              input: 1, output: 1, cacheRead: 0, cacheWrite: 0,
              cost: { total: 0 },
            },
          };
          handlers.get("turn_start")?.({}, {});
          if (!final) handlers.get("tool_call")?.({ toolName: "read" }, {});
          for (const fn of listeners) fn({ type: "message_end", message });
          handlers.get("turn_end")?.(
            { message }, { hasPendingMessages: () => false },
          );
        },
      };
      files.set(session.sessionFile, "offline session");
      sessions.push(session);
      return { session };
    },
  },
});

const runtimeURL = url("src/runtime.ts");
const runtime = await import(runtimeURL);
mock.module(runtimeURL, {
  namedExports: {
    ...runtime,
    createTaskQuota(limit) {
      const quota = runtime.createTaskQuota(limit);
      quotas.push(quota);
      return quota;
    },
  },
});
const { default: register } = await import(url("src/index.ts"));

function harness(limit = 20) {
  files.set(
    path.join(agentDir, "pi-claude-subagents.json"),
    JSON.stringify({ maxConcurrentTasks: limit }),
  );
  const handlers = new Map();
  const tools = new Map();
  const sent = [];
  const sessionId = `parent-${quotas.length}`;
  const pi = {
    on: (e, f) => handlers.set(e, f),
    registerTool: tool => tools.set(tool.name, tool),
    registerMessageRenderer() {},
    registerCommand() {},
    sendMessage: (message, options) => sent.push({ message, options }),
    getActiveTools: () => [],
    getAllTools: () => [],
    getThinkingLevel: () => "off",
  };
  const ctx = {
    cwd: root,
    mode: "interactive",
    isProjectTrusted: () => false,
    hasUI: false,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => undefined,
      getLeafId: () => undefined,
    },
    model,
    modelRegistry: {
      getAvailable: () => [model],
      getAll: () => [model],
      find: () => model,
    },
    getSystemPrompt: () => "",
  };
  register(pi);
  handlers.get("agent_start")({}, ctx);
  return {
    sent,
    quota: quotas.at(-1),
    call: (name, params, signal) =>
      tools.get(name).execute("offline", params, signal, undefined, ctx),
    flush: () => handlers.get("turn_end")({}, ctx),
  };
}
const spec = (description, background = true) => ({
  description,
  prompt: description,
  run_in_background: background,
  warning_turns: 1,
  warning_interval_turns: 1,
});
const array = tasks => ({
  tasks, warning_turns: 1, warning_interval_turns: 1,
});
async function startHeld(h, description) {
  prompt = async session => {
    session.finish = deferred();
    await session.finish.promise;
    await session.emit(`${session.text} 中文😀 final`, true);
  };
  const reply = await h.call("Agent", spec(description));
  const record = reply.details.tasks[0];
  await until(() => sessions.some(s => s.text === description && s.finish));
  return { record, session: sessions.find(s => s.text === description) };
}
async function finish(h, session) {
  session.finish.resolve();
  await until(() => h.quota.inUse === 0);
}

test("Agent array preserves final notification while background output is saving", async () => {
  const h = harness();
  const gate = deferred();
  const barrier = { started: deferred(), release: deferred() };
  prompt = async session => {
    if (session.text === "saving-A") {
      await session.emit("a".repeat(500) + "\nFINAL-END", true);
      return;
    }
    await gate.promise;
    await session.emit("foreground stage");
    session.finish = deferred();
    await session.finish.promise;
  };
  outputBarrier = barrier;
  const launch = h.call("Agent", array([
    spec("saving-A"), spec("saving-B", false),
  ]));
  await barrier.started.promise;
  gate.resolve();
  const reply = await launch;
  const A = reply.details.tasks.find(r => r.description === "saving-A");
  const body = reply.content[0].text;
  const saving = await h.call("TaskOutput", { task_id: A.id });

  barrier.release.resolve();
  await until(() => A.completedAt !== undefined);
  await tick();
  h.flush();
  const delivered = h.sent.filter(x =>
    x.message.content.includes(`<task-id>${A.id}</task-id>`));
  sessions.find(s => s.text === "saving-B").finish.resolve();
  await until(() => h.quota.inUse === 0);

  assert.match(saving.content[0].text, /Final output is still being saved/);
  assert.match(body, /still being saved/i);
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].message.content, /FINAL-END/);
});

test("foreground arrays reject insufficient capacity before starting any child", async () => {
  const h = harness(1);
  const start = sessions.length;
  const controller = new AbortController();
  let returned = false;
  prompt = async session => {
    await session.emit("first stage");
    session.finish = deferred();
    await session.finish.promise;
  };
  const call = h.call("Agent", array([
    spec("quota-A", false), spec("quota-B", false),
  ]), controller.signal).then(reply => {
    returned = true;
    return reply;
  });
  for (let i = 0; i < 30; i++) await tick();
  const childrenStarted = sessions.length - start;
  const returnedBeforeAbort = returned;
  controller.abort();
  const reply = await call;

  assert.equal(returnedBeforeAbort, true,
    "must reject immediately instead of waiting for a slot");
  assert.equal(childrenStarted, 0,
    "capacity rejection must start zero children");
  assert.match(reply.content[0].text, /^ERROR:/);
  assert.equal(h.quota.inUse, 0);
});

test("foreground reservations release held and unused slots on launch failure", async () => {
  const h = harness(2);
  const start = sessions.length;
  failNextMkdir = true;
  const rejected = await h.call("Agent", array([spec("failed-A", false), spec("failed-B", false)]));
  assert.match(rejected.content[0].text, /^ERROR:.*offline task directory denied/s);
  assert.equal(sessions.length, start);
  assert.equal(h.quota.inUse, 0);
  prompt = async session => { await session.emit("complete", true); };
  const next = await h.call("Agent", array([spec("next-A", false), spec("next-B", false)]));
  assert.doesNotMatch(next.content[0].text, /^ERROR:/);
  await until(() => h.quota.inUse === 0);
  assert.equal(h.quota.inUse, 0);
});

test("foreground reservations release every slot when aborted during preparation", async () => {
  const h = harness(2);
  const controller = new AbortController();
  const barrier = { started: deferred(), release: deferred() };
  mkdirBarrier = barrier;
  const launch = h.call("Agent", array([spec("abort-A", false), spec("abort-B", false)]), controller.signal);
  await barrier.started.promise;
  assert.equal(h.quota.inUse, 2);
  controller.abort();
  barrier.release.resolve();
  const rejected = await launch;
  assert.match(rejected.content[0].text, /^ERROR:/);
  assert.equal(h.quota.inUse, 0);
  assert.equal(sessions.some(session => session.text === "abort-B"), false);
});

test("resume preparation failures retain old record, pending result, and quota", async () => {
  for (const failure of ["missing-session", "persist-denied"]) {
    const h = harness();
    const description = `prepare-${failure}`;
    const { record, session } = await startHeld(h, description);
    await finish(h, session);
    if (failure === "missing-session") files.delete(record.sessionFile);
    else denyPersist = description;

    const reply = await h.call("SendMessage", {
      to: record.id, message: "new invocation",
    });
    h.flush();

    assert.match(reply.content[0].text, /^ERROR:/);
    assert.equal(record.status, "completed",
      "prepare must not mutate old live record");
    assert.equal(h.quota.inUse, 0);
    assert.equal(h.sent.length, 1,
      "failed resume must retain queued prior completion");
    assert.match(h.sent[0].message.content,
      new RegExp(`${description} 中文😀 final`));
  }
});

test("three resumes report fresh stages and independently readable latest output", async () => {
  const h = harness();
  const first = await startHeld(h, "initial");
  await finish(h, first.session);
  h.flush();
  const staleStages = [];

  for (let i = 1; i <= 3; i++) {
    const name = `resume-${i}`;
    const accepted = await h.call("SendMessage", {
      to: first.record.id, message: name,
    });
    assert.doesNotMatch(accepted.content[0].text, /^ERROR:/);
    await until(() => sessions.some(s => s.text === name && s.finish));
    const child = sessions.find(s => s.text === name);
    await child.emit(`NEW stage ${i}`);
    h.flush();
    const preview = h.sent.at(-1).message.content
      .match(/<preview>(.*?)<\/preview>/s)?.[1];
    if (preview !== `NEW stage ${i}`) {
      staleStages.push({ invocation: i, preview });
    }
    await finish(h, child);
    h.flush();
    const final = await h.call("TaskOutput", { task_id: first.record.id });
    assert.match(final.content[0].text, new RegExp(`${name} 中文😀 final`));
  }
  assert.deepEqual(staleStages, [],
    "warning preview must come from current invocation");
});
