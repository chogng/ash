# `ash-prompts`

`ash-prompts` 隔离共享提示词资产与渲染依赖，供根 Agent、子 Agent 和共享流程使用。

- `AGENT_INSTRUCTIONS`：所有 Agent 的共同工作与报告规则。
- `permissions_instructions`：工具授权说明与当前 Turn 的三种批准模式。
- `COMPACTION_PROMPT`、`checkpoint_prompt`：生成摘要，以及压缩后的续接说明和来源边界。
- `review_target_prompt`：明确本次审查目标；审查职责与输出规则归 [reviewer 角色](../agent-roles/assets/reviewer.md)。
- `review_exit_prompt`、`TURN_INTERRUPTED_PROMPT`：审查完成、中断、失败及普通 Turn 中断后的续接说明。
- `PromptArtifact`、`RenderedPrompt`：正文、来源、版本与渲染结果；摘要大小接口供 Core 使用相同编码计算预算。

Core 按实际运行状态选择模板、分配上下文预算并组装请求。角色正文归 `agent-roles`，模型指导归 `models-manager`；本 crate 不读取配置、访问 Git、判断授权或调用模型。

权限说明按 Turn 已保存的 `approval_mode` 选择。Ash 的沙箱和授权按每次工具调用判定，因此使用自身的动作授权模板。不会注入 Codex 的 `sandbox_permissions`、`prefix_rule` 等参数，也不会把批准旁路说明为全盘访问。

审查结果继续保留在原 Assistant 消息中；结束模板只说明实际状态。摘要正文与 ID 做标记转义，来源摘要保持可追溯；Core 在接受压缩结果和规划后续请求时计入编码后的正文、续接说明和包装开销。

Codex `prompts` 的逐项参考、实时语音差异、实际调用位置与维护规则见 [共享模板对应关系](../docs/agent-instructions.md#共享模板与-codex-的对应关系)。共享库中的模板按场景使用，不会全部注入每个请求。

验证：`just test ash-prompts`、`just check ash-prompts`；真实上下文组装与恢复由 `just test ash-core` 覆盖。编译资源由 `BUILD.bazel` 的 `templates/**` 清单维护。
