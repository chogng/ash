# `ash-icons`

> 本 README 拥有 Rust 客户端的 product-icon identity、静态 SVG binding 与 rendering-mode
> contract。跨客户端 ownership 由 [`docs/icons.md`](../../docs/icons.md) 定义；canonical
> artwork 操作由 [`resources/README.md`](../../resources/README.md) 定义。

`ash-icons` 是可选的 product semantic catalog crate。通用 renderer-independent icon asset
contract 由 [`zui`](../zui/README.md) 拥有；本 crate 把稳定的语义 icon library 与可替换的
`resources/icons/*.svg` artwork 分层，并明确区分 `IconRendering::Symbolic` 与
`IconRendering::Multicolor`。它不依赖 `ash-ui-components`，也不拥有布局、主题颜色、GPU atlas、
rasterization 或 component。

## 所有权

| Symbol | 可见性 | 精确职责 |
| --- | --- | --- |
| `zui::{IconId, IconDefinition, IconRendering, Icon}` | re-export | 通用 icon asset contract；canonical owner 是 `zui` |
| `library::icons` | private module、显式 re-export | 手工维护稳定的 `icons::*` typed semantic constants |
| `library::ALL_ICONS` | private module、显式 re-export | 按 semantic ID 排序的公共 library catalog |
| `icon_by_id` | public | 只解析已登记的 semantic ID，不解析 artwork filename |
| `generated::artwork` | crate-private、generated | 把全部 canonical SVG bytes 绑定为 `IconDefinition` |
| `generated::ALL_ARTWORK` | crate-private、generated | 供完整性测试覆盖全部 artwork，不构成产品 API |
| `zui::ui::PaintIcon` | external | logical placement、tint、clip 与 renderer submission |
| `ash-ui-components::IconLabel` | external | icon/text component layout |

实际调用与生成关系：

```text
resources/icons/*.svg
  → syncRustIcons
  → generated::artwork
  → library::icons
  → zui::Icon / icon_by_id
  → ash-ui-components
```

`library::icons` 可以让多个 identity 共享 artwork，例如 `HISTORY` 使用 `REFRESH`，
`DROPDOWN_INDICATOR` 使用 `CHEVRON_DOWN`。因此 SVG 文件重命名或替换不要求调用方迁移
`IconId`。新增 SVG 不会自动扩大公共 API；只有产品语义确定后才应在 `library.rs` 登记。
Native input context toolbar 当前登记并消费 `LOCAL`、`WORKING_DIRECTORY`、`GIT_BRANCH` 与
`DIFF`；Native Files toolbar 另外消费 `REFRESH` 与 `SEARCH`，并用文本箭头呈现 upstream
distance；Files pane rows consume `FILES` for branches and `FILE_TEXT` for leaf/search entries。
这些都是稳定语义 identity，不把底层 artwork filename 暴露给 Toolbar 或 file tree。

## 生成与失败语义

新增、删除或重命名 SVG 后运行：

```bash
pnpm icons:generate
pnpm icons:check
cargo test --manifest-path Cargo.toml -p ash-icons
```

`src/generated.rs` 是 checked-in build input，Cargo 和 Bazel 构建都不在 compile action 中运行
generator。图标生成器拒绝不规范的 filename、多 SVG root、active/external content，并根据
固定 paint 判断 rendering mode；`--check` 在 checked-in output 过期时失败。

新增产品语义时更新 `src/library.rs`、`src/icon_tests.rs`，并确认 Desktop
`lxiconsLibrary.ts` 是否应保持同一跨客户端 identity。只替换现有 artwork 时更新 SVG 和生成文件，
不修改 semantic ID。任何 runtime registry、GPU type、component style 或 file-extension matching
进入本 crate 都表示 ownership 漂移；Seti 文件图标解析由 Desktop 的 `platform/theme/browser` 拥有。

当前 crate 能携带 multicolor definition；`ash-ui-components` 使用 fixed-color atlas 与 symbolic-mask
atlas 实现该 contract。跨 renderer 状态和演进见 [`docs/icons.md`](../../docs/icons.md)。
