# GitHub

Git 与 GitHub 分别拥有独立能力。`ash-git` 负责本地仓库、提交、分支、差异及 fetch/pull/push，支持不同托管平台；本 crate 负责 GitHub 账号授权与 Issue、PR 等 API 操作。Git 的 SSH/HTTPS 凭据不等同于 GitHub API 授权，两者没有相互依赖。

GitHub 是 Ash 内置的后端领域能力。Workbench 界面通过领域接口与 App Server 使用它，基础功能不依赖 Extension 的安装或激活。扩展可以调用产品公开的能力；账户授权、GitHub 执行与共享业务状态由后端负责。

- 通过 `ash-http-client` 的 REST / GraphQL 请求读写 Issue、评论、标签、负责人和 PR，共用产品的代理、TLS 和取消能力。不打包或依赖 `gh`，也不读取 GitHub CLI 登录配置或环境变量 token。
- 保留 GitHub 参数与返回值校验，不拥有 Agent、Thread、工作目录或模型调用。
- 仓库操作返回结构化 `Error`，区分输入、认证、权限、限流、资源缺失、冲突、不可用、超时、取消、响应格式、执行失败和提交结果不确定。分类依据 HTTP 状态、响应头与 GraphQL 机器可读类型；远端错误正文和凭据供应商诊断不进入公开错误。
- 不维护 Issue Workflow、assignment、领取租约、执行阶段或交付状态机。
- Issue 浏览缓存由 `ash-state` 维护；执行通过通用 Session/Agent API，Agent 使用获准的 Plugin 工具处理外部操作。

`GitHub::for_account` 接收共享 HTTP 客户端和请求取消令牌，捕获供应商验证过的主机、账号与授权身份。每次请求重新核对授权，并通过 Authorization 头发送对应主机的 token。登出、重新登录或 token 替换后，旧对象不能发起请求，读取结果也会被丢弃。已经确认的写入结果仍表示已完成的修改。当前账号供应商仅支持 GitHub.com，其他主机不得使用其凭据；登录由 `ash-login` 调用本 crate 的授权实现，密钥复用 `ash-secrets`。

`github/*` RPC 不要求本地 checkout，直接接收明确的仓库身份。App Server 为同一托管仓库协调读写，写入独占，读取共享；每个请求携带连接内唯一的 `operationId`，通过 `github/cancel` 取消。HTTP 尝试最多 30 秒，响应最多 8 MiB；分页接口显式返回下一页，PR 文件返回是否触及 3000 文件上限。写入只发送一次，响应丢失、服务端错误或取消后无法确认结果时返回 `GitHubSubmissionUncertain`，调用方应先查看远端结果。

已接入的接口包括仓库信息、Issue 列表/详情/创建/修改、Issue 与 PR 的讨论评论、PR 列表/详情/创建/修改/文件/评审/合并/自动合并、提交详情及检查状态、标签和可分配负责人。`github/commit/read` 接收 7–40 位十六进制 SHA，校验返回的完整 SHA 与请求一致，不接受可变分支名。修改 Issue 可以调整状态、标签和负责人。PR 评审与合并携带用户审阅的 commit；合并使用 REST `sha`，自动合并使用 GraphQL `expectedHeadOid` 由 GitHub 原子校验。逐行评审线程、通知、多人账号选择及 Enterprise 登录尚未实现。

前端 `platform/github/common/githubService.ts` 定义 `IGitHubService` 和领域类型，`browser/appServerGitHubService.ts` 封装生成的协议、取消与错误分类。Web 和 Electron 都从现有 Renderer Host 获得该服务，Workbench 注册同一个实例；管理界面独立开发，产品调用不经过 `workbench/api`。

`workbench/contrib/github/browser/` 为常规 Workbench 和 Sessions 的聊天 Markdown 注册 GitHub.com 仓库、Issue、PR 和提交链接详情。卡片使用同一领域接口读取数据；PR 检查在打开卡片时按页加载，源分支使用返回的 `headRepository` 身份跳转，源仓库删除后只显示分支名。链接共享 Issue、PR 与提交读取，移除最后一个引用或切换账号时释放缓存并取消请求。Enter 打开原链接，F2 进入卡片，Tab 遍历链接，Escape 返回原链接；Accessible View 可读取完整描述。

App Server 在 `issue/list` 与 `issue/read` 中用 Git origin 关联 GitHub 仓库，然后使用同一 GitHub 账号供应商操作 Issue。当前只支持 GitHub.com origin；其他托管平台返回目标不支持的操作错误，不提示 GitHub 登录。读取缓存也要求当前授权仍有效；缓存按账号和授权隔离，清理一个授权的页面不影响其他授权。旧的无授权缓存键不会被新查询读取。缺少配置和需要登录分别返回账户不可用与需要认证的结构化错误。

仓库请求失败保留 GitHub 错误分类：认证失败返回 `AccountAuthenticationRequired`，输入错误返回 `InvalidParams`，其他分类使用 `GitHub*` 错误。工作区关联、配置与缓存失败仍属于 `IssueOperationFailed`；产品报告器保留自己的提交结果与错误契约。

产品问题报告使用 `GitHubIssueReporter` 和共享 HTTP 客户端。报告仓库由产品配置的 `reportIssueUrl` 指定，只支持 GitHub.com；不会从当前工作区推断目标。`issueReporter/read` 提供目标与系统诊断，`issueReporter/search` 匿名搜索该仓库的相似问题，搜索取消使用连接内的 `operationId` 并等待原请求结束。`issueReporter/submit` 使用 Ash 当前授权直接创建 Issue，令牌不进入协议。创建只发送一次；响应丢失或服务端错误返回“提交结果不确定”，调用方保留草稿并提示先查看仓库。GitHub App 必须获得目标仓库的 Issues 写权限，配置步骤见 [授权服务说明](../../services/github-auth/README.md)。
