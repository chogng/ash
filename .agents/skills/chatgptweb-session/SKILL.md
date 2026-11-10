---
name: chatgptweb-session
description: Design or review the ChatGPT Web integration in Ash Chat and Sessions. Use when defining Ash capability contracts, routing actions, or deciding which layer owns an interaction or state change.
---

# ChatGPT Web 接入 Ash Chat 与 Sessions

## 职责边界

- **Ash 拥有产品动作和能力契约。** Ash 定义动作语义、入口、来源选择、确认、错误反馈和渲染。设置、项目外观和本地文件由对应的 Ash 服务管理。新会话按用户选择或 Ash 的默认策略路由，已有会话按已绑定的来源打开与继续。
- **ChatGPT Web 适配器负责远端执行和结果映射。** 它按 Ash 契约实现远端能力，管理认证、协议和标识，并将结果和错误映射成 Ash 模型可消费的形式。远端记录由 ChatGPT Web 管理，Ash 通过目录和编辑器模型呈现这些记录。适配器按账号与对象隔离远端身份，共享层将这些标识视为不透明值。
- **发送和停止回复按会话来源执行。** Ash 原生会话走原生 Chat 模型和 App Server，ChatGPT Web 会话走适配器。历史和项目操作按目标记录提供的能力派发，Ash 根据能力是否可用决定界面能提供哪些动作。

## 从真实入口设计接入

沿「Ash 控件 → Ash 命令或服务 → Ash 能力契约 → 对应实现 → Ash 模型 → Ash 渲染」追踪。先复用拥有该动作的入口和契约。确有缺口时，由对应的 Ash 领域扩展实际调用方需要的契约。

桌面从 `src/ash/sessions/sessions.desktop.main.ts` 的 `registerChatWorkspace` 装配来源。共享命令和界面通过 Ash 契约消费能力。目录、项目和记录操作先看 `ChatListSource` 及其记录类型，编辑器先看 `IReplyChatEditorModel`。

## 边界示例

- **归档会话。** Ash 解析选中的目录记录并处理确认。ChatGPT Web 适配器通过记录的归档能力执行远端写入，并在远端确认后通过目录发布结果。Ash 从目录状态刷新界面。
- **编辑 ChatGPT 项目。** 同一个表单按字段归属提交。颜色和图标由 Ash 保存到本地偏好，名称和说明通过项目能力交给适配器写入远端。只改外观时，断网也能保存。

## 验收原则

- 从真实 Ash 入口验证派发、写入归属和界面结果。涉及共享动作时，分别验证原生和 ChatGPT Web 来源，确认各入口从对应的状态归属方读取结果。
- 涉及远端写入时，验证失败后界面仍反映已确认的状态，并检查切换账号或目标后，晚到的结果按原账号和目标隔离。涉及本地偏好时，验证远端不可用仍能保存，且远端请求数为零。
