# Guardian context

- 将宿主提供的确定历史范围转换为带来源与信任类别的审核证据。
- 保留用户指令、Agent 发言和工具记录的顺序；委托任务不代表用户授权。
- 根据调用方提供的实际序列化大小执行整体字节与 token 估算预算。
- 超预算时移除较早的可选观察并记录遗漏数；用户授权、委托和已准备动作保持完整。
- 不读存储、不调用模型、不授予权限、不保存第二份会话历史。
- Core 负责历史恢复与来源确认，reviewer 负责审核协议与模型请求，action-policy 负责授权裁决。
- 验证：`just test ash-guardian-context`、`just check ash-guardian-context`、`just rust-warnings ash-guardian-context`。
