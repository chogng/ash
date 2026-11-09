---
name: chatgpt-agent-window-adapter
description: Implement or review how the ChatGPT adapter plugs into Ash's Agent Window. Use for conversation and project projections, New, archive, provider capabilities, and Ash-local appearance or persistence boundaries.
---

# ChatGPT 接入 Ash Agent Window

ChatGPT 的账号、远端会话和项目记录、模型目录及回复协议由适配器处理。适配器把记录和可用操作投影到 Ash 契约。Ash 负责共享界面、原生会话、本地项目和界面偏好。会话的首次发送、打开和归档沿用其原有身份和生命周期。

## 沿生产入口检查

1. 从 `src/ash/sessions/sessions.desktop.main.ts` 追到 `registerChatWorkspace`。在桌面入口装配 `contrib/chatgptweb`，向共享工作区传入契约。Sidebar、Projects、搜索、共享命令和 Workbench 只依赖 Ash 的类型与能力。发现它们导入 ChatGPT 实现、按远端 ID 前缀分支或自行发送请求时，把这些判断移回适配器。
2. 在 `contrib/chat/browser/chatListModel.ts` 和 `replyChatEditor.ts` 找现有边界。用 `ChatListSource` 提供会话、项目和可用操作，用 `IReplyChatEditorModel` 提供消息与输入状态。以 `ChatGPTList` 和 `ChatGPTWidgetModel` 为映射点，让共享层从可观察的 Ash 记录派生界面。来源缺少操作时省略相应能力。
3. 复用已经拥有相同职责的基座。原生 Ash 会话的目录、读取和创建走 `ISessionsManagementService`，渲染沿用共享会话组件。拆除旧服务前核对草稿 ID、已保存链接和会话恢复的调用者。ChatGPT 会话的 Ash 投影通过目录与编辑器契约提供，不额外创建本地 App Server Session 或 Thread 来镜像它。
4. 从输入框的「添加到项目」和项目标签分别追到动作执行。两个入口复用 Ash 的菜单控件及同一份项目动作列表，并从同一份状态读取选中项目。Ash 项目和 ChatGPT 项目显示在同一组，分隔线用于区分项目选择和「选择文件夹」等不同用途的操作。

## 按动作的数据归属接线

| 动作 | 调用链和验收点 |
| --- | --- |
| 新建会话 | 共享 `sessions.open.new` 调用注入的草稿能力。来源入口解析自己的默认配置并打开草稿。仅打开或恢复草稿时不发消息。首次发送由实际选定的来源执行。已有会话按原来源打开与继续。 |
| 归档会话 | 共享命令经 `SessionActionsService.resolveCatalogArchiveTarget` 找到选中的 Ash 目录记录并调用 `archive`。ChatGPT 适配器解析该记录的远端身份、归档对应会话，再通过目录发布结果。能力缺失或执行失败时保留真实状态。 |
| 新建项目或更改归属 | 按目标项目的归属派发。适配器收到创建 Ash 项目的请求时，调用现有 Ash 命令或项目服务，例如 `sessions.createProject`。将 ChatGPT 会话加入 Ash 项目时，适配器把账号范围内的不透明会话引用交给 `IProjectService.moveExternalConversation`。移动到新 ChatGPT 项目时，适配器调用远端创建并设置成员关系。 |
| 归档 ChatGPT 项目 | 调用项目记录提供的能力，分页归档其中仍活跃的会话。全部成功后保存 Ash 的项目归档标记。部分失败时可重试剩余会话。恢复项目只清除标记。 |
| 更换会话图标或项目图标、颜色 | `ISessionsListModelService` 保存会话图标。侧栏、Projects 页、项目菜单和输入框下方的标签都通过 Ash Projects 读取项目外观。目录项目用 `IProjectsService` 和作用域 `preferenceKey` 读写本地偏好，Ash 项目沿用其项目记录。仅打开或保存外观时，直接使用目录和本地偏好，绕开远端详情读取、写入、登录和 401 重试。 |

同一个表单内也按字段归属提交。例如只改 ChatGPT 项目的颜色时，保存应在断网或凭据过期时完成。若名称或目标也有变更，只把对应的远端字段交给项目能力。

目录 ID 和 `preferenceKey` 对共享层是不透明的。适配器为偏好提供账号与对象作用域，并在对象身份失效或替换时通知 Ash 清理或迁移。异步操作提交前确认账号和目标仍与操作开始时一致，避免旧菜单或晚到的响应更新到另一个账号。

## 验证改动

- 从入口和消费者两端检查依赖，确认生产代码的适配器导入集中在装配处。测试可以直接使用适配器构造 fixture。
- 入口与恢复查 `src/ash/sessions/contrib/chatgptweb/test/browser/chatGPTWeb.test.ts`。检查打开草稿不发送，以及恢复时选中同一个会话。
- 列表、归档和外观查同目录的 `chatgptList.test.ts`。用远端请求记录确认只归档目标会话、重试只处理剩余项，以及外观在远端详情不可用时仍可保存并在两个入口显示。
- 草稿选项目查 `chatgptBrowser.test.ts`。从侧栏改图标和颜色后，验证两个选择入口及当前项目标签同步更新。选 Ash 项目后发送，确认归属写入 Ash 项目服务，消息仍经 ChatGPT 发送，并检查远端项目归属的写入次数为零。
- 改动涉及真实桌面入口或切换时，按 `test/smoke/areas/sessions/chatgptNative.spec.ts` 验证混合侧栏、首次发送和恢复，确认同一窗口里两种来源各自沿原身份继续。
