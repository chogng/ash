# GitHub 消费者契约

本 crate 拥有 GitHub 领域类型、结构化错误、账号／grant 消费者契约，以及 `GitHub` 和问题报告消费者代理。它不执行 GitHub HTTP，不持有 OAuth、token 存储或刷新任务。

- [`extensions/github`](../../extensions/github/README.md) 是独立 Rust API Provider，拥有仓库、Issue、PR、评审、通知、托管设置和问题报告实现。
- [`extensions/github-authentication`](../../extensions/github-authentication/README.md) 拥有认证会话；所有 API 调用使用它验证过的不可变授权引用。
- `provider.rs` 定义 `github.api.v1` 的 typed 请求／响应与 `GitHubProvider`；`GitHub` 代理保留现有方法及取消语义，异步消费者在阻塞 worker 上调用选定 Provider。

App Server 只依赖本契约，产品组合通过公共扩展 SDK、监管器与安装目录中的 executable 接入 API Provider。默认 TUI 不加载 GitHub；缺失或停用的 Provider 不回退到另一套实现。详细功能与生命周期见扩展 README。
