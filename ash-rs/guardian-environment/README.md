# Guardian environment

为独立权限审核准备按项目绑定的背景资料：扫描有限的项目来源，生成可审阅草稿，保存用户确认的
事实和目标归属。读取与审核前跟随已选项目来源；来源变化后，旧描述停止用于审核，后端保存
未确认的新观察。`/init` 生成的 `ASH.md` 和共享 `AGENTS.md` 作为不可信项目说明读取。

`guardian-environment` 拥有资料及其确认状态；`guardian-context` 组装审核上下文并限制预算；
`guardian-reviewer` 调用审核模型并校验结论。环境资料不能创建允许规则或授予操作权限。
State 分别保存用户描述和当前观察，只有变化才递增版本；App Server 拥有读取范围、整理模型调用
和产品协议。模型不能维护授权。Sessions 与 TUI 使用 `/guardian setup` 管理资料。

接口与使用流程见 [准备项目审核环境](../../docs/guardian.md#准备项目审核环境)。
验证使用 `just test ash-guardian-environment`、`just check ash-guardian-environment` 和
`just rust-warnings ash-guardian-environment`。
