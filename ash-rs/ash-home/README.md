# `ash-home`

- 读取选定 `ASH_HOME/AGENTS.md`、`ASH_HOME/ASH.md` 与 `ASH_HOME/instructions/*.md` 中的用户级 Instructions。
- 复用 `ash-instructions` 的格式校验、加载策略、诊断和不可变快照。
- 每次模型调用前刷新 catalog；不创建目录或读取 `CLAUDE.md` 等专有格式。
- 由 App Server 把 Global 与命中文件的 Contextual 内容放入模型上下文；目录级内容仍由已授权目录负责。

验证：`just test ash-home`、`just check ash-home`、`just rust-warnings ash-home`。
