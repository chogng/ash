# Chat 模式的 ChatGPT Web 适配器

桌面 Agents Window 的 Chat 模式有两条会话路径。它们共用 Ash 的聊天界面，各自拥有会话状态、模型目录和请求路由。

| 路径          | 数据与操作的归属                                                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ash 原生 Chat | Ash 的 [`ChatWidgetModel`](../../browser/chatWidgetModel.ts) 使用原生会话服务，由 Ash 管理 Session、Thread、Turn 和原生模型选择。                                                     |
| ChatGPT Web   | [`ChatGPTWidgetModel`](browser/chatGPTWidgetModel.ts) 将 [`ChatGPTService`](browser/chatGPTService.ts) 的会话状态和操作适配成共享界面所需的契约。ChatGPT 会话和模型选择由该服务管理。 |

## 通过模型选择会话路径

**New Chat with Model…** 按来源展示 Ash 和 ChatGPT 的模型目录。每个选项携带自己的来源和模型标识。选择 Ash 模型会在 Chat 模式打开一个原生会话草稿。选择 ChatGPT 模型会通过 Web 适配器打开一个 ChatGPT 草稿。双方的模型菜单也可以进入另一条路径的选型入口。现有会话内选择模型时，模型选择仍归该会话的后端。跨后端选择会新建草稿，现有会话的历史和附件留在原会话。相关路由见 [`newChatModelAction.ts`](../../electron-browser/actions/newChatModelAction.ts)。

## 适配器与共享界面的边界

- 适配器通过 [`IChatWidgetModel`](../../../workbench/contrib/chat/browser/widget/chatWidget.ts) 提供可观察的会话投影，包括已加载的消息、草稿、输入状态和模型目录，并提供发送、停止及可用的回复操作。ChatGPT 专属的标识转换、朗读、分叉和分享由适配器处理。历史读取和会话更新由 `ChatGPTService` 处理。
- [桌面 Chat 入口](../../electron-browser/chatWorkspace.contribution.ts) 负责装配两条会话路径。共享编辑器和侧栏消费各自的投影，ChatGPT 富内容解码和回复操作由 Web 适配器提供。
- Ash 的 `ChatWidget` 及共享组件根据通用模型组织消息列表、输入框、模型选择器和操作栏。Workbench 只依赖共享契约。两条路径各自保留权威状态，共享组件通过不透明的引用选择模型，由适配器解析 ChatGPT 的标识。
- Web 草稿用适配器提供的 `draftIdentity` 区分，Ash 原生的 Session、Thread 和未命名会话标识只用于原生会话。ChatGPT 模型菜单使用适配器目录，回复里的网页链接由适配器处理。ChatGPT 新消息始终由 Web 适配器发送，包括要求生成文件或报告的提示词。历史里已有的 Cowork 结果保留其 Ash 会话引用，可以打开对应的原生会话。
- [`ChatGPTClient`](browser/chatGPTClient.ts) 解码 Web 响应，[`ChatGPTReplyBackend`](browser/chatGPTReplyBackend.ts) 将流式回复、停止和错误语义转换为 Sessions 的 [`IChatReplyBackend`](../../common/chatReplyBackend.ts) 契约。App Server 的 profile 级认证服务管理 ChatGPT 登录，Electron Main 的传输适配器负责获授权的请求。共享组件只接收转换后的数据。

## 接入其他 Web 服务

新增 Web 服务时，由独立适配器接入该服务的认证和传输，管理会话身份与模型目录，并把数据与操作映射到共享聊天契约。由 Chat 模式的选型入口按模型来源路由，共享组件继续组织界面。各适配器分别声明可用操作，服务缺少的能力由界面按契约处理。

当前选型入口显式处理 Ash 和 ChatGPT 两个来源。接入第三个 Web 服务时，需要扩展该入口的来源和路由。
