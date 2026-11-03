# 模型如何获知沙箱权限

审批决定什么时候需要人确认，沙箱决定命令实际能读写什么、能访问哪些网络目标。模型知道这些边界，就能少做无效尝试。权限仍由执行端检查。

## 源码对照

核对使用本地 Codex `3026a8e54e`、Claude Code 镜像 `3a85455` 和 Ash `b2293ba654`。Claude Code 镜像的 Git 远端是第三方。本机安装版报告 `2.1.285`，尚未验证它与该镜像逐行一致。下文的 Claude Code 实现细节以该镜像为准。

### Codex 把权限写进开发者上下文

`codex-rs/core/src/session/world_state.rs` 根据当前环境和权限配置构造 `PermissionsState`。配置 `include_permissions_instructions` 默认开启，模型因此能在规划时知道当前沙箱和审批要求。

`codex-rs/core/src/context/world_state/permissions.rs` 的 `render_diff` 比较新旧状态。说明和已批准的命令前缀都没变时，不追加内容。只新增批准前缀时，只追加新增项。权限说明发生变化时，发送当前说明。相邻的 `permissions_tests.rs` 和快照覆盖了批准前缀后不重发整段说明的场景。这是对话上下文的追加规则，和 API 请求是否携带历史、历史是否命中缓存是两回事。

### Claude Code 把规则写进 Bash 工具描述

`src/tools/BashTool/prompt.ts` 的 `getSimpleSandboxSection` 在沙箱启用时读取 SandboxManager 的文件读写、网络主机和 Unix socket 等规则，并说明是否允许尝试在沙箱外重跑。它先去重，再将用户专属临时目录写成 `$TMPDIR`，以减少工具描述里的重复内容和缓存变化。

`src/tools/BashTool/BashTool.tsx` 的 `prompt()` 返回包含这段说明的 Bash 提示。`src/utils/api.ts` 的 `toolToAPISchema` 把它写入 API 工具的 `description`，并缓存会话内的基础工具描述。因此，模型可以在首次调用 Bash 前看到具体规则。缓存代码也意味着不能假设每次设置变更都会立即重生成模型看到的描述。

执行时，`src/utils/Shell.ts` 调用 `SandboxManager.wrapWithSandbox`。Bash 工具还会用 `annotateStderrWithSandboxFailures` 把检测到的沙箱违规附到命令结果中。Anthropic 的[沙箱文档](https://code.claude.com/docs/en/sandboxing#the-unsandboxed-retry-escape-hatch)也确认，网络访问被阻止时，模型能从命令结果看到被拒绝的主机。

### VS Code 也通过终端工具描述提前告知模型

本地 VS Code `0dc300b2c77` 的 `src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/tools/runInTerminalTool.ts` 读取当前终端沙箱选项，通过 `createSandboxLines` 把文件系统边界、网络允许和拒绝的域名、可用的申请方式写入 `modelDescription`。例如，启用按次网络申请时，工具会告诉模型明显需要联网的命令可以提前申请，并保留文件系统隔离。

Agent Host 的 Copilot 自定义 shell 在 `src/vs/platform/agentHost/node/copilot/copilotShellTools.ts` 中也根据沙箱状态和网络规则生成工具描述。这两条路径都在调用前给模型信息，和 Claude Code 镜像里的 Bash 工具描述属于同一种做法。这里核对的是 VS Code 自己生成描述的工具路径，SDK 内部工具的提示词需要分别核实。

### Ash 在命令工具描述中提供沙箱边界

[上下文组装](../crates/core/src/context/instructions.rs)把通用工具权限说明和本轮审批模式放进系统指令。[权限模板](../crates/prompts/templates/permissions/actions.md)说明宿主按工具调用检查权限。这条组装路径的输入只有审批模式，模型从这里得不到当前命令的可写目录和网络边界。

[权限配置](../crates/config/src/permissions.rs)负责解析权限档案。[本地工具执行](../crates/app-server/src/local_tools.rs)会构造实际的沙箱策略，例如在有网络目标规则时使用受管代理。仅拿前端设置里的网络开关来描述模型能做什么，会漏掉这种差异。

`shell-command` 和 `shell-session` 从执行端已解析的同一份基础策略生成工具描述，说明文件写入边界以及网络是阻止、允许还是经代理检查。临时授权继续通过 `request_permissions` 的工具结果返回具体权限及作用域。命令执行时仍会检查该次调用适用的授权和限制。

## Ash 可以怎么做

1. **发送前显示当前执行环境的权限。** 输入栏从权限拥有方读取当前环境的审批模式、文件访问和网络状态。用户可以据此决定是否先调整设置。
2. **模型开始规划时，只给能改变行动的摘要。** 例如「命令可写授权目录，网络经代理检查目标」。由拥有生效策略的后端产生摘要，让界面和模型使用同一份事实。
3. **权限没变就复用说明。** 新增一项授权时，提供相关变化和作用域即可。工具受阻时，返回具体原因，例如被拒绝的主机或目录。后续执行始终以执行端当时适用的策略为准。

Codex 的状态差量适合 Ash 的跨轮上下文。Claude Code 的工具描述适合表达只对 Bash 生效的限制。Ash 可以结合这两点，把通用审批说明放在会话上下文，把具体命令限制限定在对应工具或执行环境。
