# `ash-files`

1. 拥有 Files Pane 的目录树、路径搜索状态、滚动、布局、Toolbar、交互身份和 UI。
2. 通过 `ash-file-search::Service` 创建路径搜索，持有请求 handle 并消费结果；目录快照、文件读取和打开文件副作用由调用方提供和执行。
3. 通过 `FilesAction` 返回打开文件、加载目录和焦点变化；验证命令为 `just test ash-files`。
