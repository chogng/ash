# ash-session

1. Owns the App Server Session runtime: connection worker, Session/Thread requests and subscriptions, bounded command queue, remote reconnect policy, and backend-assembled transcript delivery.
2. Owns one Agent Session Pane: Thread metadata and header wrap a ChatWidget containing the transcript timeline and ChatInput; ChatInput owns its editor, toolbar, and the input-only interaction area used by Slash Commands and model selection.
3. ChatInput consumes host-supplied local input history, owns recall/search and draft restoration, and preserves the selected Agent/Shell route when recalling an input.
4. Accepts connection targets, styles, and host effects; files, Git, configuration, Tabs, windows, and product event routing remain with their domain crates or the product host.
5. Owns ChatInput classification deadlines, input revisions, and pending submission intent; the window runs captured inference tasks on the ZUI executor and delivers their results to the Pane.
6. Uses App-owned [input classification](../input-classifier/README.md) and [Shell completion](../shell-completion/README.md) in the same process; their algorithms and embedded assets stay in those crates.
