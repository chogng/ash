# Typst 第三方许可证文本

本目录保存随 `ash-typst` 分发的上游 Typst 组件和资源的许可证及声明文本。它不定义 Ash 或
自有 `ash-typst` 包装层的许可证；后两者仍受仓库根目录 `LICENSE` 约束。

这些文件对应根目录 `Cargo.lock` 固定的 Typst 与 `typst-assets` 版本：

- `Typst.txt`：Typst 的 Apache-2.0 许可证文本；
- `Typst-NOTICE.txt`：Typst 携带的第三方声明；
- `Typst-Assets-NOTICE.txt`：内置字体和资源的许可证与声明。

本目录是这些材料在仓库中的唯一权威来源。Desktop 发布流程从这里复制所需文件进入发布 staging，不在 `app-ts/licenses/` 保存第二份源码副本。Typst 依赖、功能、字体或资源变化时，必须重新审查上游许可证材料。
