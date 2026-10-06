# GitHub

Git 与 GitHub 分别拥有独立能力。`ash-git` 负责本地仓库、提交、分支、差异及 fetch/pull/push，支持不同托管平台；本 crate 负责 GitHub 账号授权与 Issue、PR 等 API 操作。Git 的 SSH/HTTPS 凭据不等同于 GitHub API 授权，两者没有相互依赖。

GitHub 是 Ash 内置的后端领域能力。Workbench 界面通过领域接口与 App Server 使用它，基础功能不依赖 Extension 的安装或激活。扩展可以调用产品公开的能力；账户授权、GitHub 执行与共享业务状态由后端负责。

- 通过 `ash-http-client` 的 REST / GraphQL 请求读写 Issue、评论、标签、负责人和 PR，共用产品的代理、TLS 和取消能力。不打包或依赖 `gh`，也不读取 GitHub CLI 登录配置或环境变量 token。
- 保留 GitHub 参数与返回值校验，不拥有 Agent、Thread、工作目录或模型调用。
- 仓库操作返回结构化 `Error`，区分输入、认证、权限、限流、资源缺失、冲突、不可用、超时、取消、响应格式、执行失败和提交结果不确定。分类依据 HTTP 状态、响应头与 GraphQL 机器可读类型；远端错误正文和凭据供应商诊断不进入公开错误。
- 不维护 Issue Workflow、assignment、领取租约、执行阶段或交付状态机。
- Issue 浏览缓存由 `ash-state` 维护；执行通过通用 Session/Agent API，Agent 使用获准的 Plugin 工具处理外部操作。

`GitHub::for_selected_account` 接收明确账号、共享 HTTP 客户端和请求取消令牌，捕获供应商验证过的主机、账号与授权身份。每次请求重新核对授权，并通过 Authorization 头发送对应主机的 token。登出、重新登录或 token 替换后，旧对象不能发起请求，读取结果也会被丢弃。已经确认的写入结果仍表示已完成的修改。GitHub.com 与 Enterprise Server 的同名账号分别保存，主机不匹配时不会发送凭据；登录由 `ash-login` 调用本 crate 的授权实现，密钥复用 `ash-secrets`。浏览器登录使用配置的 GitHub App 或 OAuth App；个人访问令牌连接不要求浏览器授权服务配置，通过目标主机的 `/user` 验证账号后保存。

账号目录把主账号排在首位。连接 GitHub.com 账号会更新主账号；连接 Enterprise 不替换已有的 GitHub.com 主账号。未提供账号的消费者通过 `GitHub::for_account` 使用主账号；管理界面选择账号仅影响当前窗口，每个仓库请求携带该账号。按账号登出只移除对应授权，提供方登出移除其全部授权。旧单账号密钥在第一次读取时迁入账号目录并删除。

`github/*` RPC 不要求本地 checkout，直接接收明确的仓库身份。App Server 为同一托管仓库协调读写，写入独占，读取共享；每个请求携带连接内唯一的 `operationId`，通过 `github/cancel` 取消。HTTP 尝试最多 30 秒，响应最多 8 MiB；分页接口显式返回下一页，PR 文件返回是否触及 3000 文件上限。写入只发送一次，响应丢失、服务端错误或取消后无法确认结果时返回 `GitHubSubmissionUncertain`，调用方应先查看远端结果。

已接入的接口包括仓库信息、Issue 列表/详情/创建/修改、Issue 与 PR 的讨论评论、PR 列表/详情/创建/修改/文件/评审/合并/自动合并、逐行评审线程及回复与解决状态、提交详情及检查状态、标签和可分配负责人。`github/commit/read` 接收 7–40 位十六进制 SHA，校验返回的完整 SHA 与请求一致，不接受可变分支名。修改 Issue 可以调整状态、标签和负责人。PR 评审与合并携带用户审阅的 commit；评审提交前检查当前 head，评论绑定该 commit；合并使用 REST `sha`，自动合并使用 GraphQL `expectedHeadOid` 由 GitHub 原子校验。

`github/pullRequest/diff` 返回指定 head 与目标分支的共同祖先及文件列表，读取前后检查 PR head 和目标分支提交未变。`github/file/read` 只按完整提交 SHA 读取文件；超过 1 MiB 的内容和二进制内容返回明确类型。线程列表和每个线程的回复分别返回游标；线程读取、回复、解决和重新打开均核对线程所属仓库与 PR，不能用其他仓库的线程 ID 写入。逐行评论使用文件路径、原文件或修改后文件的行号及侧别，随一次 Review 提交。

前端 `platform/github/common/githubService.ts` 定义 `IGitHubService` 和领域类型，`browser/appServerGitHubService.ts` 封装生成的协议、取消与错误分类。Web 和 Electron 都从现有 Renderer Host 获得该服务，Workbench 注册同一个实例；产品调用不经过 `workbench/api`。

在 Workbench 或 Sessions 的命令面板运行 **GitHub Pull Requests and Issues**（`workbench.action.github.open`），输入仓库 owner 和名称，即可浏览 PR 与 Issue。PR 页面提供文件 Diff、检查结果、逐行评论草稿、评审提交、讨论回复与解决、修改与关闭、合并和自动合并；Issue 页面提供创建、修改、标签、负责人、评论与关闭/重新打开。创建 PR 接收已经推送的源分支，也接受 `owner:branch`。审查和创建/编辑草稿保存在当前窗口，关闭页签不会丢失；切换 GitHub 账号时清空私有数据和草稿。旧提交的非空审查草稿阻止提交；写入结果不确定时阻止重复写入，用户查看 GitHub 后可明确确认结果。Alt+F1 打开键盘帮助，Accessible View 提供详情文本。

账号选择框支持多个 GitHub.com 和 Enterprise Server 账号，菜单提供个人访问令牌连接和所选账号登出。PR 页面支持请求或移除用户与团队审查者，按 GitHub 返回的权限编辑或删除逐行评论；写入前核对评论所属仓库与 PR，收到明确确认才更新界面。

本地检出和推送委托 `ash-git`，用户明确选择仓库与远端。检出从目标仓库的 PR ref 获取完整提交，核对审阅的 SHA 后创建本地分支；未保存文件或磁盘改动阻止检出。推送使用 PR 源仓库和源分支，确认本地分支及提交后只推送该提交，不强制覆盖远端历史。远端所有 fetch/push URL 都必须属于指定仓库；API 账号选择不改变 Git 的 SSH/HTTPS 凭据。仓库菜单提供创建 fork，可选择组织、仓库名和仅复制默认分支；GitHub 受理后返回新仓库地址，Git 对象可能仍在复制。

选择资源类型 **Notifications** 并加载，可查看所选账号的通知，不需要输入仓库。支持未读、全部、参与筛选、分页、单条和全部已读。通知属于账号而非工作区；同一账号的读取共享、修改独占，不同账号独立调度。全部已读可能由 GitHub 在后台处理，界面重新读取实际状态，不把受理当成处理完成。切换账号立即清除通知；只读请求取消后不显示迟到的私有数据，写入不重复提交。PR 和 Issue 通知只从所属主机及仓库的已校验 API URL 转成浏览器地址，其他类型打开该主机的通知收件箱。

GitHub 通知 REST API 只支持 OAuth App 授权或经典 PAT，且需要 `notifications` 或 `repo` scope；GitHub App 用户令牌、安装令牌及细粒度 PAT 均不支持。产品发行配置使用已注册的 Ash Desktop OAuth App，浏览器授权申请 `read:user repo notifications`，覆盖 PR、Issue 和通知；授权服务必须配置同一 Client ID 及该 OAuth App 的客户端密钥。原 GitHub App 授权需要重新登录，不会自动获得通知权限；后端不持有可替代 GitHub 权限的凭据。

仓库菜单中的 **Sign in to GitHub Enterprise** 通过现有账号登录服务启动浏览器授权。管理员在产品服务配置的 `githubEnterpriseAccounts` 数组中提供 `{ "host": "git.example.com", "clientId": "PUBLIC_CLIENT_ID", "brokerBaseUrl": "https://git-auth.example.com/" }`，每个主机仅一项。未配置的主机明确拒绝登录；授权服务使用该实例的 OAuth App 和客户端密钥，桌面仅接收公开配置。令牌交换、用户身份和刷新都绑定同一实例，账号 ID 包含主机，不能与 github.com 的同号账号混用。部署要求见 [授权服务说明](../../services/github-auth/README.md)。

`workbench/contrib/github/browser/` 为常规 Workbench 和 Sessions 的聊天 Markdown 注册 GitHub.com 仓库、Issue、PR 和提交链接详情。卡片使用同一领域接口读取数据；PR 检查在打开卡片时按页加载，源分支使用返回的 `headRepository` 身份跳转，源仓库删除后只显示分支名。链接共享 Issue、PR 与提交读取，移除最后一个引用或切换账号时释放缓存并取消请求。Enter 打开原链接，F2 进入卡片，Tab 遍历链接，Escape 返回原链接；Accessible View 可读取完整描述。

App Server 在 `issue/list` 与 `issue/read` 中用 Git origin 关联 GitHub 仓库，然后使用同一 GitHub 账号供应商操作 Issue。当前只支持 GitHub.com origin；其他托管平台返回目标不支持的操作错误，不提示 GitHub 登录。读取缓存也要求当前授权仍有效；缓存按账号和授权隔离，清理一个授权的页面不影响其他授权。旧的无授权缓存键不会被新查询读取。缺少配置和需要登录分别返回账户不可用与需要认证的结构化错误。

仓库请求失败保留 GitHub 错误分类：认证失败返回 `AccountAuthenticationRequired`，输入错误返回 `InvalidParams`，其他分类使用 `GitHub*` 错误。工作区关联、配置与缓存失败仍属于 `IssueOperationFailed`；产品报告器保留自己的提交结果与错误契约。

产品问题报告使用 `GitHubIssueReporter` 和共享 HTTP 客户端。报告仓库由产品配置的 `reportIssueUrl` 指定，只支持 GitHub.com；不会从当前工作区推断目标。`issueReporter/read` 提供目标与系统诊断，`issueReporter/search` 匿名搜索该仓库的相似问题，搜索取消使用连接内的 `operationId` 并等待原请求结束。`issueReporter/submit` 使用 Ash 当前授权直接创建 Issue，令牌不进入协议。创建只发送一次；响应丢失或服务端错误返回“提交结果不确定”，调用方保留草稿并提示先查看仓库。OAuth App 授权需要 `repo` scope，用户本身也必须有目标仓库的 Issue 写权限；使用 GitHub App 的发行配置另需 Issues 写权限。配置步骤见 [授权服务说明](../../services/github-auth/README.md)。
