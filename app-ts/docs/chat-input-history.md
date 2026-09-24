# Chat 输入历史接入

**状态：待实现。TypeScript Chat 尚未接入持久输入历史。** TUI 和 Rust 桌面已经接入共享能力，不代表 TypeScript Chat 已完成。

## 已有基础

- [`ash-message-history`](../../ash-rs/message-history/README.md) 已提供输入记录、分页搜索、清理、保留策略和后台读写。
- [`SqliteMessageHistory`](../../ash-rs/state/src/message_history.rs) 已实现本机 Profile 的 SQLite 存储。
- TypeScript 输入框入口为 [`chatInputPart.ts`](../src/ash/workbench/contrib/chat/browser/input/chatInputPart.ts) 和 [`chatInputEditor.ts`](../src/ash/workbench/contrib/chat/browser/input/chatInputEditor.ts)。

## 待办

- [ ] 确认并实现访问本机 Profile 输入历史的协议通道、前端领域接口和适配器，复用现有 Rust 存储；连接远程执行环境时仍使用本机输入历史。
- [ ] 在用户主动提交文本时追加记录；加载会话、恢复、分支和重放不追加记录。
- [ ] 接入上下键回查、Ctrl+R 搜索和旧记录分页；搜索确认只把结果放回编辑器，发送由用户再次提交触发。
- [ ] 取消回查或搜索时恢复原草稿、光标和附件/Skill 绑定；持久输入记录仍只保存文本。
- [ ] 处理过期搜索结果、连接关闭、窗口释放和存储错误，保留输入框各自的导航状态。
- [ ] 用 Playwright 验证 Web/Electron 输入交互，并覆盖重启后回查、跨会话复用、多窗口、远程连接时的本机归属，以及搜索确认不会误发送。

## 完成条件

TypeScript Chat 的实际提交、回查和搜索调用链接通，相关构建与上述测试通过后，才能将本项标为完成。共享 Rust crate、TUI 或 Rust 桌面的测试不能代替 TypeScript Chat 的验收。
