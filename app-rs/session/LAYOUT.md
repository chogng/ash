`ash-session` 的目录按状态 owner 组织：

```text
src
├── runtime.rs
│   └── runtime
│       ├── contract.rs
│       └── worker.rs → worker/operations.rs
├── pane.rs
│   └── pane
│       ├── context.rs / state.rs / style.rs
│       ├── canvas.rs / interaction.rs
│       └── chat_widget.rs → timeline.rs / timeline_scroll.rs / transcript.rs
└── chat_input.rs
    └── chat_input
        ├── editor.rs / toolbar.rs / layout.rs / view.rs
        └── interaction.rs / interaction_view.rs / catalog.rs / shell_completion.rs
```

`runtime` 管连接、命令和重连；Session 与当前 Thread 的持久状态由共享后端管理。`pane` 管一个 Session Pane 的状态与绘制；`chat_input` 管输入编辑器及其交互面。测试与对应实现放在同一目录。
