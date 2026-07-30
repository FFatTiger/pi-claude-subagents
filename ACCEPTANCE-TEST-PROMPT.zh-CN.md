# pi-claude-subagents 新会话全能力验收提示词

## 使用方法

1. 在 `/Users/proxy/.pi/pi-claude-subagents` 启动一个新的 Pi 会话。
2. 先执行一次：

```text
/reload
```

3. 把下面“测试提示词”部分完整粘贴到新会话。
4. 这是一套多回合验收。后台任务完成通知会自动推进会话，让代理持续执行到最终报告。

---

## 测试提示词

你现在负责对 `/Users/proxy/.pi/pi-claude-subagents` 做一次完整、真实、Pi 原生的端到端验收。目标是实际调用 `Agent`、`SendMessage`、`TaskOutput` 和 `TaskStop`，覆盖 Fresh、Fork、并行、后台通知、继续会话、软预算、工具预算、超时、嵌套代理、工作树隔离、验证代理、持久化和严格任务路由。

当前会话中的验收 nonce 是：

```text
FORK-CONTEXT-7F3A9C21
```

## 总体执行方式

- 把所有测试写入限定在新建的临时沙箱：`/tmp/pi-claude-subagents-acceptance-<时间戳>`。
- 把 `/Users/proxy/.pi/pi-claude-subagents` 作为被测包，仅运行检查和读取源码。
- 使用真实 Pi 工具和真实子代理，不用伪造结果。
- 每个检查记录：测试目标、实际调用、观察结果、PASS/FAIL、证据路径。
- 后台任务以自动完成通知作为主要完成机制；`TaskOutput` 只在专门测试状态读取时调用一次，不形成轮询。
- 前一阶段的结果决定后一阶段输入时，先取得并综合结果，再继续。
- 如果某个检查失败，保留现场并继续执行其他相互独立的检查，最后统一报告。
- 正常任务继承角色和运行时默认值；只在预算、超时能力的专门测试中显式传入相关参数。
- 最终结论必须以实际命令、任务状态、termination kind、usage 字段或持久化文件为依据。

## 阶段 0：启动诊断与自动化基线

1. 运行 `/pi-subagents-doctor`，记录以下信息：
   - 已发现的角色；
   - 每个角色的模型和 thinking；
   - background、fork、worktree 是否启用。
2. 在被测包目录运行：

```bash
npm test
npm run typecheck
npm pack --dry-run
```

3. 验证测试数量、类型检查退出码和打包文件清单。
4. 读取 `src/config.ts` 和四个 `agents/*.md`，确认默认值：
   - 并发 20；
   - 默认 timeout、turn、tool budget 未设置；
   - grace 为 1；
   - 默认工具阻止列表为 `read/grep/find/ls`；
   - 输出上限为 200 KiB、5000 行；
   - cleanup 默认未设置；
   - 内置角色没有固定 `maxTurns`、`maxToolCalls`、`timeoutMs`。

## 阶段 1：创建隔离测试沙箱

创建唯一临时目录，并在其中准备：

```text
fresh-marker.txt       内容：FRESH_FILE_OK
parallel-a.txt          内容：PARALLEL_A_OK
parallel-b.txt          内容：PARALLEL_B_OK
parallel-c.txt          内容：PARALLEL_C_OK
resume-context.txt      内容：RESUME_CONTEXT_OK
```

再创建一个小型 Node.js Git 仓库 `worktree-repo/`：

- `value.txt` 初始内容为 `PARENT_ORIGINAL`；
- `package.json` 提供 `npm test`；
- 一个最小 `node:test` 测试；
- 初始化 Git，设置仅限该仓库的测试用户名和邮箱，并提交初始版本。

把沙箱绝对路径记入验收记录。

## 阶段 2：Fresh 前台与单次角色

用 `Explore` 前台启动一个 Fresh 任务：

- `run_in_background: false`；
- `cwd` 指向沙箱；
- 要求读取 `fresh-marker.txt` 并原样返回内容和绝对路径；
- 同时询问它是否知道父会话的 acceptance nonce，但不要把 nonce 值写入子任务 prompt；若上下文中没有该值，应返回 `CONTEXT_NOT_AVAILABLE`。

验收点：

- 得到 `FRESH_FILE_OK`；
- Fresh 子代理没有继承父会话 nonce；
- 任务状态为 completed；
- 再对这个 Explore 任务调用 `SendMessage`，确认 one-shot 角色返回明确的不可恢复说明。

## 阶段 3：Fork 继承上下文

启动根级 `fork` 任务，子任务指令只写：

```text
从继承的父会话上下文中找出 acceptance nonce，原样返回；同时说明你是从对话上下文而不是文件中获得它的。
```

不要在 Fork 指令里重复 nonce 值。使用后台执行并通过自动通知接收结果。

验收点：

- Fork 返回 `FORK-CONTEXT-7F3A9C21`；
- task 记录显示 `forked: true`；
- 模型和 thinking 与父会话继承关系正确；
- 完成通知自动到达。

## 阶段 4：并行任务与自动后台通知

使用一次 `Agent` 调用的 `tasks` 数组，同时启动三个互不重叠的 `Explore`：

- 分别读取 `parallel-a.txt`、`parallel-b.txt`、`parallel-c.txt`；
- 三个任务均使用同一个沙箱 cwd；
- 每个任务只返回自己的 marker、文件绝对路径和一句结论。

启动后继续做独立的本地证据整理，随后依靠自动完成通知收集结果。

验收点：

- 一个调用成功创建三个任务；
- 三个 marker 全部正确；
- 没有串任务或重复执行；
- 每个后台任务只出现一次完成通知；
- 输出文件均存在。

## 阶段 5：Live SendMessage 与恢复已完成任务

### 5A：运行中 steering

启动一个后台 `general-purpose` 任务，要求它：

- 读取被测包中的 `src/config.ts`、`src/lifecycle.ts`、`src/runtime.ts`、`src/tasks.ts`；
- 总结四个文件的职责；
- 进行足够完整的分析后再汇报。

任务启动后立即用任务 ID 调用一次 `SendMessage`：

```text
在最终报告中加入独立一行 LIVE_STEER_OK，并额外说明 defaultMaxTurns 当前是否设置。
```

验收点：完成结果包含 `LIVE_STEER_OK`，且对默认回合预算的判断正确。

### 5B：恢复持久化会话

在上述任务完成后，再次对同一个任务使用 `SendMessage`：

```text
继续刚才的会话。引用你上次报告中的一个具体文件职责，并加入独立一行 RESUME_OK。
```

验收点：

- 原任务被恢复，而不是创建无关 Fresh 任务；
- 新输出追加到原 `output.md`；
- 返回 `RESUME_OK`；
- 能引用上次会话的具体内容。

## 阶段 6：严格任务路由与歧义

启动两个快速后台 `general-purpose` 任务，并把两者的 `name` 都设置为：

```text
duplicate-routing-check
```

等待二者完成后：

1. 用该重复 name 调用 `SendMessage`，确认返回歧义错误和候选任务 ID；
2. 用其中一个唯一 UUID 前缀调用 `SendMessage`，确认能精确恢复目标任务；
3. 用完整 UUID 再确认精确路由；
4. 用空白目标做一次错误输入检查，确认错误信息明确。

## 阶段 7：TaskOutput 与 TaskStop

启动一个后台 `general-purpose` 任务，要求其第一步通过 bash 执行：

```bash
node -e "setTimeout(() => console.log('LONG_TASK_FINISHED'), 60000)"
```

随后再生成报告。

任务启动后：

1. 调用一次 `TaskOutput`，参数 `block: false`，确认状态为 running 或能解释任务已经快速结束；
2. 对运行中的任务调用 `TaskStop`；
3. 读取最终 task 记录和输出文件。

验收点：

- 停止后的状态为 `stopped`；
- termination kind 为 `manual_stop`；
- 已有部分输出被保留；
- 配额在停止后释放。

## 阶段 8：公开参数移除、任务特定监督与 thinking 诊断

检查 Agent 工具的单任务和 `tasks` 子项 schema，确认不再暴露 `max_turns`、`max_tool_calls`、`timeout_ms`，同时根调用必须显式填写两个正整数 warning 参数。分别设计窄范围查询、常规调查、跨模块研究和多文件实现任务，确认调用方会根据范围、风险、工具成本、外部等待和中间进度可见性选择不同的 `warning_turns` / `warning_interval_turns`，而不是机械复用同一组值。批量子项可以覆盖，否则继承顶层值。随后启动一个普通 `general-purpose` 前台任务，thinking 显式设为 `high`，要求它完成三轮不同的读取/搜索后汇报。

完成后读取对应 `task.json`。

验收点：

- 公开 Agent 调用没有三项硬预算参数，但根调用必须显式包含两个正整数 warning 参数；
- 模型可见的 schema、工具说明和父提示词不把内部 30/20 兜底写成常规推荐值；
- 窄范围或高卡死风险任务选择更早、更频繁的监督，广泛且进度清晰的实现任务选择更晚、更稀疏的监督；
- 至少三种不同任务的真实调用 JSON 使用了不同的合理 warning 组合；
- tasks-array 子项不重复填写时继承顶层 warning 值，风险明显不同时显式覆盖；
- `task.json` 中的 `warningTurns`、`warningIntervalTurns` 和 `nextWarningTurn` 与调用所选值一致；
- `maxTurns`、`maxToolCalls`、`timeoutMs` 没有被默认写成旧的 80/120/30 分钟；
- requested thinking 为 high；
- effective thinking 为 high，或存在明确的 clamp reason；
- 任务能正常完成多轮工作。

## 阶段 9：重复监督提醒与前台释放

创建一个测试专用自定义 `general-purpose` 覆盖角色，将 `warningTurns` 设为 2、`warningIntervalTurns` 设为 2，不配置硬预算。前台启动一个会持续至少 5 轮、每轮都有明确进展 marker 的任务。

验收点：

- 第 2 轮仍准备继续时发送第一次结构化 progress warning；
- 前台 Agent 工具在第一次 warning 后返回，但子任务保持 running 并继续持有配额；
- task 被提升为 supervised background，最终完成时根会话仍收到 completion follow-up；
- 第 4 轮仍继续时再次提醒，同一 checkpoint 不重复；
- warning 不注入收尾提示、不阻止工具、不改变 termination kind；
- 如果任务恰好在 checkpoint 完成，则该 checkpoint 不提醒；
- `TaskOutput` 可在 warning 后检查一次，随后可选择继续、`SendMessage` 或 `TaskStop`。

## 阶段 10：恢复后的 checkpoint 去重

让一个可恢复任务经过第一次 warning 后完成，再用 `SendMessage` 恢复并继续到下一个 checkpoint。

验收点：

- `warningCount`、`lastWarningTurn`、`nextWarningTurn` 持久化；
- resume 不重发已经触发的 checkpoint；
- 后续提醒按照原 interval 继续；
- 旧 task record 没有 warning 字段时，安全补齐正整数默认值。

## 阶段 11：高级硬预算兼容

硬预算不再通过普通 Agent 调用传入。分别创建测试专用自定义 Agent frontmatter 或运行时配置来验证：

- `maxTurns: 1` 与 grace 仍能请求收尾并保留有效报告；
- `maxToolCalls: 1` 仍只阻止配置的工具集合；
- `timeoutMs: 1500` 仍产生 `partial/timeout`；
- 历史 task record 仍可读取、诊断和恢复；
- README/DESIGN 将这些字段描述为高级无人值守策略，而不是普通调用参数。

## 阶段 12：嵌套代理

启动一个前台 `general-purpose`，要求它自己调用嵌套 `Agent`：

- 嵌套类型为 `Explore`；
- 嵌套任务读取被测包 `src/config.ts`，找出 `maxAgentDepth` 和 `maxConcurrentTasks`；
- 外层子代理必须综合嵌套结果，并在最终报告写入 `NESTED_AGENT_OK`。

验收点：

- 嵌套任务的 parentTaskId/depth 正确；
- 嵌套结果返回直接父代理，由直接父代理综合；
- 根会话只收到外层任务的最终综合结果；
- 输出包含正确默认值和 `NESTED_AGENT_OK`。

同时通过现有自动测试或纯配额探针确认：当并发上限只有 1 且父任务持有唯一名额时，同步嵌套会明确拒绝，而不是永久等待。

## 阶段 13：Git worktree 隔离

在 `worktree-repo/` 上前台启动 `general-purpose`：

- `isolation: "worktree"`；
- 要求把隔离工作树里的 `value.txt` 改为 `CHILD_WORKTREE_CHANGE`；
- 运行仓库测试；
- 报告工作树路径、分支、改动文件和测试结果。

验收点：

- 父检出目录中的 `value.txt` 仍为 `PARENT_ORIGINAL`；
- 子工作树中的文件为 `CHILD_WORKTREE_CHANGE`；
- 修改后的工作树被保留并报告路径；
- 未修改父检出目录；
- 测试结果可核验。

## 阶段 14：实现代理与独立 verification

在沙箱中创建一个独立小项目，至少包含三个文件和 `node:test` 测试。然后：

1. 用 `general-purpose` 实现一个小而明确的功能，要求修改至少三个文件并运行测试；
2. 父代理阅读并理解实现结果；
3. 启动 Fresh `verification`，把原始要求、全部改动文件、实现方法和风险点完整传入；
4. verification 必须实际运行测试并做至少一个边界或错误输入探针；
5. 若 verification FAIL，修复后用 `SendMessage` 恢复同一个 verifier 复验。

验收点：

- 实现代理具备写入和验证能力；
- verification 保持只读；
- verification 报告有实际命令和输出；
- 最终结论严格为 `VERDICT: PASS`、`FAIL` 或 `PARTIAL`；
- 父代理独立抽查至少两个决定性证据。

## 阶段 15：输出、持久化与清理默认值

检查本次验收产生的任务目录：

```text
<getAgentDir()>/pi-claude-subagents/<root-session-id>/<task-id>/
```

验收点：

- `task.json`、`output.md`、可恢复任务的 `session.jsonl` 存在；
- task 记录包含 ancestry、depth、状态、termination、usage、thinking 和有效能力快照；
- 超长输出的自动测试确认 200 KiB/5000 行边界、完整文件路径和 UTF-8/UTF-16 安全截断；
- 默认 cleanup 未设置，本次完成任务不会因为启动新会话而自动按 30 天策略删除。

## 最终报告格式

完成全部可执行阶段后，输出一份中文验收报告：

```text
# pi-claude-subagents 全能力验收报告

环境：
- Pi 版本：
- 包路径：
- 根会话 ID：
- 沙箱路径：

## 汇总
通过：X
失败：Y
受环境限制：Z

## 检查表
| # | 能力 | 结果 | 核心证据 |
|---|---|---|---|
| 1 | Fresh 隔离 | PASS/FAIL | ... |
...

## 预算与生命周期证据
- 默认预算：
- turn/grace：
- tool requested/executed/blocked：
- timeout：
- stop：

## 并发与路由证据
- parallel：
- FIFO/容量：
- UUID/prefix/name ambiguity：
- nested：

## 持久化与隔离证据
- resume：
- output 文件：
- worktree：
- cleanup：

## 自动化门禁
- npm test：
- typecheck：
- npm pack --dry-run：
- verification verdict：

## 发现的问题
按 Critical / Important / Minor 分类；没有则写“无”。

FINAL VERDICT: PASS | FAIL | PARTIAL
```

判定规则：

- 核心生命周期、路由、预算、并发、持久化或隔离出现可复现错误时为 FAIL；
- 仅因当前环境缺少某个外部能力而无法验证时为 PARTIAL，并明确剩余不确定性；
- 所有核心能力有真实证据且自动化门禁通过时为 PASS。
