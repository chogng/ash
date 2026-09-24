- `../vscode` and `../codex` and `../zed` and `../warp`, `../marketplace`, `../mxc`

# Ash Agent Instructions

Before modifying this repository:

1. Read [`.github/copilot-instructions.md`](.github/copilot-instructions.md) completely for repository ownership, dependency direction, workflow, and scoped-instruction routing.
2. Read every file under [`.github/instructions`](.github/instructions) whose `applyTo` pattern matches any target file. Scoped instructions add to the repository instructions and cannot override a higher-level ownership or safety rule.
3. Follow the nearest additional `AGENTS.md` when a subtree provides one. Keep detailed rules in their canonical scoped instruction or architecture document rather than copying them into this entry file.
4. 修改代码前必须阅读并执行 [公共测试规范](.github/instructions/testing.instructions.md)，即使本次没有修改测试文件；同步检查测试覆盖，并完成受影响行为与构建的验证。
5. 修改 Rust、Cargo 清单/锁文件、`.cargo/` 或 Rust 构建检查时，同时阅读 [Rust 规范](.github/instructions/rust.instructions.md)和 [Rust 测试规范](.github/instructions/rust-testing.instructions.md)。
6. 修改 TypeScript 时同时阅读匹配的前端规范和 [TypeScript 测试规范](.github/instructions/typescript-testing.instructions.md)。

# Communication

- Lead with the conclusion and use surrounding prose only for important boundaries or caveats.
- When comparing responsibilities, capabilities, implementation status, or design options, prefer a compact conclusion-oriented table when it makes the distinction clearer.
- Use `✅` and `❌` only for genuinely binary judgments. Use explicit labels such as `部分具备`, `尚未完成`, `协调`, or `委托` for nuanced states.

- 回复时请说人话, 避免抽象语言描述
- 禁止 native, projection name
- crate 主要负责能力和依赖隔离
- 禁止兜底写法，过渡设计，过渡思考，防御性编程
- 当你思考项目架构时，请考虑从长期架构的终极形态去设计，而不是基于当前架构的优化方向
- 拆分文件时，避免拆过头
- 使用playwright测试web and electron-ui 以及electron , 调试不通过截图
- 禁止使用 mod.rs, 有 mod.rs 让其退场
- 思考问题时，避免局部视角看问题，从整体看
- Read [`pull_request_template.md`](.github/pull_request_template.md) for pr

## Learnings

* 命名先判断作用域和歧义：公开领域类型与跨模块接口使用准确全称；局部变量、私有函数、命令和脚本使用最短且不歧义的词。目录已经表达产品或领域 owner 时，文件名只表达具体操作，例如 `code/run.py`、`code/run_package.py`，不用 `code/ash.py`、`code/ash_package.py` 重复限定；只有文件脱离目录独立发布或跨 owner 引用确实会歧义时才保留前缀。仅在多个独立单词组合时使用 `_`，不要把已经由上下文表达的限定词重复进名字；例如领域已是目录时用 `dirs`、`add_dir`，不用 `additional_directories`、`add_additional_directory`。
