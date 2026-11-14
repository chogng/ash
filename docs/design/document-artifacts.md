# 文档与产物职责

文档具有独立于回复的身份和编辑生命周期。会话保存产物引用，目录保存发现所需的元数据，文件与工作副本保存内容。

## 所有权

| 职责                                                   | 唯一 owner                                |
| ------------------------------------------------------ | ----------------------------------------- |
| 原生 Docs 输出接收、初次创建                           | `crates/documents`                        |
| Profile 持久目录、资源身份、来源去重和账户可见范围查询 | `crates/artifact-catalog`                 |
| 通用完成事件与待交付快照的原子提交                     | `crates/state` 的 Thread store            |
| 授权、领域 RPC 转换、完成事件调度                      | App Server                                |
| Renderer 目录投影与 Provider 活跃账户范围              | `sessions/services/artifactCatalog`       |
| Markdown 导入、首次文件写入、导入回执恢复              | `sessions/contrib/docs` 的 `IDocsService` |
| 文件读写、编辑模型、保存冲突、备份                     | FileService、TextModel、WorkingCopy       |
| 会话内产物引用                                         | Provider 的 `ISession.artifacts`          |
| 跨会话卡片与文档打开方式                               | Artifacts 与 Docs contributions           |

App Tools 仅提供真实模型工具入口，通过领域能力执行操作。

## 创建与编辑

原生完成事件先持久化。App Server 将待交付内容交给 Docs；当前最终回复 Markdown 适配器识别 `ash.creation.docs`，选择完成正文，以原来源生成稳定资源身份。Docs 首次写入使用 create-only 语义，再登记目录，成功后确认完成快照。断线或重启可重试；单个文档失败不阻止其他完成记录。

ChatGPT Provider 负责认证、写作内容提取和账户范围，将完整写作交给 `IDocsService.importMarkdown`。Docs 保存可恢复回执，首次创建文件，再调用目录登记元数据；回执在登记成功后删除。损坏回执单独报告，不隐藏已有目录，也不阻止其他导入。

登记后的内容由文件和现有工作副本持有。富文本与 Markdown 源码视图共享资源和文本模型。目录不保存另一份正文，也不执行保存、转换或备份。列表读取不得创建文档。

## 目录和会话

`artifactCatalog/register`、`artifactCatalog/list` 和 `artifactCatalog/changed` 由生成协议定义；Renderer adapter 转换 DTO，产品消费者只读取领域契约。通知路由在首次查询前建立，重连和失效通知触发重读。

目录以 Profile 的稳定客户端身份隔离外部资源，并按 Provider 活跃账户过滤；原生产物使用受信任的本机命名空间。Renderer 账户切换时立即过滤旧缓存。Browser 只能查询本机产物，文件读取需要 Docs 提供的确切资源授权。

`ISessionArtifact` 表达会话内资源与来源关联。原生 Provider 从目录投影产物，Chat 观察投影。远程 Provider 不继承本地文档。跨会话发现使用 Profile 目录，不从当前打开编辑器或当前会话重建持久身份。

## 存储

正文位于 Profile 的 `documents`，客户端身份位于 `artifact-catalog/client-id`，导入回执位于 `documents/imports`。已完成旧布局迁移，一次性升级入口已移除。

## 验证

目录测试覆盖跨客户端和账户隔离、来源唯一性、并发登记及非文档资源。Docs 测试覆盖回复选择、create-only 重放、用户编辑保留、导入中断、损坏回执。App Server 测试覆盖授权、通知、完成交付和 Browser 确切文件访问。Desktop `document-artifacts.spec.ts` 验证创建、编辑、重启及重新打开。
