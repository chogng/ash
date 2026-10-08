# Ash main 集成与后续工作

更新：2026-10-08。本次把工作树中 main 缺少的有效改动提交到 main，并保留线性历史。后续工程工作从 `/Volumes/1t/ash` 的 main 接手。

## 已发布的改动

| 提交        | 内容                                                  |
| ----------- | ----------------------------------------------------- |
| `677a131fd` | Preferences 改动转为线性提交                          |
| `e4e6d2585` | Trace 改动转为线性提交                                |
| `9b2e4178d` | 通知弹窗测试使用系统标题栏                            |
| `764cae00e` | UI 场景验证技能对齐 Ash runner                        |
| `f6f90a54a` | 可变图标字体构建工具与验证                            |
| `2c360ea72` | 共享保存参与器、光标与 snippet 生命周期修复及回归覆盖 |
| `9c44c645e` | 修正并发提交的 issue template 末尾空行                |
| `2ea5892bc` | 并发开发持久化基础、冻结工作树绑定及回归测试          |

AgentHost、Output、平台存储等工作树提交已经进入 main。旧工作树中重复改动、生成产物和会覆盖较新修复的旧实现没有重新覆盖 main，原始内容保留在恢复备份。

## 本次实际验证

- 编辑器：1,747 项单元测试通过；最终定向 94 项通过；新增 completion 集成测试通过。六个保存清理场景在 Web 和 Electron 均已通过。
- 浏览器完整集成：840 项通过，1 项 scrollbar 点击失败。未修改的基线重复 10 次也出现 5 次相同失败，保留为后续稳定性问题。
- workflows：`just verify ash-workflows` 通过，25 项测试通过。
- App Server：`just verify ash-app-server` 通过，644 项单元测试通过、3 项原有忽略、18 项集成测试通过。最终冻结绑定 2 项测试和警告检查通过。
- 图标字体工具：真实 FontTools 流水线测试通过，检查 TTF 与 WOFF2 输出。
- 改动文件的格式和 `git diff --check` 通过。
- `2ea5892bc` 的 frontend、Rust、codespell、dependencies、Ubuntu 和部分 Trace CI 已通过；protocol、TUI、Bazel 检查失败的具体原因见 [CI 交接](ci-project-todo.md)。其余平台检查仍可能运行中，不能把本次结果写为全部 CI 通过。

## 后续工作

- [ ] 并发开发：持久化状态与目录绑定已发布；专用 Runtime、调度、review/check 执行、RPC/UI 和 SCM 落地还需实现。当前 `/team develop` 明确返回 unavailable，没有伪装成已完成产品功能。
- [ ] CI：根据最新 main 重现并处理 Python metadata/cache、Bazel zlib 地址、离线依赖获取和 V8 绑定问题。已有外部草案未应用，范围与验收入口见 [CI 交接](ci-project-todo.md)。
- [ ] 跨平台 smoke：先取得原三文件补丁并核对哈希，再进行 Windows/macOS 与 Web 验收。原云端报告与逐项命令见 [smoke 交接](smoke-platform-handoff-todo.md)。
- [ ] 调查完整浏览器集成中的 scrollbar 点击偶发失败，保留现有断言。

## 清理与恢复

已删除 45 个额外 Git 工作树及其本地目录、11 个关联分支和 1 个线性历史修复临时分支。另清理 1 个已备份的未注册验证目录。Git 当前仅保留 main 工作树。另已归档并删除 `/Volumes/1t` 下 7 个 Ash 证据与 Bazel 缓存目录，逐文件校验归档内容后才删除原目录。卷根目录仅含空测试目录的 `.build` 也已清除。

恢复资料位于 `/Volumes/1t/ash/.git/worktree-cleanup/20261008/`：

- `recovery-full.bundle`：完整 Git 历史、原分支及未提交内容快照，可独立恢复。
- `audit.json`、`integration-review.json`：逐树范围与旧变体保留原因。
- `cleanup-summary.json`：实际删除的工作树与本地分支清单。
- `external-directory-cleanup.json`、`external-directories/`：7 个外部临时目录的清理清单、压缩归档及逐文件 SHA256。
- 各树的 patch、忽略的源文件和配置，以及 `validation-evidence/` 中的原始验证日志。

这些资料用于恢复原始版本；继续开发使用 main 的现有所有者和较新修复。
