# Chat 输入历史接入

**状态：已接入 TypeScript Chat 的提交、回查、搜索和清空链路。**

## 归属与调用链

- `ChatInputPart` 只在用户主动提交时记录文本；历史回填、会话恢复、分支和重放不追加记录。输入失败时沿用现有草稿恢复。
- [`chatWidgetHistoryService.ts`](../src/ash/workbench/contrib/chat/common/widget/chatWidgetHistoryService.ts) 拥有每个输入区的临时分页导航。原草稿包括文本、光标、附件引用和 Skill 版本绑定；持久记录仅保存文本。
- [`messageHistory.ts`](../src/ash/platform/messageHistory/common/messageHistory.ts) 定义异步 append/read/clear 领域契约，Browser adapter 通过生成方法表与解码器调用 App Server；UI 不消费 transport DTO。
- `messageHistory/append`、`messageHistory/read`、`messageHistory/clear` 复用 [`ash-message-history`](../crates/message-history/README.md) 和 [`SqliteMessageHistory`](../crates/state/src/message_history.rs)，打开既有本机 Profile 数据库，沿用保留策略、字节限制和稳定旧页游标。没有第二套前端存储。
- Workbench 与 Agents 的 New Chat / Cowork 使用相同服务。SSH gateway 明确保留输入历史的本机归属，记录的 Thread 来源仅作备注；扩展客户端不能访问该私有历史。

## 交互

- 上、下方向键进入历史回查；普通文本编辑和补全优先保留原有行为。Stanza 按首末可视行判断边界，textarea 后备实现按文本起止位置判断。
- Ctrl+R 打开后端搜索，旧记录通过“加载更多输入”分页。Enter/点击结果只回填文本，不发送；Escape 取消搜索或恢复回查前的草稿。
- 继续编辑或修改附件会结束旧导航。迟到查询、旧搜索结果及释放后的结果不会覆盖输入；输入区关闭会释放搜索控件。
- 命令面板 `workbench.action.chat.clearInputHistory` 清空 Profile 输入历史。
- 连接关闭、存储失败与能力不可用会显示本地化错误，写入不自动重试；历史失败不阻塞已有提交动作。

## 验证

- 前端导航单元测试覆盖分页、原草稿身份、过期读取、进行中和排队操作的释放，以及搜索确认不追加记录。共享输入回归测试合计 21 项通过。
- 5 项 Chromium integration 覆盖光标、附件、Skill 原版本恢复，分页，中英文搜索、确认不发送、取消、搜索竞态、释放及查询期间继续编辑。
- 真实 Browser / Electron App Server 共 4 项 smoke 覆盖实际提交、窗口重开后读取、搜索确认不发送和清空命令，以及侧栏和 Agents 共享历史但保持草稿独立；Electron 多窗口遵循既有草稿移交流程。
- 3 项 Rust 测试使用实际 SQLite 验证跨连接复用、数据库重新打开后的持久化、字面搜索与稳定游标、清空、权限与参数边界；gateway 测试验证远程 Thread 来源仍使用本机 Profile。
- 协议生成、126 项协议测试、协议及 Renderer 类型检查、Web/Electron 构建、Rust warnings 与依赖检查通过。

窗口重开测试复用同一个 Profile；SQLite 重开测试验证后端持久化。尚未单独跑真实 SSH 主机或在 UI 测试途中强杀 daemon 的场景。
