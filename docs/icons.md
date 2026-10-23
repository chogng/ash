# Product Icon System：资源、语义与渲染边界

## 快速理解

Product icon 是 renderer-independent semantic identity，不是某个 component 或 GPU backend
的资源私有类型：

```text
resources/icons/*.svg
  ├─ Desktop generator → WOFF2 glyphs + dedicated artwork → Lxicon catalog
  │                                                   → iconRegistry → span + ::before
  └─ Rust generator → private artwork → explicit semantic library
                                     → ash-icons
                       → zui PaintIcon → ash-ui-components IconLabel / Button
                       → native product host
```

| 想做什么               | 使用的契约               | 不应该传递什么                  |
| ---------------------- | ------------------------ | ------------------------------- |
| 在产品界面使用已有图标 | 稳定语义图标 ID          | 文件名或原始 SVG                |
| 更换图稿但保留含义     | 更新语义 ID 对应的资源   | 要求所有调用方改名              |
| 增加新的产品动作图标   | 显式注册新的语义图标     | 让资源目录自动扩张公共 API      |
| 在不同渲染器显示图标   | 各渲染器消费同一语义定义 | 把 GPU 或组件类型放入资源 crate |

## 2. 所有权

| 能力                                                    | 当前 owner                                  | 状态               |
| ------------------------------------------------------- | ------------------------------------------- | ------------------ |
| Canonical first-party SVG artwork                       | `resources/icons`                           | ✅                 |
| Desktop generated font definitions and artwork fallback | `src/ash/base/common/productIcons.ts`       | ✅                 |
| Desktop built-in identities and icon definitions        | `base/common/lxicons.ts` / `lxiconsUtil.ts` | ✅                 |
| Desktop semantic registration与resolution               | `platform/theme/common/iconRegistry.ts`     | ✅                 |
| Desktop native font glyph display and artwork fallback  | `base/browser/ui/lxicons`                   | ✅                 |
| Desktop searchable product icon selector                | `base/browser/ui/icons/iconSelectBox.ts`    | ✅                 |
| Desktop product font/artwork theme selection            | `workbench/services/themes`                 | ✅                 |
| Rust semantic identity、definition 与 rendering mode    | `ash-icons`                                 | ✅                 |
| Rust logical placement、tint 与 clip scene contract     | `zui::PaintIcon`                            | ✅                 |
| Rust icon+text component geometry                       | `ash-ui-components::IconLabel`              | ✅                 |
| Product command 与 icon selection                       | 各 product host                             | ✅                 |
| Seti file-extension/theme resolution                    | `src/ash/platform/theme/browser`            | ✅，浏览器主题能力 |
| Native symbolic mask、fixed-color atlas 与 render path  | `ash-wgpu`                                  | ✅                 |

`ash-icons` 不依赖 `zui` 或 `ash-ui-components`。`PaintIcon`、`IconLabel`、`Button` 和 `InputBox` 可以依赖 icon identity，但
资源 crate 不得包含 component、font、layout、theme color、GPU 或 input routing。

VS Code 的 `base/browser/ui/icons/iconSelectBox.ts` 是图标选择控件。Ash 在同路径提供可筛选、
可键盘选择的图标控件。字体字形和专属图稿的挂载、主题更新由 `base/browser/ui/lxicons` 负责。

## 3. 身份与图稿

- 产品接口传递 `Icon` / `IconId`，不传 filename 或 raw SVG；
- Desktop 的 `Lxicon` 提供内置图标入口，`getAllLxicons()` 供产品图标注册表枚举默认定义。产品界面有独立含义时，由所属模块调用 `registerIcon` 声明语义 ID，并以内置图标作为默认图稿；
- 资源文件名可以生成内置图稿 ID，但不能代替产品组件的语义注册；
- semantic ID 与 artwork 是多对一关系，允许稳定 alias 和无调用方迁移的 artwork 替换；
- checked-in generated binding 保证 Cargo/Bazel compile action 不运行 generator；
- `IconRendering::Symbolic` 表示整个图标由 caller tint；
- `IconRendering::Multicolor` 表示固定颜色必须保留，同时黑色 symbolic region 可以跟随 caller
  tint；
- renderer 不支持某种 mode 时必须显式失败，不能静默降级为错误颜色；
- resource filename 是 artwork generation input，不是 component API。

`Lxicon` 当前包含 Ash 已有 SVG 目录和有对应图稿的常用派生 ID（例如 `dialog-error`、
`menu-selection`）。派生 ID 复用字形定义，但可分别配置产品主题覆盖。
`resources/icons/font/manifest.json` 维护只追加的 PUA 码点和源文件指纹；调用方继续使用语义 ID。
普通单色图标以 `span.ash-icon + ::before` 显示 WOFF2 字形，没有 SVG 子树。固定色图稿和
字体加载失败回退使用同一稳定节点内的专属 SVG，产品主题可以覆盖字形或图稿。

## 4. 当前实现

Desktop 的字体成品由共享 `base/browser/ui/lxicons` 拥有。`lxicon.woff2` 保持 IDE 原稿的
轮廓和线宽，默认字重 400；`lxicon-variable.woff2` 为 Agent Window 提供 16px 下的
1.25px 线框轮廓，字体族和字重 550 仅由 `.ash-sessions-window` 选择。两份成品来自
同一套 SVG 和码点清单。只有四个已确认的侧栏字形支持真实粗细插值，其余 Agent Window
字形固定在当前设计线宽，选中不切换实心。

Rust generator 扫描全部 canonical SVG，生成 164 个 crate-private `IconDefinition` binding；
`library.rs` 显式登记与 Desktop `Lxicon` 图稿目录对应的公共 semantic constants、排序后的
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

Desktop 新增或更换 SVG 时，先按 [svg-icon-font skill](../.agents/skills/svg-icon-font/SKILL.md)
运行 `build_product_font.py` 重建字体、码点清单和 TypeScript 定义，再运行 `pnpm icons:check`。
`pnpm icons:generate` 单独生成目录输出，不替代字体重建；普通产品构建不需要 Python 字体工具。

Desktop 继续运行自己的 generate/check/optimize workflow。新增 SVG 必须同时更新两个 checked-in
generated output；新增产品语义应由所属客户端显式注册，跨端共享语义还需更新两个客户端。未来可以把两个 generator
的 discovery/validation 合并为 repository-level tool，但不能让 Rust 或 Desktop build 在编译
阶段隐式改写源码。
