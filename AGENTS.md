- `../vscode` and `../codex` and `../zed` and `../warp`, `../marketplace`, `../mxc`

# Ash Agent Instructions

Before modifying this repository:

1. Read [`.github/copilot-instructions.md`](.github/copilot-instructions.md) completely for repository ownership, dependency direction, workflow, and scoped-instruction routing.
2. Read every file under [`.github/instructions`](.github/instructions) whose `applyTo` pattern matches any target file. Scoped instructions add to the repository instructions and cannot override a higher-level ownership or safety rule.
3. 修改代码前必须阅读并执行 [公共测试规范](.github/instructions/testing.instructions.md)，即使本次没有修改测试文件；同步检查测试覆盖，并完成受影响行为与构建的验证。
4. 修改 Rust、Cargo 清单/锁文件、`.cargo/` 或 Rust 构建检查时，同时阅读 [Rust 规范](.github/instructions/rust.instructions.md)和 [Rust 测试规范](.github/instructions/rust-testing.instructions.md)。
5. 修改 TypeScript 时同时阅读匹配的前端规范和 [TypeScript 测试规范](.github/instructions/typescript-testing.instructions.md)。

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
- 对无法从代码直接看出的设计原因、关键约束、生命周期和接口约定写注释；避免复述代码行为
- Skill 是代码工作的约束。严禁为了迁就现有代码实现而反向修改 Skill；代码与 Skill 冲突时，应按 Skill 修正代码。若认为 Skill 本身有误，只能向用户说明，未经用户明确要求不得修改 Skill。
