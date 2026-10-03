# Guardian environment

为独立权限审核准备按项目绑定的背景资料：扫描有限的项目来源，生成可审阅草稿，保存用户确认的
事实和目标归属，并检查来源版本。来源变化后，旧资料停止用于审核。

`guardian-environment` 拥有资料及其确认状态；`guardian-context` 组装审核上下文并限制预算；
`guardian-reviewer` 调用审核模型并校验结论。环境资料不能创建允许规则或授予操作权限。
State 拥有持久化，App Server 拥有读取范围、整理模型调用和产品协议。

接口与使用流程见 [准备项目审核环境](../../docs/guardian.md#准备项目审核环境)。
验证使用 `just test ash-guardian-environment`、`just check ash-guardian-environment` 和
`just rust-warnings ash-guardian-environment`。
