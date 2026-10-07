# `ash-skills-extension`

跨 crate 的 Skill 语义和分阶段演进由 [`docs/skills.md`](../../../docs/skills.md) 维护；底层目录、
文件和 catalog 契约由 [`ash-skills`](../../skills/README.md) 维护。

`ash-skills-extension` 拥有 `ash-skills` 之上的 Agent 运行时编排：组合 built-in、user、当前
Directory、Plugin 和 Marketplace 动态 source，应用启用状态与兼容性策略，在 Turn 提交前冻结
显式选择和仅限 verified built-in 的 metadata 自动选择，在模型调用安全点重新
加载 exact content，并通过 `ash-extension-api` 贡献有界元数据目录、exact Skill instructions
以及单个只读 `skills-read` 模型工具。

## 所有权

| Symbol                            | 当前职责                                                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `SkillRuntime`                    | catalog generation、source composition、exact activation 和 watcher lifecycle                              |
| `SkillActivationContributor` 实现 | 先冻结显式 `UserInput::Skill`，再对剩余 verified built-in 做唯一高置信 metadata 选择                       |
| `TurnInputContributor` 实现       | 输出 metadata-only `catalog_prompt` 和 exact frozen activation fragment                                    |
| `SkillToolContributor`            | 注册 `SkillReadTool`，不依赖 App Server                                                                    |
| `SkillReadTool`                   | 解析 exact `source + name`，通过 tagged target 读取完整说明或 digest-pinned package-relative text resource |
| `SkillRuntimeEventSink`           | public catalog generation 改变后通知安装它的 host                                                          |

`ash-skills` 仍是底层文件和 catalog authority。Core 只调用通用 extension lifecycle contract。
App Server 可以提供配置、事件 adapter 和 list DTO，但不得选择、激活、加载、缓存或渲染 Skill
instructions。

Skill watcher 仅递归监听 catalog roots，包括尚未创建的 Directory `.ash/skills`。缺失目录的
祖先监听及逐级移近由共享 `ash-file-watcher` 负责；工作区和 `.ash` 其他内容不属于 Skill
递归扫描范围。关闭时发送停止信号并回收监听线程，服务退出完成后才能释放 profile 的 endpoint。

真实调用路径：

```text
install
  -> SkillActivationContributor::resolve
       -> explicit SkillRef(s)
       -> bounded metadata selector (at most one automatic SkillRef)
       -> load exact SKILL.md and freeze digest/generation/reason
  -> TurnInputContributor::contribute
       -> catalog_prompt (metadata only, at most 8 KiB)
  -> ReadOnlyToolContributor::contribute
       -> SkillReadTool::execute
            -> target = instructions
                 -> SkillRuntime::activate_model_selected
                      -> SkillCatalog::activate
            -> target = resource
                 -> SkillRuntime::read_model_resource
                      -> SkillCatalog::read_resource
```

手动、host automatic 和模型选择共用 catalog validation 与 exact file loading，但 durable shape
不同。手动与 automatic 选择在 `TurnAccepted` 中冻结并作为 `PromptFragment` 贡献；automatic
selector 只读有界 Turn 文本和 metadata，只允许 `BuiltInVerified` 且歧义时不选。模型选择发生在
Tool loop 中，成功的 `skills-read` result 成为下一次 invocation 的 durable model context，不被
伪装为 pre-Turn activation。

当前模型侧 resource read 只接受 UTF-8 text、每次一个文件，上限 256 KiB。底层 resource contract
保留 binary bytes，但 MIME/artifact materialization 尚未接通；script execution 仍是普通 Tool
operation。catalog prompt 固定上限 8 KiB，Core 继续通过普通 BestEffort context budget 计算它。
