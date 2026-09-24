# `ash-editor-host`

1. 管文件 Tab、活动文档、视口、脏状态、外部修改冲突和关闭/保存周期。
2. 管编辑器输入、搜索、自动滚动、诊断、补全、悬浮信息，以及本地和远程语言服务生命周期。
3. Workbench 只提供文件效果、语言事件出口和远程 App Server 会话；文本编辑能力继续委托给 `ash-editor`。

验证：`cargo test -p ash-editor-host --lib`。
