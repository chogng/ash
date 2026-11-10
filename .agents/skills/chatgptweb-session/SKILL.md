---
name: chatgptweb-session
description: Integrate ChatGPT Web capabilities into Ash Chat and Sessions through Ash contracts. Use for reply routing, conversation and project actions, and ownership of Ash UI, settings, and local files.
---

# ChatGPT Web 接入 Ash Session

## 先判定操作归属

- **Ash Chat 是产品入口。** ChatGPT Web 和 Ash 内置模型是它的两个响应后端。用户从同一个 Ash 界面发起操作，Ash 按已选来源或已有会话的身份调用对应后端。
- **调用从 Ash 发起，结果回到 Ash。** 按「Ash 控件 → Ash 命令或服务 → Ash 能力契约 → 选定后端 → Ash 模型 → Ash 渲染」接线。接入一项 ChatGPT Web 能力时，先找到对应的 Ash API，再由适配器实现该契约的回调，调用 ChatGPT Web API，把响应转换成 Ash 模型可消费的结果。确有缺口时，由 Ash 领域 owner 扩展有实际调用方的契约。
- **Ash 拥有交互和本地状态。** 入口、确认、错误反馈、渲染、设置、项目外观和本地文件的生命周期归 Ash。适配器负责认证、协议、远端标识和状态映射，以及执行该能力要求的远端操作。若接线需要修改 Ash 本地状态，通过拥有该状态的 Ash 服务提交。

例如，打开项目的 Context 时，Ash Projects 通过契约取得列表和文件读取能力。适配器向 ChatGPT Web 读取远端资料并返回字节。是否自动落盘、保存目录、离线打开和错误展示都由 Ash Projects 决定，目录的 `Change` 属于 Ash Settings。

## 沿生产入口检查

同一动作在原生 Ash 和 ChatGPT 都可用时，分别从真实入口追到执行的命令或服务，核对共享交互（包括确认框）在哪里处理、谁最终修改记录。如果调用链在共享交互处提前分叉，优先复用已有的 Ash 入口，把来源差异留在目录或编辑器能力中。最后从状态归属方反查界面如何取得结果，核对各入口的界面从同一份状态派生。

1. 从 `src/ash/sessions/sessions.desktop.main.ts` 追到 `registerChatWorkspace`。在桌面入口装配 `contrib/chatgptweb`，向共享工作区传入契约。Sidebar、Projects、搜索、共享命令和 Workbench 只依赖 Ash 的类型与能力。共享层发现依赖 ChatGPT 实现、远端 ID 前缀或请求路径时，将来源判断收回适配器；若适配器出现 Ash 专属交互、设置或本地持久化策略，将其移回 Ash owner。
2. 在 `contrib/chat/browser/chatListModel.ts` 和 `replyChatEditor.ts` 找现有边界。用 `ChatListSource` 提供会话、项目和可用操作，用 `IReplyChatEditorModel` 提供消息与输入状态。以 `ChatGPTList` 和 `ChatGPTWidgetModel` 为映射点，让共享层从可观察的 Ash 记录派生界面。发送与停止回复沿 `ChatGPTReplyBackend` 到远端；Ash 内置模型走原生 Chat 模型和 App Server。来源缺少操作时省略相应能力。
3. 复用已经拥有相同职责的基座。原生 Ash 会话的目录、读取和创建走 `ISessionsManagementService`，渲染沿用共享会话组件。拆除旧服务前核对草稿 ID、已保存链接和会话恢复的调用者。ChatGPT 会话的 Ash 投影通过目录与编辑器契约提供，不额外创建本地 App Server Session 或 Thread 来镜像它。
4. 从输入框的「添加到项目」和项目标签分别追到动作执行。两个入口复用 Ash 的菜单控件及同一份项目动作列表，并从同一份状态读取选中项目。Ash 项目和 ChatGPT 项目显示在同一组，分隔线用于区分项目选择和「选择文件夹」等不同用途的操作。

## 按动作的数据归属接线

| 动作 | 调用链和验收点 |
| --- | --- |
| 新建会话 | 共享 `sessions.open.new` 调用注入的草稿能力。来源入口解析自己的默认配置并打开草稿。仅打开或恢复草稿时不发消息。首次发送由实际选定的来源执行。已有会话按原来源打开与继续。 |
| 归档会话 | 共享命令经 `SessionActionsService.resolveCatalogArchiveTarget` 找到选中的 Ash 目录记录并调用 `archive`。ChatGPT 适配器解析该记录的远端身份、归档对应会话，再通过目录发布结果。能力缺失或执行失败时保留真实状态。 |
| 新建项目或更改归属 | Ash 按目标项目的归属派发。创建 Ash 项目走现有命令或项目服务，例如 `sessions.createProject`。将 ChatGPT 会话加入 Ash 项目时，适配器提供账号范围内的不透明会话引用，由 `IProjectService.moveExternalConversation` 写入归属。移动到新 ChatGPT 项目时，适配器调用远端创建并设置成员关系。 |
| 编辑项目详情 | Projects 通过 `CatalogProjectDetails` 显示说明和资料。面包屑和侧栏从同一个 `editDetails` 能力派生重命名操作，改名时保留远端最新的说明。项目说明读写同一个远端字段，读取或写回成功后按账号作用域和项目 ID 更新远端快照缓存。恢复的快照可直接显示，编辑权限以本次远端读取为准。 |
| 归档 ChatGPT 项目 | 调用项目记录提供的能力，分页归档其中仍活跃的会话。全部成功后保存 Ash 的项目归档标记。部分失败时可重试剩余会话。恢复项目只清除标记。 |
| 更换会话图标或项目图标、颜色 | `ISessionsListModelService` 保存会话图标。侧栏、Projects 页、项目菜单和输入框下方的标签都通过 Ash Projects 读取项目外观。目录项目用 `IProjectsService` 和作用域 `preferenceKey` 读写本地偏好，Ash 项目沿用其项目记录。仅打开或保存外观时，直接使用目录和本地偏好，绕开远端详情读取、写入、登录和 401 重试。 |

同一个表单内也按字段归属提交。例如只改 ChatGPT 项目的颜色时，保存应在断网或凭据过期时完成。若名称或说明也有变更，只把对应的远端字段交给项目能力。

目录 ID 和 `preferenceKey` 对共享层是不透明的。适配器为偏好提供账号与对象作用域，并在对象身份失效或替换时通知 Ash 清理或迁移。异步操作提交前确认账号和目标仍与操作开始时一致，避免旧菜单或晚到的响应更新到另一个账号。

## 验证改动

- 从真实 Ash 入口验证能力回调、后端请求和结果渲染；涉及共享操作时分别验证两个后端。生产代码的适配器导入集中在装配处，测试可以直接使用适配器构造 fixture。
- 涉及 Ash 本地状态时，验证远端不可用时仍可操作该本地状态，并检查不触发远端写入。项目资料验证打开项目后由 Ash 落盘、Settings 更改目录，以及重开窗口后离线打开已保存副本。
- 入口与恢复查 `src/ash/sessions/contrib/chatgptweb/test/browser/chatGPTWeb.test.ts`。检查打开草稿不发送，以及恢复时选中同一个会话。
- 列表、归档和外观查同目录的 `chatgptList.test.ts`。用远端请求记录确认只归档目标会话、重试只处理剩余项，以及外观在远端详情不可用时仍可保存并在两个入口显示。
- 新增或修改 ChatGPT Web 请求时，在 `ChatGPTTransport` 同时检查 IPC 对方法、路径和参数的校验，以及 Chromium 发出请求前的认证头处理。回归测试要经过 Chromium 的认证回调，确认批准的 ChatGPT 路由带有当前账号的认证头，其他来源不携带这些头。模拟响应通过后，从真实 Ash 窗口做一次只读验证。若返回 401，先区分认证头被清除和远端拒绝有效登录，再决定是否检查响应字段。
- 草稿选项目查 `chatgptBrowser.test.ts`。从侧栏改图标和颜色后，验证两个选择入口及当前项目标签同步更新。选 Ash 项目后发送，确认归属写入 Ash 项目服务，消息仍经 ChatGPT 发送，并检查远端项目归属的写入次数为零。
- 改动涉及真实桌面入口或切换时，按 `test/smoke/areas/sessions/chatgptNative.spec.ts` 验证混合侧栏、首次发送和恢复，确认同一窗口里两种来源各自沿原身份继续。
