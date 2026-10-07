# `ash-agent-graph-store`

- 定义长期 Agent 身份、Agent 与 Thread 绑定的读取契约。
- 区分身份绑定、委托、fork、rewind 和执行替换关系。
- 提供稳定排序的 Agent 分支与委托后代查询，不加载对话历史。
- 绑定随 Thread 创建原子提交；SQLite 实现属于 `ash-state`。
- 目标 Team 成员可在首次 Thread 前创建，因此身份记录将支持独立原子创建；当前实现仍在首次 Thread 创建时写入 Agent 记录。契约见 [Agent Team](../docs/agent-teams.md)。
- 不拥有执行状态、上下文、消息、权限或云端认证。
- 消息恢复关系仍属于同一 Agent；消息内容和文件恢复由 Core 与工作目录能力负责。
