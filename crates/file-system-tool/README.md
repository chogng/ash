# ash-file-system-工具

> 本 README 是 model-visible filesystem adapter 的 canonical 实现文档。共享 filesystem
> authority 见 [`../file-system/README.md`](../file-system/README.md)，跨客户端 ownership
> 见 [`../../docs/ash-desktop-architecture.md`](../../docs/ash-desktop-architecture.md)。

本 crate 只把 `ash-file-system` 适配为 model-visible `file-system` Tool。它拥有 Tool
definition、binding 校验、UTF-8 text 解码和输出上限；不拥有宿主 filesystem access、
directory confinement、App Server RPC、mutation 或 watcher。

## 公共契约与内部接口

| Symbol                                    | 可见性  | 职责                                                                      |
| ----------------------------------------- | ------- | ------------------------------------------------------------------------- |
| `FileSystemTool`                          | public  | 持有 environment binding、共享 filesystem、limits 与 immutable definition |
| `FileSystemLimits`                        | public  | 非零 read/list bounds；默认 64 KiB 与 1,000 direct entries                |
| `FileSystemToolError`                     | public  | construction-time limit/definition failure                                |
| `FileSystemInput` / `FileSystemOperation` | private | deny-unknown-fields 的 `read`、`list`、`metadata` input                   |
| `validate_invocation`                     | private | cancellation、environment、exposed name 与 definition digest binding      |
| `file_system_definition`                  | private | provider-facing function schema                                           |
| `returned_json` / `returned_error`        | private | `ToolExecutionOutcome` 编码与 success/error 分类                          |

调用路径：

```text
ToolExecutor::execute
→ FileSystemTool::run
→ validate_invocation
→ decode_arguments<FileSystemInput>
→ read | list | metadata
→ Arc<dyn FileSystem>
→ ToolExecutionOutcome
```

`read` 要求 foundation 返回的 bytes 是有效 UTF-8 text；binary content 返回 Tool error。
`list` 在 foundation 已排序的 direct children 上截断并返回 `truncated`。`metadata` 不返回
`modified_at_millis`，因为当前 Tool output contract 未声明该字段。

## 失败、接入与验证

取消只在执行开始前观察。binding/environment mismatch 返回 `NotStarted`；输入、filesystem、
UTF-8 与编码 failure 返回正常完成的 error `ToolOutput`。底层 filesystem error 会进入
Agent-visible Tool error，不能把该适配器直接复用为 external client error boundary。

Host 必须显式创建 `FileSystemTool` 并注册到对应 environment 的 Tool registry；crate 存在
不代表当前 runtime 已自动暴露该 Tool。

```text
cargo test -p ash-file-system-tool
bazel test //crates/file-system-tool:file-system-tool-unit-tests
```

修改 operation/schema 时同步更新 schema binding tests；修改 foundation trait 时同步检查
`ash-file-system` 与 App Server adapter。若本 crate 开始直接调用 `std::fs`、持有
`Dir`、`Grant` 或目录 confinement、实现 client RPC 或维护目录展开/刷新状态，即表示 ownership 漂移。

## 当前限制与潜在方向

- Current：只读 text/list/metadata，单次同步 foundation call。
- Current：list 最多输出 configured direct entries，不分页。
- Potential：binary/resource output、streaming 或 richer metadata 需要先扩展 Tool output
  contract；这些不是当前能力承诺。
