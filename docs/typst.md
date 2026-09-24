# Typst 文档编译

```yaml
status: current narrow integration
owner: ash-rs/utils/typst and ash-rs/app-server
consumers:
  - desktop
lastUpdated: 2026-07-28
```

本文负责跨 crate 的架构与信任模型。编译器实现细节以
[`ash-rs/utils/typst/README.md`](../ash-rs/utils/typst/README.md) 为准。

## 快速理解

Ash 将 Typst 0.15.1 作为 Rust 库嵌入，不调用系统安装的 `typst` 可执行文件。第一阶段能力把
内存中的 Typst 源码字符串转换为当前连接拥有的 PDF 资源。这样既能让 Agent 编辑文本表示并
生成排版后的论文，也不需要授予渲染进程或编译器访问宿主路径的权限。

这项能力补充而不取代 Academic 编辑器。Stanza Document Engine 拥有结构化论文编辑和 Agent 可见的文档
状态；确定性序列化器负责把该状态转换为 Typst 源码；Typst 只负责排版和 PDF 输出。legacy editor runtime
仍然是 Code 产品的编辑器，不属于这条论文处理路径。

| 想完成什么 | 当前能力 | 当前限制 |
| --- | --- | --- |
| 把 Typst 源码编译成 PDF | 已实现内存编译和临时 PDF 资源 | 仅支持单文件源码 |
| 从 Academic 文档生成 Typst | 计划由确定性序列化器完成 | 尚未实现 |
| 在 Workbench 预览 workspace PDF | PDF.js 阅读器 | 已实现；Typst 临时资源尚未桥接到该贡献 |
| 使用本地文件、网络或外部包 | 明确拒绝 | 保持编译器信任边界 |
| 保存最终 PDF | 调用方显式读取并导出 | 临时资源不会自动持久化 |

## 所有权与端到端流程

| 组件 | 职责 |
| --- | --- |
| `ash-typst` | 编译器 `World`、内置字体、源码限制、诊断和 PDF 字节 |
| `ash-app-server-protocol` | `document/typst/compile` 数据结构与能力协商 |
| `ash-app-server` | 请求分发和当前连接拥有的 PDF 资源创建 |
| Desktop Main/Preload | 精确 IPC 校验和类型化能力桥接 |
| Academic Workbench 贡献 | Stanza Document Engine；未来的 Typst 序列化、诊断、预览和保存/导出 |

计划中的 Academic 渲染流程如下；序列化器和把临时资源打开到 PDF 阅读器的桥接尚未实现：

```text
Academic Stanza 文档
→ 确定性 Typst 序列化器
→ Typst 源码字符串
→ 沙箱化 Preload API：typst.compile
→ 可信 Electron Main IPC 路由
→ document/typst/compile
→ ash-typst 内存 World
→ PDF 字节
→ App Server ResourceStore
→ resource/read 分块读取
→ Workbench PDF 预览或显式导出
```

编译失败返回 `{ status: "failed", diagnostics }`。编译成功返回
`{ status: "success", resource, warnings }`。生成的资源使用 `application/pdf`，生存期为
300 秒，大小上限为 16 MiB，由当前连接拥有，并沿用现有的 Base64 分块读取契约。

## 安全性与确定性

当前不变量：

- 源码按 UTF-8 字节计算，最大 1 MiB；
- 只存在虚拟文件 `/main.typ`；
- 拒绝其他项目文件和包；
- 不访问网络，也不下载 Typst Universe 包；
- 不加载系统字体或任意字体文件；
- 不能读取当前日期；
- PDF 字节从不获得宿主路径，并始终由当前连接拥有；
- Typst 及其直接依赖精确固定在 0.15.1。

渲染进程沙箱与编译器边界解决的是不同问题。Electron 沙箱限制渲染进程权限；
`InMemoryWorld` 限制 Typst 源码可以向 Rust 宿主请求什么。两层边界都必须保留。

## 当前状态

已实现：

- 使用内置字体把 Typst 编译为 PDF；
- 类型化 App Server 方法、能力、诊断和生成产物；
- Desktop Preload API 以及资源元数据、读取和释放接口；
- Academic Stanza 文档编辑器面板和产品级注册；
- 上游 Typst 与内置字体许可证声明；
- PDF 输出、诊断、所有权和宿主文件访问拒绝的单元及集成测试。

当前限制：

- 不支持多文件项目、图片、参考文献、包导入、系统字体、增量编译、取消或强制 CPU 截止时间；
- 尚无 Stanza Document Engine 到 Typst 的序列化器、诊断投影，或将 Typst 临时资源打开到 PDF 阅读器的桥接；
- 调用方显式读取并持久化前，输出只是临时资源；
- 编译当前同步执行，方法被声明为全局独占。

## 分阶段演进

近期计划先实现确定性的 Stanza Document Engine 到 Typst 序列化器，再把诊断投影回结构化文档，并把
返回的临时 PDF 资源交给现有阅读器。

多文件论文后续应使用有大小限制、不可变的内存文件映射。参考文献和图片只能通过显式资源类型、
总字节数与数量限制、规范化虚拟路径以及无法逃逸项目根目录的测试接入。

如果确实需要包支持，必须另行定义版本固定、下载权限、缓存完整性、许可证声明、离线行为以及
恶意 WASM/插件隔离策略。这些不属于当前能力。
