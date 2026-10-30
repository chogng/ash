# GitHub Rust 扩展

Git 与 GitHub 分别拥有独立能力。`ash-git` 负责本地仓库、提交、分支、差异及 fetch/pull/push，支持不同托管平台；本扩展拥有 Issue、PR 等 REST／GraphQL API 实现；账号／grant 与领域类型由共享 `ash-github` 契约提供，认证由独立的 `github-authentication` 扩展拥有。Git 的 SSH/HTTPS 凭据不等同于 GitHub API 授权，两者没有相互依赖。

GitHub 认证已拆到 [`extensions/github-authentication`](../../extensions/github-authentication/README.md) 的独立 Rust executable。App 使用 profile 级唯一实例，所有目录和窗口通过现有账号接口共享它；默认 TUI 组合不加载。此扩展不包含 OAuth、token 存储、刷新或 loopback 回调实现。

REST／GraphQL 业务由 `ash-github-extension` 独立程序执行，App Server 的 GitHub processor 只转换产品协议并调用共享消费者契约。本扩展复用公共 Rust 扩展 SDK、Host RPC v1 和进程监管，通过 invocation-scoped HTTP 与认证能力调用访问受限宿主服务；它不能访问 SecretStore；通用机制与服务商业务的边界见 [GitHub 分工](../../docs/editor-extensions.md#02-github-的具体分工)。

- 通过 `ash-http-client` 的 REST / GraphQL 请求读写 Issue、评论、标签、负责人和 PR，共用产品的代理、TLS 和取消能力。不打包或依赖 `gh`，也不读取 GitHub CLI 登录配置或环境变量 token。
- 保留 GitHub 参数与返回值校验，不拥有 Agent、Thread、工作目录或模型调用。
- 仓库操作返回结构化 `Error`，区分输入、认证、权限、限流、资源缺失、冲突、不可用、超时、取消、响应格式、执行失败和提交结果不确定。分类依据 HTTP 状态、响应头与 GraphQL 机器可读类型；远端错误正文和凭据供应商诊断不进入公开错误。
- 不维护 Issue Workflow、assignment、领取租约、执行阶段或交付状态机。
- Issue 浏览缓存由 `ash-state` 维护；执行通过通用 Session/Agent API，Agent 使用获准的 Plugin 工具处理外部操作。

共享消费者的 `GitHub::for_selected_account` 接收明确账号、选定的 API Provider 和请求取消令牌，捕获供应商验证过的主机、账号与授权身份。每次请求重新核对授权，并通过 Authorization 头发送对应主机的 token。登出、重新登录或 token 替换后，旧对象不能发起请求，读取结果也会被丢弃。已经确认的写入结果仍表示已完成的修改。GitHub.com 与 Enterprise Server 的同名账号分别保存，主机不匹配时不会发送凭据；登录由 `ash-login` 经认证能力代理调用独立 Rust Provider，密钥通过核心 `ash-secrets` 服务保存。浏览器登录使用配置的 GitHub App 或 OAuth App；个人访问令牌连接不要求浏览器授权服务配置，通过目标主机的 `/user` 验证账号后保存。

账号目录把主账号排在首位。连接 GitHub.com 账号会更新主账号；连接 Enterprise 不替换已有的 GitHub.com 主账号。未提供账号的消费者通过 `GitHub::for_account` 使用主账号；管理界面选择账号仅影响当前窗口，每个仓库请求携带该账号。按账号登出只移除对应授权，提供方登出移除其全部授权。旧单账号密钥在第一次读取时迁入账号目录并删除。

`github/*` RPC 不要求本地 checkout，直接接收明确的仓库身份。App Server 为同一托管仓库协调读写，写入独占，读取共享；每个请求携带连接内唯一的 `operationId`，通过 `github/cancel` 取消。HTTP 尝试最多 30 秒，响应最多 8 MiB；分页接口显式返回下一页，PR 文件返回是否触及 3000 文件上限。写入只发送一次，响应丢失、服务端错误或取消后无法确认结果时返回 `GitHubSubmissionUncertain`，调用方应先查看远端结果。

已接入的接口包括仓库信息、Issue 列表/详情/创建/修改、Issue 与 PR 的讨论评论、PR 列表/详情/创建/修改/文件/评审/合并/自动合并、逐行评审线程及回复与解决状态、提交详情及检查状态、标签和可分配负责人。`github/commit/read` 接收 7–40 位十六进制 SHA，校验返回的完整 SHA 与请求一致，不接受可变分支名。修改 Issue 可以调整状态、标签和负责人。PR 评审与合并携带用户审阅的 commit；评审提交前检查当前 head，评论绑定该 commit；合并使用 REST `sha`，自动合并使用 GraphQL `expectedHeadOid` 由 GitHub 原子校验。

`github/pullRequest/diff` 返回指定 head 与目标分支的共同祖先及文件列表，读取前后检查 PR head 和目标分支提交未变。`github/file/read` 只按完整提交 SHA 读取文件；超过 1 MiB 的内容和二进制内容返回明确类型。线程列表和每个线程的回复分别返回游标；线程读取、回复、解决和重新打开均核对线程所属仓库与 PR，不能用其他仓库的线程 ID 写入。逐行评论使用文件路径、原文件或修改后文件的行号及侧别，随一次 Review 提交。

前端 `platform/github/common/githubService.ts` 定义 `IGitHubService` 和领域类型，`browser/appServerGitHubService.ts` 封装生成的协议、取消与错误分类。Web 和 Electron 都从现有 Renderer Host 获得该服务，Workbench 注册同一个实例；产品调用不经过 `workbench/api`。

Issue 列表、详情和缓存保留 GitHub 的可选 `state_reason`，App Server 以 `stateReason` 传给前端。旧响应或缓存缺少该字段时仍按已关闭处理；未知原因原样保留。聊天链接卡片通过 `workbench/common/chatIssue.ts` 选择状态图标与主题色：开放为绿色，完成为紫色，不计划处理或重复为弱化文本色，状态文字仍供无障碍读取。

PR 列表支持 `head`（`owner:branch`）筛选，会话分支关联使用此条件查询，避免遍历仓库历史。PR 详情保留 GitHub 返回的 `mergeable`：`false` 表示无法合并，`null` 表示仍在计算，不能把未知结果显示为合并冲突。会话输入区和列表共享分支关联结果，并结合检查与审查线程显示需要处理的状态。

会话还可手动附加 GitHub.com 或 Enterprise PR。`github/session/pullRequests` 读取引用，`github/session/pullRequest/attach` 和 `github/session/pullRequest/detach` 按仓库身份及编号增删引用；这三个方法只访问 `ash-state` 的 Session 根 Thread 存储，按 Session 串行执行，不携带账号或 `operationId`。实际变化发布 `session/changed`，重复操作不产生重复引用。标题与实时状态仍通过 GitHub API 读取，分支关联和手动引用合并去重。移除引用不关闭 PR，当前分支的自动关联仍保留；读取失败时显示状态不可用并保留移除入口。

在 Workbench 或 Sessions 的命令面板运行 **GitHub Pull Requests and Issues**（`workbench.action.github.open`），输入仓库 owner 和名称，即可浏览 PR 与 Issue。PR 页面提供文件 Diff、检查结果、逐行评论草稿、评审提交、讨论回复与解决、修改与关闭、合并和自动合并；Issue 页面提供创建、修改、标签、负责人、评论与关闭/重新打开。创建 PR 接收已经推送的源分支，也接受 `owner:branch`。审查和创建/编辑草稿保存在当前窗口，关闭页签不会丢失；切换 GitHub 账号时清空私有数据和草稿。旧提交的非空审查草稿阻止提交；写入结果不确定时阻止重复写入，用户查看 GitHub 后可明确确认结果。Alt+F1 打开键盘帮助，Accessible View 提供详情文本。

账号选择框支持多个 GitHub.com 和 Enterprise Server 账号，菜单提供个人访问令牌连接和所选账号登出。PR 页面支持请求或移除用户与团队审查者，按 GitHub 返回的权限编辑或删除逐行评论；写入前核对评论所属仓库与 PR，收到明确确认才更新界面。

本地检出和推送委托 `ash-git`，用户明确选择仓库与远端。检出从目标仓库的 PR ref 获取完整提交，核对审阅的 SHA 后创建本地分支；未保存文件或磁盘改动阻止检出。推送使用 PR 源仓库和源分支，确认本地分支及提交后只推送该提交，不强制覆盖远端历史。远端所有 fetch/push URL 都必须属于指定仓库；API 账号选择不改变 Git 的 SSH/HTTPS 凭据。仓库菜单提供创建 fork，可选择组织、仓库名和仅复制默认分支；GitHub 受理后返回新仓库地址，Git 对象可能仍在复制。

选择资源类型 **Notifications** 并加载，可查看所选账号的通知，不需要输入仓库。支持未读、全部、参与筛选、分页、单条和全部已读。每页请求 50 条，以 GitHub 响应的 `Link` 头中 `rel="next"` 判断下一页，不按本页条数推算；后续请求保留所选账号、主机和筛选条件。通知属于账号而非工作区；同一账号的读取共享、修改独占，不同账号独立调度。全部已读可能由 GitHub 在后台处理，界面重新读取实际状态，不把受理当成处理完成。切换账号立即清除通知；只读请求取消后不显示迟到的私有数据，写入不重复提交。PR 和 Issue 通知只从所属主机及仓库的已校验 API URL 转成浏览器地址，其他类型打开该主机的通知收件箱。

GitHub 通知 REST API 只支持 OAuth App 授权或经典 PAT，且需要 `notifications` 或 `repo` scope；GitHub App 用户令牌、安装令牌及细粒度 PAT 均不支持。产品发行配置使用已注册的 Ash Desktop OAuth App，浏览器授权申请 `read:user repo notifications`，覆盖 PR、Issue 和通知；授权服务必须配置同一 Client ID 及该 OAuth App 的客户端密钥。原 GitHub App 授权需要重新登录，不会自动获得通知权限；后端不持有可替代 GitHub 权限的凭据。

仓库菜单中的 **Sign in to GitHub Enterprise** 通过现有账号登录服务启动浏览器授权。管理员在产品服务配置的 `githubEnterpriseAccounts` 数组中提供 `{ "host": "git.example.com", "clientId": "PUBLIC_CLIENT_ID", "brokerBaseUrl": "https://git-auth.example.com/" }`，每个主机仅一项。未配置的主机明确拒绝登录；授权服务使用该实例的 OAuth App 和客户端密钥，桌面仅接收公开配置。令牌交换、用户身份和刷新都绑定同一实例，账号 ID 包含主机，不能与 github.com 的同号账号混用。部署要求见 [授权服务说明](../../services/github-auth/README.md)。

`workbench/contrib/github/browser/` 为常规 Workbench 和 Sessions 的聊天 Markdown 注册 GitHub.com 仓库、Issue、PR 和提交链接详情。卡片使用同一领域接口读取数据；PR 检查在打开卡片时按页加载，源分支使用返回的 `headRepository` 身份跳转，源仓库删除后只显示分支名。链接共享 Issue、PR 与提交读取，移除最后一个引用或切换账号时释放缓存并取消请求。Enter 打开原链接，F2 进入卡片，Tab 遍历链接，Escape 返回原链接；Accessible View 可读取完整描述。

App Server 在 `issue/list` 与 `issue/read` 中用 Git origin 关联 GitHub 仓库，然后使用同一 GitHub 账号供应商操作 Issue。当前只支持 GitHub.com origin；其他托管平台返回目标不支持的操作错误，不提示 GitHub 登录。读取缓存也要求当前授权仍有效；缓存按账号和授权隔离，清理一个授权的页面不影响其他授权。旧的无授权缓存键不会被新查询读取。缺少配置和需要登录分别返回账户不可用与需要认证的结构化错误。

仓库请求失败保留 GitHub 错误分类：认证失败返回 `AccountAuthenticationRequired`，输入错误返回 `InvalidParams`，其他分类使用 `GitHub*` 错误。工作区关联、配置与缓存失败仍属于 `IssueOperationFailed`；产品报告器保留自己的提交结果与错误契约。

产品问题报告使用 `GitHubIssueReporter` 和共享 HTTP 客户端。报告仓库由产品配置的 `reportIssueUrl` 指定，只支持 GitHub.com；不会从当前工作区推断目标。`issueReporter/read` 提供目标与系统诊断，`issueReporter/search` 匿名搜索该仓库的相似问题，搜索取消使用连接内的 `operationId` 并等待原请求结束。`issueReporter/submit` 使用 Ash 当前授权直接创建 Issue，令牌不进入协议。创建只发送一次；响应丢失或服务端错误返回“提交结果不确定”，调用方保留草稿并提示先查看仓库。OAuth App 授权需要 `repo` scope，用户本身也必须有目标仓库的 Issue 写权限；使用 GitHub App 的发行配置另需 Issues 写权限。配置步骤见 [授权服务说明](../../services/github-auth/README.md)。

## 运行与生命周期

公开 typed DataChannel 为 `github.api.v2`，消息由 `ash-github::{GitHubInvocation, GitHubRequest, GitHubResponse}` 定义。仓库、Issue、PR、分享、分支保护和问题报告使用同一独立程序。共享 `crates/github` 只保留领域类型、错误、授权契约与消费者代理；App Server 的生产依赖不链接本扩展实现。`vscode/extensions/github` 是扩展分工和可观察行为参照；仓库发布、搜索、分享和分支保护通过此 Provider 与现有 Git 扩展接入。

产品入口与 managed profile 入口都显式选定安装目录下的 `bin/ash-github-extension{.exe}`。`LocalProfileRuntime` 持有唯一监管器；目录消费者携带各自授权和 HTTP 服务绑定。首次 API 请求才启动程序，停用取消全部在途服务并关闭进程，重新启用后按需恢复；没有 API 扩展时返回不可用，不回退到内置 API 实现。缺少被显式选定的 executable 在组合时失败。默认 TUI / embedded options 不选定 GitHub 扩展。

认证仍由 `github-authentication` 持有唯一会话与刷新任务。API 调用绑定精确的 host、account 和 grant；宿主只允许调用该 grant 的 token 接口和对应 GitHub API HTTPS 主机，拒绝重定向、秘密访问与其他后端能力。问题报告搜索允许匿名 `GET /search/issues`。读取在返回前再次核对授权；已经确认的写入不因随后的登出变成失败。调用取消、停用或进程失败后无法确认的写入返回 `SubmissionUncertain`，不会重放；监管器可为后续新调用恢复独立进程。

构建和签名清单包含独立 executable；扩展清单和中英文 NLS 随预装资源分发，Rust 源文件不进入安装资源。`tests/runtime.rs` 使用 Cargo 构建的真实程序及生产 App Server adapter 检查共享调用、按需注册、取消、停用／恢复、真实进程崩溃后的恢复与禁止写入重放、授权撤销和匿名报告搜索；领域测试随 API 实现迁入本目录。

验证：`just verify ash-github-extension`。产品 launcher 面向受信任发行程序，本扩展不扩展通用第三方安装、执行授权或 OS 沙箱支持。

## 仓库、分享与分支保护

命令面板中的 `github.publish` 选择当前工作区的本地仓库，必要时通过 Git 扩展初始化仓库并创建首次提交，再确认账号、名称、公开／私有可见性和要推送的分支。默认创建私有仓库；已有 `origin` 时选择新的远程名。创建由 Rust Provider 调用 `POST /user/repos`，不自动初始化远程历史；本地添加远程和推送复用 Git 扩展。创建结果不确定时先检查远端；创建已成功而推送失败时保留仓库地址，只重试 Git 推送。账号选择随本次 HTTPS Git 凭据请求传递，不修改其他消费者的默认账号。

`github.clone` 使用同一账号目录搜索最近更新的可访问仓库，也接受关键词、`owner/name` 或同一主机上的仓库 URL；搜索按页加载，关闭选择器或切换账号会取消读取并丢弃旧结果。选定仓库后可以分页选择分支，再通过 Git 扩展选择目标目录并克隆。`github.gitProtocol` 控制 HTTPS／SSH，API 返回的仓库和克隆 URL 必须属于选定主机。

编辑器和资源管理器的分享菜单以及命令面板提供 `github.copyPermalink`、`github.copyVscodeDevLink`、`github.copyVscodeDevLinkFile`、`github.copyVscodeDevLinkWithoutRange` 和 `github.openOnGitHub`。优先使用当前分支跟踪的 GitHub 远程；文件／目录路径和引用逐段编码，编辑器选择转换为 GitHub 行号。永久链接固定到完整提交 SHA；普通链接使用远程跟踪分支。未发布的分支或提交先询问发布／推送，分支落后时先询问拉取，本地更改需要确认链接指向已提交版本。生成链接无需登录，也不发出网络请求；Enterprise 链接留在其主机，vscode.dev 仅支持 GitHub.com。

`github.branchProtection` 默认开启。Git 扩展在常规提交检查前，通过可选的 GitHub 命令读取当前远程仓库的活动分支规则集；只读取有写权限账号的要求 PR 的规则，包括继承规则和分页，支持全部分支、默认分支、包含与排除模式。命中后复用 `git.branchProtectionPrompt` 的提交当前分支／新建分支提示；网络或权限错误不会被当作无保护规则。没有 GitHub 账号的普通 Git 操作继续可用。此检查是提交提示，远端仍拥有最终分支保护裁决。

CI 使用 [Checks annotations API](https://docs.github.com/en/rest/checks/runs#list-check-run-annotations)
读取同 PR head 的输出和注释；Actions job 重新运行使用
[Workflow runs API](https://docs.github.com/en/rest/actions/workflow-runs#re-run-a-job-from-a-workflow-run)，
日志下载使用 [Workflow jobs API](https://docs.github.com/en/rest/actions/workflow-jobs)。调用前核对 check、PR head、
Actions job 的仓库和 `check_run_url`；不向检查的外部详情 URL 发送 API 凭据。
日志 API 的 302 仅转换为短时下载能力，扩展不跟随跳转；URL 必须为默认 HTTPS 端口，
主机属于 `*.blob.core.windows.net`、`*.actions.githubusercontent.com`、`logs.githubusercontent.com`
或该 Enterprise 自身主机。其他 Enterprise 存储主机明确拒绝，可使用已有完整结果链接。
