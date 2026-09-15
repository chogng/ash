# Agent 工具规格

> 状态：Accepted（2026-08-23）
> 定位：[`agent-harness-design.md`](agent-harness-design.md) §5 工具面的实现规格：逐工具的
> JSON schema、**描述正文（模型可见的实际英文文本）**、参数校验规则、错误文案、输出格式与
> 限幅、capability 注记。工具指导由各工具定义拥有，不复制到模型基础 instructions。
>
> 工具的三层契约（定义/绑定/执行接口）归 [`tools.md`](tools.md)；审批/沙箱/升级语义归
> [`core.md`](core.md) §11。本文写"每个工具具体长什么样"。描述与错误文案是模型可见提示词
> 的一部分：修改需要按模型可见契约 review，并跑
> [`agent-harness-design.md` §14](agent-harness-design.md#14-评测) 的评测对比。

## 快速理解

默认 coding profile 同时向模型提供 `apply_patch` 与 `edit`：模型通常用 `apply_patch` 表达一个完整的多位置或多文件变更，只在唯一字符串微编辑或窄 patch 上下文失配时使用 `edit`。`apply_patch` 在写入前校验完整 patch，`edit` 要求本 Thread 先读并以 exact revision 条件写入；两者都受路径授权和 unknown outcome 不重放边界约束。本文件固定它们以及其余内置工具的模型可见 schema、描述、校验和错误文案。

| 决策 | 固定契约 |
| --- | --- |
| 默认代码修改 | `apply_patch`，一次表达一个逻辑变更 |
| 小范围确定性修改 | `edit`，要求 exact match 且默认唯一命中 |
| 多文件安全 | patch 在第一次写入前完成整体验证；多文件 envelope 不承诺事务性，unknown outcome 不重放 |
| 模型差异 | 不按模型或 Provider 名称切工具；有版本化评测或隐私受控聚合证据后再评审候选 profile |

## 1. 模式约定

所有工具 schema 按**最严格 provider 交集**编写，同一份 schema 直接用于 Anthropic
`input_schema` 与 OpenAI strict 模式：

1. 顶层必须是 `{"type": "object"}`；
2. `additionalProperties: false`；
3. **所有**属性进 `required`；可选性用类型并集表达：`{"type": ["string", "null"]}`；
4. 只用 `string` / `number` / `integer` / `boolean` / `array` / `object` / `enum`；
   顶层不用 `oneOf` / `anyOf` / `allOf`；
5. 每个参数带 `description`；数值参数写明单位与默认值；
6. 工具名用 `snake_case`，动词开头或名词短语，与描述首句一致。

错误文案原则：错误信息是模型的下一条输入——必须**可自纠**（说明哪个参数错、给出正确
形态或下一步动作），不写只有人类能懂的内部错误。

## 2. shell

| | |
| --- | --- |
| 状态 | 已接入（`ash-shell-command` + `local_tools.rs`），schema 需按本节收敛 |
| 执行 | 沙箱 + 审批走 `ash-action-policy`；执行上限 256 KiB / 默认 30s（已有） |
| 模型侧限幅 | 30 KiB，头尾各半，中间标注 `[... N bytes truncated ...]` |

**description（模型可见）：**

```text
Executes a shell command in an authorized directory and returns its combined stdout and
stderr with the exit code.

Usage notes:
- Use dedicated tools instead of shell equivalents when available: read_file
  instead of cat, grep instead of grep/rg, glob instead of find, apply_patch
  or edit instead of sed -i. Dedicated tools produce better results.
- Commands run with the selected directory as the default working directory; state
  such as environment variables does not persist between calls. Chain dependent
  steps with && in a single call.
- Long output is truncated from the middle; rerun with a narrower command (e.g.
  pipe through head/tail) if you need the omitted part.
- Never run interactive commands that wait for input (e.g. git rebase -i,
  npm init without -y); they will hang until the timeout.
```

**parameters：**

```json
{
  "type": "object",
  "properties": {
    "command": {
      "type": "string",
      "description": "The shell command to execute, run via the login shell with -c."
    },
    "timeout_ms": {
      "type": ["integer", "null"],
      "description": "Timeout in milliseconds. Default 30000, maximum 600000."
    },
    "working_directory": {
      "type": ["string", "null"],
      "description": "Absolute path to run in. Defaults to the selected directory and must stay inside an authorized directory."
    }
  },
  "required": ["command", "timeout_ms", "working_directory"],
  "additionalProperties": false
}
```

**校验与错误文案：**

| 情形 | 结果（`is_error: true` 的 Tool Result 文本） |
| --- | --- |
| `command` 为空/全空白 | `command must not be empty` |
| `working_directory` 在授权目录外 | `working_directory is outside the authorized directories: {path}` |
| `timeout_ms` 超上限 | `timeout_ms exceeds the maximum of 600000` |
| 超时 | `command timed out after {n} ms. Partial output:\n{截断输出}` |
| 非零退出 | 正常结果：输出 + `exit code: {n}`（非零退出不是工具错误） |

**输出格式：**合并流文本 + 末行 `exit code: {n}`。沙箱拒绝走 `SandboxDenialOutput` 结构化
路径（[`core.md`](core.md) §11），不进本表。

## 3. read_file

| | |
| --- | --- |
| 状态 | 已实现；由 canonical direct `LocalToolSuite` 提供，Agent 不再看到 operation-enum `file-system` |
| 模型侧限幅 | 默认 2000 行；单行 > 2000 字符截断并标注 |

**description：**

```text
Reads a file from an authorized directory and returns its content with line numbers.

Usage notes:
- Returns at most 2000 lines starting from `offset` (1-based). The last line
  of a truncated read says how many lines remain; call again with a larger
  offset to continue.
- Lines longer than 2000 characters are truncated with a marker.
- Binary files, including images, are rejected; use a dedicated viewer for images.
- You must read a file before editing or overwriting it.
- Prefer reading whole files (omit offset/limit) unless the file is too large.
```

**parameters：**

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Absolute path to the file to read."
    },
    "offset": {
      "type": ["integer", "null"],
      "description": "1-based line number to start from. Defaults to 1."
    },
    "limit": {
      "type": ["integer", "null"],
      "description": "Maximum lines to return. Defaults to 2000."
    }
  },
  "required": ["path", "offset", "limit"],
  "additionalProperties": false
}
```

**校验与错误文案：**

| 情形 | 文案 |
| --- | --- |
| 文件不存在 | `file not found: {path}`；若同目录有相近命名，附 `did you mean {candidate}?` |
| 是目录 | `{path} is a directory. Use glob to list its files` |
| 二进制且非图片 | `{path} is a binary file and cannot be displayed as text` |
| 超出授权目录 | `path is outside the authorized directories: {path}` |
| 空文件 | 正常结果：`(file is empty)` |

**输出格式：**`cat -n` 风格行号 + 制表符；截断尾注
`[... {n} more lines, continue with offset={next}]`。durable Tool Result 存完整读取结果的
限幅版（执行侧即模型侧，读取本身无副作用）。

## 4. write_file

| | |
| --- | --- |
| 状态 | 已实现；与 `read_file`/`edit` 共享 Thread-scoped 读后写入状态和磁盘 revision 校验 |
| capability | 写路径进入 `ActionReviewRequest`，沙箱/审批按路径判定 |

**description：**

```text
Creates or overwrites a file with the given content.

Usage notes:
- Overwriting an existing file you have not read in this conversation fails;
  read it first.
- Prefer apply_patch for modifying existing files, or edit for one small exact
  replacement; use write_file for new files or full rewrites you have read.
- Parent directories are created automatically.
- Never proactively create documentation files unless explicitly requested.
```

**parameters：**

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Absolute path of the file to write."
    },
    "content": {
      "type": "string",
      "description": "Full content to write. The previous content is replaced entirely."
    }
  },
  "required": ["path", "content"],
  "additionalProperties": false
}
```

**校验与错误文案：**

| 情形 | 文案 |
| --- | --- |
| 覆盖未读过的既有文件 | `{path} exists but has not been read in this conversation. Read it first, or choose a new path` |
| 超出授权目录 | `path is outside the authorized directories: {path}` |
| 目标是目录 | `{path} is a directory` |

"读过"判定由 App Server runtime 按 Thread scope 维护成功的 `read_file` 路径和内容 revision；
另一个 Thread 的读取不能授权当前 Thread。写入使用 expected revision 条件提交，因此读取后发生的
外部修改会拒绝写入；进程重启或重连后无法仅从 durable 路径恢复该内存 fingerprint，必须重新读取。

## 5. edit（微编辑与降级工具）

| | |
| --- | --- |
| 状态 | 已实现；由 canonical direct `LocalToolSuite` 提供并进入 `coding-v1` |
| 核心不变量 | `old_string` 唯一命中，否则拒绝——这条校验挡住大部分错误编辑 |

**description：**

```text
Performs an exact string replacement in a file.

Usage notes:
- You must read the file first; the edit fails otherwise.
- Use edit for one small, exact replacement, or as a fallback when a narrow
  apply_patch context cannot match. Prefer apply_patch for coordinated changes
  across multiple locations or files.
- old_string must match the file content exactly, including whitespace and
  indentation, and must identify a unique location. If it matches more than
  one location, extend it with surrounding lines until unique, or set
  replace_all to true to change every occurrence.
- Do not include line-number prefixes from read_file output in old_string.
- For moves or renames use shell with git mv; for full rewrites use write_file.
```

**parameters：**

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Absolute path of the file to modify."
    },
    "old_string": {
      "type": "string",
      "description": "Exact text to replace. Must be unique in the file unless replace_all is true."
    },
    "new_string": {
      "type": "string",
      "description": "Replacement text. Must differ from old_string."
    },
    "replace_all": {
      "type": ["boolean", "null"],
      "description": "Replace every occurrence. Defaults to false."
    }
  },
  "required": ["path", "old_string", "new_string", "replace_all"],
  "additionalProperties": false
}
```

**校验与错误文案：**

| 情形 | 文案 |
| --- | --- |
| 未读过该文件 | `{path} has not been read in this conversation. Read it first` |
| 0 命中 | `old_string not found in {path}. Re-read the file: the content may differ from what you expect (check whitespace and indentation)` |
| ≥2 命中且非 replace_all | `old_string matches {n} locations in {path}. Extend it with more surrounding context to make it unique, or set replace_all to true` |
| old == new | `new_string must differ from old_string` |
| 读后被外部修改 | `{path} changed on disk after your last read. Read it again before editing` |

**执行约束：**执行阶段在写入前完成已读校验、磁盘版本校验和命中计数，再以 expected revision 做同文件原子替换；任何校验失败都不得修改文件。

**输出格式：**成功返回替换处 ±4 行的带行号片段（模型自查 + UI 可渲染 diff）。

## 6. apply_patch（默认代码修改工具）

| | |
| --- | --- |
| 状态 | 已实现；`ash-apply-patch` 是 `coding-v1` 中唯一的 `apply_patch` executor |
| 格式 | V4A envelope（canonical 格式，不按模型或 Provider 发明方言） |

**description（模型可见）：**

```text
Apply a validated dir patch. Use *** Begin Patch and *** End Patch, with
*** Update File:, *** Add File:, or *** Delete File: operations. Prefer this
tool for general multi-hunk or multi-file code changes; use edit for one exact
local replacement.
```

**parameters：**

```json
{
  "type": "object",
  "properties": {
    "patch": {
      "type": "string",
      "description": "Patch text using the documented Begin/End Patch grammar."
    }
  },
  "required": ["patch"],
  "additionalProperties": false
}
```

**校验与错误文案：**空 patch → `patch must not be empty`；格式解析失败 →
`invalid patch: {parser reason}`；路径、目标类型或上下文校验失败 →
`patch could not be prepared: {reason}`。成功输出 JSON，分别列出 `updated_files`、`added_files` 与
`deleted_files`。prepare 必须在第一次写入前完成整份 patch 的解析、路径授权、文件读取和上下文校验；在存储层事务或回滚能力落地前，commit 阶段若可能已写入部分文件，必须返回 terminal unknown outcome，并由调度器禁止自动重放。多文件 envelope 本身不承诺原子性。

## 7. glob

| | |
| --- | --- |
| 状态 | 已实现；`LocalToolSuite` 使用冻结的 `rg --files` 枚举文件 |
| 限幅 | 100 条，按修改时间降序 |

**description：**

```text
Finds files by glob pattern, sorted by most recently modified.

- Supports patterns like "**/*.rs" or "src/**/*.test.ts".
- Returns at most 100 paths; narrow the pattern if truncated.
- Use grep to search file contents; use glob to find files by name.
```

**parameters：**

```json
{
  "type": "object",
  "properties": {
    "pattern": {
      "type": "string",
      "description": "Glob pattern to match file paths against."
    },
    "path": {
      "type": ["string", "null"],
      "description": "Directory to search in. Defaults to the selected directory."
    }
  },
  "required": ["pattern", "path"],
  "additionalProperties": false
}
```

**错误文案：**非法 pattern → `invalid glob pattern: {原因}`；无命中 → 正常结果
`no files match {pattern}`（不是错误）。截断尾注 `[{total} matches, showing first 100]`。

## 8. grep

| | |
| --- | --- |
| 状态 | 已实现；`LocalToolSuite` 调用公共 `grep::Search` 并格式化模型结果 |
| 限幅 | 100 条命中；单行 > 500 字符截断 |

**description：**

```text
Searches file contents with a regular expression.

- Full regex support, e.g. "fn\\s+resolve" or "TODO|FIXME".
- Results are file:line:content, capped at 100 matches; narrow with `glob`
  or `path` if truncated.
- Literal braces or dots must be escaped: use "foo\\.bar" to match "foo.bar".
- Always use this tool instead of invoking grep or rg through shell.
```

**parameters：**

```json
{
  "type": "object",
  "properties": {
    "pattern": {
      "type": "string",
      "description": "Regular expression to search for."
    },
    "path": {
      "type": ["string", "null"],
      "description": "File or directory to search. Defaults to the selected directory."
    },
    "glob": {
      "type": ["string", "null"],
      "description": "Restrict to files matching this glob, e.g. \"*.rs\"."
    },
    "case_insensitive": {
      "type": ["boolean", "null"],
      "description": "Case-insensitive search. Defaults to false."
    }
  },
  "required": ["pattern", "path", "glob", "case_insensitive"],
  "additionalProperties": false
}
```

**执行选择：**默认 `tgrep` 使用包内 executable 与按 Directory 常驻的索引服务；`ripgrep` 显式选择冻结的 `rg`。公共 `grep.backend` 配置同时用于 Agent、编辑器和 Codebase 文字候选。Ash 对 tgrep 结果按路径排序并限制 100 行，刚由 Ash 文件工具编辑的路径直接读取；其他修改由 tgrep 异步监听更新。初始索引未就绪、单文件及正向 glob 查询由 tgrep 扫描磁盘，具体边界见 [`ash-tgrep`](../ash-rs/tgrep/README.md)。

**错误文案：**正则非法 → 返回所选执行方式的稳定错误；无命中 → 正常结果 `no matches`。两种方式都遵守目录 ignore 规则。

## 9. update_plan

| | |
| --- | --- |
| 状态 | 已实现；薄工具 durable 提交 `ThreadEvent::PlanUpdated`，reducer 投影到 `Turn.plan` |
| 组装 | 模型调用从 canonical Turn snapshot 读取最新计划；Desktop 只投影 `Turn.plan` |

**description：**

```text
Records or updates your durable plan for a multi-step task.

- Use for tasks that need 3 or more distinct steps; skip it for trivial work.
- Keep at most one step in_progress at a time. Mark a step completed as soon
  as it is done; update the plan when scope changes rather than following a
  stale plan.
- Steps are short imperative phrases ("Fix parser offset bug"), not essays.
```

**parameters：**

```json
{
  "type": "object",
  "properties": {
    "plan": {
      "type": "array",
      "description": "The full plan, replacing any previous plan.",
      "minItems": 1,
      "maxItems": 100,
      "items": {
        "type": "object",
        "properties": {
          "step": { "type": "string", "description": "Short imperative description." },
          "status": { "type": "string", "enum": ["pending", "in_progress", "completed"] }
        },
        "required": ["step", "status"],
        "additionalProperties": false
      }
    },
    "explanation": {
      "type": ["string", "null"],
      "description": "Optional short explanation for this plan update."
    }
  },
  "required": ["explanation", "plan"],
  "additionalProperties": false
}
```

**校验与错误文案：**plan 为空或超过 100 步 → `plan must contain between 1 and 100 steps`；
多个 in_progress → `plan must contain at most one in_progress step`；step 为空或超过 1000 字符 →
`plan step must contain between 1 and 1000 characters: {step}`；explanation 超过 4000 字符时拒绝。
成功输出 canonical plan、durable sequence 与本次更新是否改变状态；相同计划幂等返回 unchanged。

## 10. MCP 元工具（检索式模式，[harness §6](agent-harness-design.md#6-工具注册时机)）

聚合 MCP catalog 只有在工具数 >15 或稳定估算 `ceil(canonical JSON bytes / 4)` >5000 时才整体
进入本模式；两个阈值都未超出时实际 MCP definitions 直接平铺。一次投影不能混合两种模式。

### 10.1 search_tools

```text
Searches the available MCP tools by keyword and returns matching tool
definitions. Use when the task needs a capability not covered by your core
tools (e.g. a service integration). Found definitions become callable via
call_mcp_tool.
```

```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string", "description": "Keywords describing the needed capability." }
  },
  "required": ["query"],
  "additionalProperties": false
}
```

返回 ≤ 5 个定义（name + description + schema + `catalog_digest` + `definition_digest`），不修改
tools 数组。返回顺序由冻结 catalog 上的确定性 score/name 决定；无命中返回
`no MCP tools match "{query}". Available servers: {list}`。

### 10.2 call_mcp_tool

```json
{
  "type": "object",
  "properties": {
    "tool": { "type": "string", "description": "Fully qualified name server__tool from search_tools results." },
    "catalog_digest": { "type": "string", "description": "Exact frozen catalog digest returned by search_tools." },
    "definition_digest": { "type": "string", "description": "Exact tool definition digest returned by search_tools." },
    "arguments": { "type": "object", "description": "Arguments matching the tool's schema.", "additionalProperties": true }
  },
  "required": ["tool", "catalog_digest", "definition_digest", "arguments"],
  "additionalProperties": false
}
```

digest 缺失/伪造或 catalog 已刷新时拒绝并要求重新 `search_tools`，同名新 definition 不能继承旧
绑定。参数校验错误透传 MCP server 的 schema 错误；执行、审批与结果转换沿用
[`tools.md`](tools.md) §10 的 MCP 适配器。

## 11. Agent 委托工具

| | |
| --- | --- |
| 状态 | 已接入具备有效目录 Grant 的 App Server Tool composition |
| 执行 | `MultiAgentCoordinator` + 独立委托 Thread；不经 MCP 自调用 |
| 权限 | 被委托运行只获得 spawn 时冻结的 tool name ceiling 与 active Skill digest |

### 11.1 spawn_agent

创建一个独立历史的 Agent 委托运行，立即返回 `delegation_id`、`child_thread_id`、
`child_turn_id` 和冻结的 Agent definition reference。参数为完整 `task: string`、可空短标签
`name`、可空 `agent` 和可空 `context`。`agent` 可显式指定 Directory definition；省略时只在
metadata 产生唯一匹配时自动选择，否则使用当前硬编码的 general role。`context`
支持 `fresh`、`full`、`lastTurns`、`checkpointAndTail`、`selected`；选中内容在 spawn 时固定
source sequence、物化内容与 digest，再随 immutable seed 注入。definition 的 catalog generation、
content digest、选择原因、role/model、引用 Instructions、active Skill 子集与 Tool ceiling 同样冻结；
引用不能扩大 parent 当前可见的能力。

### 11.2 send_agent_message

参数为 `delegation_id: string` 与非空 `message: string`。消息先写 sender outbox，再写 child
inbox；相同 Tool Call identity 重放时只投递一次。

### 11.3 wait_agent

参数可以选择单个 `delegation_id`、多个 `delegation_ids`，或省略二者冻结 parent 当前全部
delegation；`policy` 支持 `all`、`any`、`quorum`，最长等待 30000 ms。调用先提交 durable join，
再从 exact-once delegation results 求值；超时返回 waiting join，满足时返回 `satisfiedBy` 与
bounded results。进程恢复会重新求值 waiting join。

App Server 的调用方 Turn interrupt 与 Session stop 会提交 cancellation facts，并向仍在运行的委托后代
递归传播。`session/subscribe.agentTree` 是从同一 durable Session/Thread read set 生成的
canonical nested projection，包含 execution status、等待原因、Goal budget/usage、role、join 和
delegation result。Desktop Agent Sidebar 只消费该 projection；`session/thread/update` 只触发
重新读取 canonical projection，旧 Thread sequence 通知会被忽略。中断使用节点的 exact
`threadId/currentTurnId/threadSequence` 中断单个目标。

## 附录 A：工具行为评测基线

以下文字是工具描述、模型基础 instructions 和行为测试的评测基线，不作为要复制进中央 system prompt 的模板。具体工具名、参数和失败语义只在对应 `ToolDefinition` owner 中维护；模型基础 instructions 只要求遵守 host 提供的 exact schema。

### A.1 工具指导（共享段）

```text
## Tool usage

- Search before you read, read before you edit: locate code with grep and
  glob, read the relevant files, then make changes. Do not edit code you have
  not seen.
- Use the dedicated tools (read_file, grep, glob, apply_patch, edit) instead
  of their shell equivalents (cat, rg, find, sed). Use shell for builds,
  tests, git, and anything without a dedicated tool.
- Prefer several small, verifiable changes over one large speculative change.
- After a code change, verify it with the narrowest relevant check (the
  affected test, a typecheck, a targeted build) before moving on. Do not claim
  success without having verified.
- When a command or tool fails twice with the same error, stop repeating it.
  Diagnose, try a different approach, or report the blocker.
- For tasks with 3 or more distinct steps, maintain a plan with update_plan
  and keep it current.
```

### A.2 编辑工具选择

```text
- Use apply_patch by default for one logical code change, especially when it
  spans multiple locations or files. Keep the patch focused and regenerate it
  from current content when context lines fail to match.
- Use edit for one small exact unique-string replacement, or as a fallback
  after a narrow patch context mismatch. Extend old_string with surrounding
  lines when the match is ambiguous.
- Use write_file only for new files or full rewrites of files you have read.
- If apply_patch reports an unknown outcome, inspect the current working tree
  state before proceeding. Never replay the same patch blindly.
```

### A.3 输出风格（共享段）

```text
## Output style

- Your replies render in a developer-facing client. Be concise and direct:
  answer first, qualifications after, no filler ("Great!", "Certainly").
- Reference code as `path:line` so the user can jump to it. Use fenced code
  blocks only for code, commands, or file content - not for emphasis.
- After completing a task, summarize what changed and what you verified in a
  few sentences. Report failures plainly with the relevant output; never
  claim an unverified result.
- Ask the user only when a decision genuinely belongs to them (destructive
  actions, ambiguous requirements with materially different readings);
  otherwise pick the reasonable default and note the assumption.
```

## 附录 B：修改清单

修改本文任何工具的 schema、描述或错误文案时同步：

1. 对应实现 crate 的 schema/文案常量与测试；
2. 若模型基础 instructions 确实引用了该契约，同步 `ash-models-manager` 中对应资产与 revision；
3. [`agent-harness-design.md` §14](agent-harness-design.md#14-评测) 的组装快照和行为测试；
4. 运行对应的现有单元/集成测试；只有启用版本化模型 benchmark 时，才补充 T1/T2 对比。
