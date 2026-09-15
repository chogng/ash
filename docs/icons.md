# Product Icon System：资源、语义与渲染边界

> 状态：Current。
> 本文拥有跨 Desktop、Rust native 与 renderer 的 product-icon ownership。Canonical SVG
> 文件操作见 [`resources/README.md`](../resources/README.md)，Rust API 与生成路径见
> [`ash-icons`](../app/icons/README.md)。

## 快速理解

Product icon 是 renderer-independent semantic identity，不是某个 component 或 GPU backend
的资源私有类型：

```text
resources/icons/*.svg
  ├─ Desktop generator → private SVG factories → semantic registry → browser SVG renderer
  └─ Rust generator → private artwork → explicit semantic library
                                     → ash-icons
                       → zui PaintIcon → ash-ui-components IconLabel / Button
                       → native product host
```

| 想做什么 | 使用的契约 | 不应该传递什么 |
| --- | --- | --- |
| 在产品界面使用已有图标 | 稳定语义图标 ID | 文件名或原始 SVG |
| 更换图稿但保留含义 | 更新语义 ID 对应的资源 | 要求所有调用方改名 |
| 增加新的产品动作图标 | 显式注册新的语义图标 | 让资源目录自动扩张公共 API |
| 在不同渲染器显示图标 | 各渲染器消费同一语义定义 | 把 GPU 或组件类型放入资源 crate |

## 2. 所有权

| 能力 | 当前 owner | 状态 |
| --- | --- | --- |
| Canonical first-party SVG artwork | `resources/icons` | ✅ |
| Desktop generated SVG factories | `ash-ts/generated/product-icons.ts` | ✅ |
| Desktop semantic registration与resolution | `base/common/icon.ts` / `lxiconsLibrary.ts` | ✅ |
| Rust semantic identity、definition 与 rendering mode | `ash-icons` | ✅ |
| Rust logical placement、tint 与 clip scene contract | `zui::PaintIcon` | ✅ |
| Rust icon+text component geometry | `ash-ui-components::IconLabel` | ✅ |
| Product command 与 icon selection | 各 product host | ✅ |
| Seti file-extension/theme resolution | `ash-ts/src/ash/platform/theme/browser` | ✅，浏览器主题能力 |
| Native symbolic mask、fixed-color atlas 与 render path | `ash-wgpu` | ✅ |

`ash-icons` 不依赖 `zui` 或 `ash-ui-components`。`PaintIcon`、`IconLabel`、`Button` 和 `InputBox` 可以依赖 icon identity，但
资源 crate 不得包含 component、font、layout、theme color、GPU 或 input routing。

## 3. 身份与图稿

- 产品接口传递 `Icon` / `IconId`，不传 filename 或 raw SVG；
- public semantic library 由产品显式登记，不能由 resource filename 自动扩张；
- semantic ID 与 artwork 是多对一关系，允许稳定 alias 和无调用方迁移的 artwork 替换；
- checked-in generated binding 保证 Cargo/Bazel compile action 不运行 generator；
- `IconRendering::Symbolic` 表示整个图标由 caller tint；
- `IconRendering::Multicolor` 表示固定颜色必须保留，同时黑色 symbolic region 可以跟随 caller
  tint；
- renderer 不支持某种 mode 时必须显式失败，不能静默降级为错误颜色；
- resource filename 是 artwork generation input，不是 component API。

## 4. 当前实现

Rust generator 扫描全部 canonical SVG，生成 164 个 crate-private `IconDefinition` binding；
`library.rs` 显式登记与 Desktop `lxiconsLibrary` 对齐的公共 semantic constants、排序后的
`ALL_ICONS` 和 `icon_by_id` lookup。`history → refresh.svg`、`dropdown-indicator →
chevron-down.svg` 等映射证明 semantic identity 不依赖 filename。`Button` 的 icon+text paint
path 复用 `IconLabel`。
`ash-wgpu` 使用共享区域分配的 R8 symbolic-mask atlas 与 sRGB RGBA fixed-color atlas。Symbolic
artwork 只写 mask；multicolor artwork 经 `resvg` 栅格化后，把纯黑 coverage 写入 mask、其余
颜色写入 fixed-color atlas，shader 再把 caller tint 与固定色合成为一个 icon draw。

Native shell 从 `ash-icons::icons` 选择语义 icon，再交给 component；titlebar sidebar toggle
已同时消费 symbolic 与 multicolor artwork。

## 5. 修改路径

```bash
pnpm icons:generate
pnpm icons:check
cargo test --manifest-path Cargo.toml -p ash-icons -p ash-ui-components
```

Desktop 继续运行自己的 generate/check/optimize workflow。新增 SVG 必须同时更新两个 checked-in
generated output；新增公共语义还必须显式更新两个客户端的 library。未来可以把两个 generator
的 discovery/validation 合并为 repository-level tool，但不能让 Rust 或 Desktop build 在编译
阶段隐式改写源码。
