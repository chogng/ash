# Hooks

Hooks 在指定事件发生时执行用户配置的程序。Ash 提供 33 种事件；事件本身不是已配置的 Hook，
只有绑定了执行程序的声明才会参与匹配。

本 crate 是 Hooks 的阅读入口，配置方法、事件说明和运行时约定都从这里进入：

- [配置与浏览](#配置与浏览)：选择用户或项目配置，查看来源并检查修改结果。
- [事件目录](docs/events.md)：33 种事件的触发时机与拒绝语义。
- [运行时与权限](docs/runtime.md)：沙箱进程、输入输出、生命周期、失败与取消。

## 配置与浏览

### 桌面 Settings

打开 **Settings → Agents → Hooks**，可以浏览全部 33 种事件，以及当前连接的 App Server
返回的 Hook 声明。事件和声明都可以展开；使用 Settings 的统一搜索可查找事件、Hook ID、命令和路径。
详情显示启用状态、来源 TOML、工具匹配、程序与
完整参数。搜索支持事件名称、Hook ID、命令和来源路径，禁用声明仍计入数量。

选择用户或项目范围后，**编辑 TOML** 打开该范围的配置：本地用户配置通过系统文本编辑器
打开，项目配置通过工作区编辑器打开。首次编辑会创建缺失的空文件，已有内容与注释保留。
远程项目使用远程工作区资源；远程用户配置通过所属主机或助手编辑，不会交给本地编辑器。

**让 Ash 配置** 关闭 Settings，把目标事件、文件和已知来源身份追加到当前聊天草稿。
原有文字、模式与附件保留，不会自动发送。保存配置后点击 **刷新** 检查修改；用户配置变更
通知也会刷新当前页面。加载失败显示错误，不会把查询失败显示成“未配置”。
本地用户 TOML 的编辑入口由桌面主进程提供；即使查询失败或 App Server 离线，也可以打开
该文件修正配置。浏览器环境和远程用户配置不使用这个本地入口。

项目声明依赖当前聊天会话的目录发现权限。工作区内可以打开项目 TOML，但只有会话目录
同时具备 `LoadConfig` 和 `DiscoverHooks` 时，其声明才进入列表。页面只浏览和协助编辑配置，
不执行 Hook，也不授予执行权限。

### 终端 `/hooks`

在 Ash Code 中输入 `/hooks`，默认看到 33 种事件及其配置数量。`0` 表示该事件尚未配置程序，
不是事件不可用。选择事件后查看对应的 Hook，再选择具体 Hook 查看事件、启用状态、来源文件、
工具匹配、程序和参数。旧配置中的 `beforeTool`、`afterTool`、`turnCompleted` 有声明时仍可浏览，
它们保留原有触发语义。

选择 **Configure Hooks / 配置钩子** 可打开用户配置、项目配置，或者让 Ash 帮助配置。
“让 Ash 配置”会选择配置范围，并把事件和目标文件填入当前输入框；原有草稿与附件保留，
用户补充需求后再发送。浏览操作不新增、删除或切换 Hook；旧格式文件的读取遵循 Config 的
版本迁移规则。

| 范围 | 配置位置 | 用途 |
| --- | --- | --- |
| 用户 | `<profile>/config.toml`，默认 `~/.ash/config.toml` | 跨项目使用；以当前连接的 App Server profile 为准 |
| 项目 | `<项目>/.ash/config.toml` | 项目声明，可随仓库保存；发现与执行仍受目录权限控制 |
| 脚本 | 建议 `<项目>/.ash/hooks/` | 存放程序文件；TOML 显式引用，目录本身不自动注册 Hook |

本地连接通过系统文本编辑器打开 TOML；首次编辑项目配置时创建空文件，已有文件保持原样。
远程连接显示远程来源路径，通过远程主机编辑或让 Ash 配置，不能把远程路径交给本地编辑器。
保存后按 `r` 刷新列表。用户配置变化也会触发打开页面的刷新；正在搜索时 `r` 是搜索文字。
详情使用 `PageUp` / `PageDown` 翻页，长路径和参数自动换行。
`/` 搜索事件或 Hook，`Enter` 进入，`Esc` 逐级返回，关闭页面后恢复输入。

用户配置和项目配置均由共享后端解析。项目声明的发现需要会话目录同时拥有 `LoadConfig` 和
`DiscoverHooks`；未获准发现的项目配置不会进入列表。列表表示配置声明，不表示程序已经执行，
也不展示运行记录。通用作用域与配置提交规则见 [配置系统](../../docs/config.md)。

## 用户配置示例

把以下片段加入已有的用户 `config.toml`；不要替换其他配置或删除 `schemaVersion`。
本例在用户提交提示词时调用 Python 程序，初始状态为禁用。确认路径和脚本后可把
`enablement` 改为 `"enabled"`。

```toml
[hooks.hooks."user:hook:prompt-check"]
id = "user:hook:prompt-check"
event = "userPromptSubmit"
enablement = "disabled"

[hooks.hooks."user:hook:prompt-check".action]
type = "process"
program = "python3"
args = ["/absolute/path/to/prompt-check.py"]
```

程序从 stdin 读取 Ash JSON，stdout 返回决策。最小脚本如下：

```python
import json
import sys

request = json.load(sys.stdin)
print(json.dumps({"decision": "continue"}))
```

用户 Hook ID 使用 `user:hook:<名称>`，TOML 表键与 `id` 必须相同。项目声明使用后端为目录
确定的 `dir:<目录身份>:hook:<名称>`；不要把用户 ID 直接复制到项目配置，也不要在文件中自行
选择目录身份。`hook/list` 返回每个已发现来源的 `namespace` 和配置路径，助手应使用该来源身份。

需要限制工具时添加 matcher：

```toml
[hooks.hooks."user:hook:tool-check"]
id = "user:hook:tool-check"
event = "preToolUse"
enablement = "disabled"

[hooks.hooks."user:hook:tool-check".matcher]
toolNames = ["shell-command"]

[hooks.hooks."user:hook:tool-check".action]
type = "process"
program = "/absolute/path/to/tool-check"
args = []
```

`toolNames` 是精确名称列表，空列表匹配所有工具；只有支持工具匹配的事件可以设置非空列表。
同一事件可以配置多个 ID 不同的 Hook，按稳定 ID 顺序执行。禁用的 Hook 仍计入配置数量并在
详情标明状态。删除对应 TOML 表即可移除，修改 `enablement` 即可启停。

## 执行与生效

配置表达期望行为，不授予执行权限。运行时仍检查动作策略、目录执行能力和沙箱授权；
项目 TOML 不能给自己增加权限。TOML 编辑和助手编写配置本身不构成授权。

新配置只影响后续调用读取的快照，已经开始的执行保持原快照。无效 TOML、错误 ID 或不适用的
matcher 会被配置校验拒绝，查询不会把无效配置当成空列表。后台 Hook 遇到需要交互审批的动作
不会弹出审批并自行继续，详见 [权限与失败语义](docs/runtime.md#安全与失败语义)。

## 后端接口与修改入口

`hook/list` 接受可选 `sessionId`，返回用户来源以及会话获准发现的项目来源。每个来源包含
`namespace`、`configPath` 和完整声明。省略会话只返回用户来源；该接口不提交 Hook 配置变更、不执行
Hook，也不授予权限。

用户声明的程序化更新继续使用 `hook/upsert`、`hook/remove`、`hook/enablement/set`，携带
`commandId` 与 `expectedRevision`。TUI 浏览页只读，编辑入口交给 TOML 或助手。

| 责任 | 实现入口 |
| --- | --- |
| 事件名称及可匹配工具的事件 | [protocol](../protocol/src/hook.rs) |
| TOML、ID、声明校验 | [config](../config/src/hooks.rs) |
| 来源查询与配置命令 | [App Server](../app-server/src/server/extension_config_operations.rs) |
| 事件列表、详情与配置入口 | [Ash Code](../../code/tui/src/hooks.rs) |
| 桌面 Settings 与配置入口 | [Hooks Settings](../../app-ts/src/ash/workbench/contrib/hooks/browser/hooksSettingsContent.ts) |
| 执行、进程协议与运行记录 | [运行时说明](docs/runtime.md) |

定向验证：

```text
just check ash-tui
just test ash-tui hooks
just test ash-tui hooks --features in-process-tests
just test ash-app-server-protocol
just rust-warnings ash-tui
```
