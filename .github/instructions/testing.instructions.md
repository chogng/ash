---
description: Ash targeted testing and command-line verification rules.
applyTo: "**"
---

# Testing Guidelines

Validation and test synchronization are part of the implementation, regardless of language or whether a test file is directly edited. Rust commands and conventions live in [Rust development](../../.agents/skills/rust-development/SKILL.md#validation); TypeScript rules live in [`typescript-testing.instructions.md`](typescript-testing.instructions.md).

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
