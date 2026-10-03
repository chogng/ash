# Guardian environment

为独立权限审核准备按项目绑定的背景资料：扫描有限的项目来源，生成可审阅草稿，保存用户确认的
事实和目标归属。读取与审核前跟随已选项目来源；来源变化后，旧描述停止用于审核，后端保存
未确认的新观察。`/init` 生成的 `ASH.md` 和共享 `AGENTS.md` 作为不可信项目说明读取。

`guardian-environment` 拥有资料及其确认状态；`guardian-context` 组装审核上下文并限制预算；
`guardian-reviewer` 调用审核模型并校验结论。环境资料不能创建允许规则或授予操作权限。
State 分别保存用户描述和当前观察，只有变化才递增版本；App Server 拥有读取范围、整理模型调用
和产品协议。模型不能维护授权。Sessions 与 TUI 使用 `/guardian setup` 管理资料。

近期命令由现有 Thread 存储提供，在同一授权目录内跨会话读取，默认 50 个会话、每会话 200 条命令，不限定天数；范围可由用户调整。
本领域提取命令名、主机和云存储桶线索，按不同会话数和频次聚合，每类最多 20 条事实，保留来源样本和覆盖量；普通参数、用户消息和输出不进入资料。
历史事实不能确认目标归属；扫描和保存不会授予权限，也不会改写 memories 或开启其读取、写入。

接口与使用流程见 [准备项目审核环境](../../docs/guardian.md#准备项目审核环境)。
验证使用 `just test ash-guardian-environment`、`just check ash-guardian-environment` 和
`just rust-warnings ash-guardian-environment`。
