---
description: Ash test reliability, completion contracts, targeted testing and command-line verification rules.
applyTo: "**"
---

# Testing Guidelines

Validation and test synchronization are part of the implementation, regardless of language or whether a test file is directly edited. Language-specific commands and conventions live in `rust-testing.instructions.md` and `typescript-testing.instructions.md`.

## 完成契约与测试辅助 API

- 动作发出不等于完成。每个异步操作必须等待属于本次动作的新 identity、业务完成事件或可验证的副作用；操作前记录基线，并在可能丢失事件时先建立监听。已有元素可见、旧计数仍满足条件、输入派发结束或两次 `requestAnimationFrame` 都不能单独证明业务完成。
- 共享 automation 动作负责自己的完成契约：明确操作目标，执行动作，等待相应结果后再返回；调用方不靠额外 sleep 或重复补断言弥补 helper 的提前返回。若 API 只负责发出动作，名称和契约必须明确，并提供独立等待方法，保留并发测试的控制权。
- 观察 helper 只读取和等待，不主动 focus、点击、发送输入或写入被测数据库来制造期望状态。动作方法使用明确的动作名称；fixture 初始化与被测操作分开，不用测试侧写入替代产品应产生的副作用。
- 等待必须有截止时间，并在失败时保留目标 identity、最后观察状态或相关事件等诊断信息。超时用于限制失败等待，不作为业务成功条件。

## 时间、并发与回归

- 时间逻辑使用受控 clock；并发顺序使用可控 gate、barrier 或事件。先断言 gate 释放或时钟推进前不得发生的行为，再推进并断言结果；不能用固定 sleep、扩大超时或重复运行碰运气证明顺序。
- 保留产品允许的真实并发、重复操作、取消和立即退出等回归场景。helper 的完成等待不能把本应重叠的操作串行化，也不能先等后台任务结束再测试立即退出，从而隐藏竞态。
- 缺陷修复必须有能够复现原问题的回归测试，优先验证修复前失败、修复后通过；已有测试能够复现时直接复用。若环境阻止复现或验证，说明阻塞条件及实际验证范围，不能把未观察到失败写成已完成回归验证。

## 确定性输出与隔离

- 仅对完成契约已经满足的确定性状态建立 snapshot，并审阅变化是否符合产品行为。TUI 的 raw ANSI 输出、历史屏幕内容或渲染帧只证明终端收到输出，不能代替业务就绪信号。
- JSON 输出需要规范化时，只递归规范化对象键的顺序；保留数组顺序、值、字符串内容及字段存在性，不能通过重排数组或删除内容掩盖行为变化。
- fixture 隔离 profile、workspace、环境变量、持久化数据和端口等共享状态；显式恢复测试修改的环境。进程、PTY、连接、监听器、timer 和临时目录由创建方负责关闭或清理，失败路径也必须执行，异步关闭要等待完成。

## 构建契约与外部失败

- 同时支持 Cargo 和 Bazel 的目标，依赖或构建配置变化必须直接验证两套构建契约，包括依赖 aliases、features、条件编译及必要的 test-only 配置；测试应检查实际清单或生成结果，并验证受影响的真实构建入口，不能只断言某个文件包含依赖名。
- 不以 skip、放宽断言、串行化原本并发的测试或无限重试掩盖实现与构建缺陷。确有平台限制时按实际适用条件限定测试，并报告未覆盖范围。
- 外部下载或服务的临时错误可以有限重试，必须限定可重试错误、尝试次数和单次等待，并保留最终失败原因；校验失败、无效输入、权限错误和其他永久错误立即失败。重试策略本身要覆盖临时失败后成功、重试耗尽和不可重试错误。

## 改动与配套内容同步

实现及其配套内容必须在同一次改动中更新，不能把测试通过当作同步工作已经完成。

| 改动 | 必须同步的内容与验证 |
| --- | --- |
| 新增或修改用户可见界面 | 更新对应行为验证；已有 snapshot 基线时同步更新并逐份审阅。替换界面时保留行为和状态覆盖，不能只删除旧基线。 |
| 修改 Agent 执行逻辑 | 列出受影响的主要逻辑与用户可见行为，新增或更新覆盖真实调用链的集成测试；复用现有测试设施，不以局部辅助函数测试代替流程验证。 |
| 修改配置类型或协议接口 | 同步调用方、校验、序列化测试和接口文档；更新该接口已有的 schema、生成类型及 fixtures。 |
| 修改依赖或编译期资源 | 同步所属项目的 lockfile 和受影响的构建、资源打包清单，并验证实际使用的构建入口。使用 Ash 现有工具，不引入其他仓库专属的锁文件或命令。 |
| 修改、重构、替换、移动或删除实现 | 修改前检索生产与测试调用点；同步迁移或删除模块导出、测试、测试辅助代码和文档。测试专用 helper 不进入主实现。 |

交付前检查本次测试和正常构建的 warning，处理由本次改动引入的 warning；不能通过 `allow(dead_code)`、伪造调用或新增仅为消除 warning 的测试来掩盖无用代码。构建退出码为零不代表验证完成；确实无法处理的 warning 必须说明原因和影响，不能宣称已全部完成。

## 验证选择

- 使用覆盖受影响行为的最小 check、test、build 或运行验证；测试通过不能代替正常构建通过。
- 修复失败后先重跑失败的测试或目标；只有变更范围或新证据要求时才扩大验证。
- 只有命令完整成功后才能报告通过。未运行、被既有失败阻塞或无法覆盖的平台必须明确说明。
- 未新增或修改测试时，交付中说明现有覆盖为什么足够；不要机械增加测试、复制实现断言或削弱断言。

## Learnings

* 修改或重构实现时，把实现、全部调用点、对应测试和测试辅助代码视为一个原子改动：修改前先检索引用，修改后同步迁移或删除，不能等测试失败才发现。不要在主实现中新增测试专用 helper。
* 行为或接口变化时同步更新测试，修复缺陷时补充能复现问题的回归测试，已有覆盖则复用。纯编译问题必须验证实际失败的非测试构建，不能用单测通过代替正常构建通过。

## 参考实现

以下固定版本用于说明设计依据；执行要求以上述本仓库规范为准，不随上游变更自动变化。

- VS Code：[automation 的动作与等待边界](https://github.com/microsoft/vscode/blob/42b7c2874a6ab1aefe0f3bd7e0338bca5d68f3b9/test/automation/src/code.ts#L165-L180)、[编辑器动作](https://github.com/microsoft/vscode/blob/42b7c2874a6ab1aefe0f3bd7e0338bca5d68f3b9/test/automation/src/editors.ts#L43-L67)、[应用就绪等待](https://github.com/microsoft/vscode/blob/42b7c2874a6ab1aefe0f3bd7e0338bca5d68f3b9/test/automation/src/application.ts#L133-L138)。
- Codex：[ThreadIdle 业务完成信号](https://github.com/openai/codex/blob/d91294c39edb93d204926b33f21310dc968edc34/codex-rs/core/tests/common/lib.rs#L337-L368)、[受控流式时序](https://github.com/openai/codex/blob/d91294c39edb93d204926b33f21310dc968edc34/codex-rs/core/tests/common/streaming_sse.rs#L473-L522)、[TUI focus 场景](https://github.com/openai/codex/blob/d91294c39edb93d204926b33f21310dc968edc34/codex-rs/tui/tests/suite/focus_palette.rs#L464-L520)、[JSON 对象规范化](https://github.com/openai/codex/blob/d91294c39edb93d204926b33f21310dc968edc34/codex-rs/app-server-protocol/src/export.rs#L1599-L1606)。
