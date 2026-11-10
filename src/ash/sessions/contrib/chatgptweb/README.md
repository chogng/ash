# Chat 模式的 ChatGPT Web 适配器

桌面 Agents Window 的 Chat 模式包含以下会话路径。它们共用 Ash 的聊天界面，各自拥有会话状态、模型目录和请求路由。

| 路径              | 数据与操作的归属                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ash 原生 Chat     | Ash 的 [共享会话模型](../../browser/chatWidgetModel.ts) 使用 Sessions 服务，由 Ash 管理 Session、Thread、Turn 和原生模型选择。                                            |
| ChatGPT Web       | [`ChatGPTService`](browser/chatGPTService.ts) 提供 ChatGPT 会话、模型和操作。[适配器的界面模型](electron-browser/chatGPTWidgetModel.ts) 将这些数据投影到 Ash 的聊天界面。 |
| ChatGPT（实验性） | 从「新建」的上下文菜单或命令面板打开。使用独立的 Codex 登录连接、会话缓存和草稿。历史使用桌面分页接口，发送走 Sentinel 校验。                                             |

## 通过模型选择会话路径

Chat 模式的「新建」打开一个可选 ChatGPT 或 Ash 模型的草稿。在无附件的新草稿里直接选 Ash 模型，会在 Chat 模式打开一个 Ash 草稿并带上未发送的文字。Ash 草稿也可以直接选择 ChatGPT 模型，打开 ChatGPT 草稿。如果 ChatGPT 草稿为空，会带上 Ash 草稿中的文字。已有会话按创建时的归属打开和选模。Ash 原生 Chat 和 Code 共用模型目录，各自保存选模偏好。相关路由见 [`newChatModelAction.ts`](../chat/electron-browser/actions/newChatModelAction.ts) 和 [`chatGPTWeb.ts`](electron-browser/chatGPTWeb.ts)。

## 适配器与共享界面的边界

- `ChatGPTService` 提供可观察的会话数据和来源操作，包括历史读取、模型和草稿、发送、停止及回复资源。宿主负责确认对话框、剪贴板和音频播放，并通过适配器执行 ChatGPT 的分享或获取朗读资源。
- [Sessions README](../../README.md) 定义适配器与桌面宿主的边界。适配器通过 `IReplyChatEditorModel`、`ChatListSource` 和搜索契约向共享界面提供投影。跨源选模时，适配器在模型目录查询完成后重新校验草稿并交付未发送的文字，Ash 负责创建原生草稿。
- Ash 的 `ChatWidget` 及共享组件根据通用模型组织消息列表、输入框、模型选择器和操作栏。Workbench 只依赖共享契约。各入口保留自己的权威状态，共享组件通过不透明的引用选择模型，由适配器解析 ChatGPT 的标识。
- Web 草稿用适配器提供的 `draftIdentity` 区分，Ash 原生的 Session、Thread 和未命名会话标识只用于原生会话。ChatGPT 模型菜单使用适配器目录，回复里的网页链接由适配器处理。ChatGPT 新消息始终由 Web 适配器发送，包括要求生成文件或报告的提示词。历史里已有的 Cowork 结果保留其 Ash 会话引用，可以打开对应的原生会话。
- [`ChatGPTClient`](browser/chatGPTClient.ts) 解码 Web 响应，[`ChatGPTReplyBackend`](browser/chatGPTReplyBackend.ts) 将流式回复、停止和错误语义转换为 Sessions 的 [`IChatReplyBackend`](../../common/chatReplyBackend.ts) 契约。App Server 的 profile 级认证服务管理 ChatGPT 登录，Electron Main 的传输适配器负责获授权的请求。共享组件只接收转换后的数据。
- Ash Chat 定义实体详情能力，并负责辅助侧栏、加载与关闭、焦点恢复以及本地缓存。ChatGPT Web 作为 Ash 的响应后端，按原会话和回复读取详情流与资源，将结果映射为 Ash 的回复数据。详情与主聊天的消息、草稿和历史独立。

## 接入其他 Web 服务

新增 Web 服务时，由独立适配器接入该服务的认证和传输，管理会话身份与模型目录，并把数据与操作映射到共享聊天契约。由 Chat 模式的选型入口按模型来源路由，共享组件继续组织界面。各适配器分别声明可用操作，服务缺少的能力由界面按契约处理。

当前选型入口显式处理 Ash 和 ChatGPT 两个来源。接入第三个 Web 服务时，需要扩展该入口的来源和路由。
