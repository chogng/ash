# `ash-typst`

> 本 README 负责内存编译器边界的实现细节。跨进程所有权、产品语义和分阶段演进以
> [`docs/typst.md`](../../../docs/typst.md) 为准。

`ash-typst` 把调用方提供的一段 Typst 源码编译为 PDF。它拥有 Typst `World` 实现，明确不
提供操作系统文件系统、包注册表、网络、环境变量或时钟访问。

## 边界与公共契约

`TypstCompiler` 缓存 Typst 标准库、内置字体和字体目录。`TypstCompiler::compile` 借用 UTF-8
源码并返回：

- `TypstCompileOutcome::Success`：PDF 字节和非致命诊断；
- `TypstCompileOutcome::Failed`：普通源码错误或 PDF 生成诊断；
- `TypstCompileError::SourceTooLarge`：源码超过 `MAX_TYPST_SOURCE_BYTES`，即按 UTF-8 字节
  计算的 1 MiB。

源码错误属于编译结果而不是基础设施错误，因此 UI 无需解析内部错误字符串即可展示。诊断范围
使用半开区间，表示提交源码中的 UTF-8 字节偏移。

本 crate 不拥有 RPC 数据结构、PDF 资源保留、编辑器模型、预览 UI 或文档持久化。

## 内部所有权与调用路径

```text
TypstCompiler::compile
|- 大小校验
|- InMemoryWorld::new(source)
|- typst::compile
|  `- World::{source,file,font,today}
|- map_diagnostics
`- typst_pdf::pdf
```

关键私有符号：

- `InMemoryWorld` 把 `/main.typ` 绑定到提交的源码。`source` 和 `file` 对其他所有 `FileId`
  返回 `FileError::AccessDenied`；修改该行为会改变信任边界，必须同步更新测试和
  `docs/typst.md`。
- `map_diagnostics` 移除 Typst 内部类型，并通过 `WorldExt::range` 转换范围。把该转换移到
  Desktop 会让编译器依赖越过进程边界。
- `TypstCompiler::{library,book,fonts}` 拥有可复用的不可变编译器状态。单份文档的可变状态
  属于 `InMemoryWorld`。

`today` 始终返回 `None`，使编译结果不依赖宿主时钟。Typst 文档请求当前日期时会得到源码诊断。

## 字体与许可证

`typst-assets` 的 `fonts` 功能提供当前固定字体集。`ash-typst` 仍受仓库根目录 `LICENSE`
约束；上游 Apache 许可证不会改变这一自有包装层的许可证。

本集成拥有的上游许可证文本位于 `licenses/`：

- `Typst.txt`：Typst 使用的 Apache-2.0 许可证；
- `Typst-NOTICE.txt`：Typst 要求保留的第三方声明；
- `Typst-Assets-NOTICE.txt`：内置字体和其他 `typst-assets` 材料的许可证与声明。

Desktop 发布包还必须携带 `app-ts/THIRD_PARTY_NOTICES.md`，并从本目录的权威文件把对应许可证材料复制到发布 staging。源码树不保存第二份副本；改变 Typst 版本、资源功能或字体来源时，必须重新审查许可证材料并检查确定性输出。

## 测试与修改影响

```text
cargo test -p ash-typst
```

测试覆盖 PDF 输出、带范围的诊断、宿主文件访问拒绝和源码字节上限。修改公共结果类型时，还要
重新生成协议样例，并运行 App Server 与 Desktop 测试。修改文件或包访问前必须更新威胁模型。

## 当前限制与扩展点

当前只接受 `/main.typ`，尚不支持图片、参考文献、多文件项目、Typst Universe 包、系统字体、
取消、执行时间限制或增量编译。

下一扩展点是由 App Server 提供不可变、有大小限制的内存项目文件映射，不能通过接受宿主根路径
实现。启用不可信的长时间任务前，还必须先设计取消以及工作进程/进程隔离。
