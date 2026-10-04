# GitHub

Git 与 GitHub 分别拥有独立能力。`ash-git` 负责本地仓库、提交、分支、差异及 fetch/pull/push，支持不同托管平台；本 crate 负责 GitHub 账号授权与 Issue、PR 等 API 操作。Git 的 SSH/HTTPS 凭据不等同于 GitHub API 授权，两者没有相互依赖。

- 通过有界 GitHub CLI 请求读写 GitHub 对象，包括 Issue、评论、标签、负责人和 PR。CLI 只作为执行通道；每次操作明确绑定 Ash 账号的授权，不读取 `gh` 自己登录的账号或继承的 GitHub token。
- 保留 GitHub 参数与返回值校验，不拥有 Agent、Thread、工作目录或模型调用。
- 不维护 Issue Workflow、assignment、领取租约、执行阶段或交付状态机。
- Issue 浏览缓存由 `ash-state` 维护；执行通过通用 Session/Agent API，Agent 使用获准的 Plugin 工具处理外部操作。

`GitHub::for_account` 捕获供应商验证过的主机、账号与授权身份。每次请求重新核对该授权，向子进程传入对应主机的 token，并在返回结果前再次核对；登出、重新登录或 token 替换后，旧对象不能继续执行或提交结果。当前账号供应商仅支持 GitHub.com，其他主机不得使用其凭据。

App Server 在 `issue/list` 与 `issue/read` 中用 Git origin 关联 GitHub 仓库，然后使用同一 GitHub 账号供应商操作 Issue。当前只支持 GitHub.com origin；其他托管平台返回目标不支持的操作错误，不提示 GitHub 登录。读取缓存也要求当前授权仍有效；缓存按账号和授权隔离，清理一个授权的页面不影响其他授权。旧的无授权缓存键不会被新查询读取。缺少配置和需要登录分别返回账户不可用与需要认证的结构化错误。

产品问题报告使用 `GitHubIssueReporter` 和共享 HTTP 客户端。报告仓库由产品配置的 `reportIssueUrl` 指定，只支持 GitHub.com；不会从当前工作区推断目标。`issueReporter/read` 提供目标与系统诊断，`issueReporter/search` 匿名搜索该仓库的相似问题，搜索取消使用连接内的 `operationId` 并等待原请求结束。`issueReporter/submit` 使用 Ash 当前授权直接创建 Issue，令牌不进入协议。创建只发送一次；响应丢失或服务端错误返回“提交结果不确定”，调用方保留草稿并提示先查看仓库。GitHub App 必须获得目标仓库的 Issues 写权限，配置步骤见 [授权服务说明](../../services/github-auth/README.md)。
