---
name: svg-icon-font
description: Import or update Ash UI icons from SVG sources, build static or variable WOFF2 fonts with explicitly classified solid-color layers, and integrate semantic glyphs with the icon registry and themes. Use for SVG icon imports, icon-font migrations, and independent Snapshot extension toolbar icon changes; complex illustrations remain with their image consumers.
---

# SVG 图标 → WOFF2

用户只需提供或导入 SVG。Agent 负责归一化轮廓、维护稳定映射、生成 WOFF2、接入真实消费者并验证效果。产品 UI 图标以 SVG 为可编辑源，以 WOFF2 字形为运行时目标；脚本与构建依赖集中在本 skill 下，字体成品放在消费它的组件旁。客户端边界见 [Product Icon System](../../../docs/icons.md#3-身份与图稿)。

## 窗口外观约束

后续新增、替换或重建 SVG 图标均遵守以下约束：

- **IDE 和 Agent Window 都使用 SVG 生成的 WOFF2**，共用图标注册、主题解析与字体 renderer。
- **IDE 保持原 SVG 的外观**：保留轮廓、线宽、尺寸和留白，静态字体默认字重为 400。400 是字体的常规字重标识，不要求把不同原稿的线宽统一成某个数值；不得因格式迁移调整 IDE 的粗细。
- **Agent Window 独立调整粗细**：专用字体选择和字重设置限定在 `.ash-sessions-window`，不修改共享默认值或影响独立 IDE 窗口。单色线性图标统一为 16px 下的 1.25px 设计线宽。后续调整遵循 [Sessions STYLE.md](../../../src/ash/sessions/STYLE.md)。
- 用户只提供一套原始 SVG；需要可变粗细时由 Agent 生成兼容母版，不要求用户另交 Agent Window 专用的 bold SVG。

## 导入与字形约定

- 保留 `resources/icons/` 的 SVG 原稿、语义 ID 和原有许可。构建到 `.build/`，校验通过后再替换组件使用的 WOFF2；不要让普通产品构建依赖 Python 或现场转字体。
- 在拥有该字体的清单中显式记录 `id → Unicode PUA → SVG`。新增码点只追加，不因文件排序、删除或重命名重新编号，不复用已有码点。业务调用方仍用语义 ID，不使用裸字符。
- 标准单元是 16px，设计留白来自 viewBox。归一化保留长宽比和留白，不按路径包围盒重新放大。平方 advance、ascent=UPM、descent=0、lineGap=0；每个母版在计算变体差值**之前**使用真实 `xMin` 作为 LSB，避免变粗时横向漂移。
- 先展开描边、端点、连接和变换，再把填充轮廓编进字体。描边在字体单位精度下展开；直接在小 viewBox 坐标中调用 Skia stroker 会粗化圆弧。不能直接丢弃 SVG 的 `stroke`；不能用 CSS 伪粗体或文字描边冒充真实字重。字体层使用 `font-synthesis: none`。
- 多色、透明度和品牌颜色不得静默变成黑色。产品构建器从归一化图层识别固色与透明度，在字体清单的 `color` 中记录分类；`COLOR_GLYPHS` 保留已知图标的语义说明。用 COLRv1/CPAL 保留逐层轮廓、固定颜色、前景色与透明度。分组透明度、渐变等超出转换器能力的内容必须显式失败，由真实图片消费者处理，不要求用户另交字体文件。

## 构建普通 SVG

在隔离 Python 环境安装 `requirements.txt`。`scripts/build_font.py` 用 picosvg 展开描边与变换、统一填充，再用 FontTools 生成静态 WOFF2。它验证 SVG 子集与单色约束，不负责推导可变字重。

清单路径相对其所在目录；`glyphs` 顺序不决定码点，例如：

```json
{
  "family": "Ash UI Icons",
  "glyphs": [
    { "id": "add", "unicode": "E001", "source": "../add.svg" },
    { "id": "code", "unicode": "E002", "source": "../code.svg" }
  ]
}
```

```sh
python3 .agents/skills/svg-icon-font/scripts/build_font.py path/to/manifest.json --out .build/icon-font
python3 -m http.server 8765 --bind 127.0.0.1 --directory .build/icon-font
```

输出包括静态 TTF（检查用）、WOFF2、归一化 SVG、清单副本、验证结果和真实字体预览 `index.html`。复制到产品时只带消费者需要的字体成品和映射；检查原清单的既有码点没有漂移。

## 构建可变粗细

WOFF2 是字体封装，不代表字形可变。用户要求可变粗细时，由 Agent 从可恢复的描边中心线生成对应母版，或维护已经确认的兼容母版。实心轮廓不能可靠反推中心线时，说明该字形暂为静态；不要把同一轮廓复制两份并宣称已支持粗细变化。

粗细母版使用相同轮廓数、顺序、点对应和曲线拓扑。按 [variable-iconfont](../variable-iconfont/SKILL.md) 执行兼容性检查和编译；该脚本只编译已展开的轮廓，不会替 SVG 展开描边。曲线转二次曲线也必须保持母版间兼容。

当前侧栏的已确认构建入口是：

```sh
python3 .agents/skills/svg-icon-font/scripts/build_sidebar_variable.py
```

它是 New、Code、Projects、Automations 四个字形的专用构建器，不能把任意新 SVG 塞入列表后就声称通用转换成功。它输出并验证 `wght=400…700`，在 16px 下设计线宽为 1…1.5px，550 对应当前选定的 1.25px。母版只写入 `.build/`；单独运行此命令不会替换产品字体。

## 重建产品字体

```sh
pnpm icons:build
```

该入口调用 `build_product_font.py`，按需在 `.build/product-icon-font/venv` 准备隔离依赖，在临时目录归一化 `resources/icons/*.svg`，维护 `resources/icons/font/manifest.json` 中只追加的码点、颜色字形分类和源文件指纹，分别构建 IDE 原始字形字体与全量 Sessions 字体，再更新共享 renderer 旁的 `src/ash/base/browser/ui/lxicons/{lxicon,lxicon-variable}.woff2` 和 `lxiconsLibrary.ts` 码点注册。全部校验成功才发布有变化的文件；转换期间收到新输入时丢弃旧快照并重建，失败保留已发布产物。多个开发服务器和手动入口共用文件锁。

`productIconsPlugin` 是已确认的 Ash 开发期入口：监听 SVG、Sessions 配置和字体构建器，调用同一资源编译器，成功后刷新页面；不另写一套字体生成规则。生成文件不作为监听输入，输入与产物指纹相同则不重建、不改写或刷新。插件只在 Vite serve 使用，普通产品打包不安装字体工具。开发服务器未运行时先运行上述命令，再运行 `pnpm icons:check`；普通图标目录生成仍拒绝与字体指纹不一致的原稿。

`scripts/build_sessions_font.py` 按 `resources/icons/font/sessions.json` 生成 Sessions 专用轮廓。普通描边按目标线宽展开；以填充路径导出的线框必须在 `outlinedFills` 中显式分类，并确认原线宽；遮罩内侧描边通过 `insetStrokes` 校正可见宽度。账户头像、停止方块等需要取消实心的几何形状由 `outlineShapes` 选择轮廓；与已有描边重合的实心装饰由 `omitShapes` 排除。索引是排除 defs/mask/clipPath 内容后的可见几何元素顺序，从 0 开始。新增或替换 SVG 时同步核对分类，保留必要细节与品牌造型，不从任意填充图形猜测中心线。

全量 Sessions 字体保留已确认四字形的真实可变数据，其余字形固定在 1.25px 设计轮廓，不宣称这些固定字形支持粗细插值。`*-filled` 保留其语义对应的实心图稿；IDE 的码点和原字形保持不变。

## 接入 Ash 与 VS Code 对齐边界

- 宿主 UI 先追踪 `Lxicon` / `registerIcon` → 图标定义 → `appendIcon` / `IconLabel` → 产品主题解析器的真实调用链。沿用现有语义 ID、别名、modifier、主题覆盖与窗口生命周期，在唯一 renderer/registry owner 解析字形；不要逐按钮硬编码 PUA 或添加每个图标一条 DOM 探测选择器。
- `build/resources/icons/generate.ts` 从已准备的字体清单生成 `lxiconsLibrary.ts`，直接注册稳定码点。普通字形和颜色字形走同一注册与渲染契约。共享 renderer 使用 `span.ash-icon + ::before` 显示原生字体字形，字体字符只存为数据属性，不进入标签文本；保留语义 class、modifier 和挂载节点。消费者通过 `font-size` 选择 12/16/24px 字形尺寸，点击区域仍由控件拥有。
- VS Code 对齐的是稳定图标注册、字体族/字符定义、主题覆盖与调用语义。WOFF2 可以承载 TrueType/OpenType 字形和可变表；选择 WOFF2 无需改为 TTF，也不会自动对齐 TypeScript API 或字形设计。做公共 API 迁移时使用 [vscode-api-alignment](../vscode-api-alignment/SKILL.md)，以本地 `../vscode` 为只读参照。
- `IconDefinition` 只表示准备好的字体字形。品牌花朵的九个动画层由资源构建器从唯一原稿拆分，运行时仅消费层码点和变换中心；组件拥有动画时序。原生光标需要图片 URL 时，从已加载的窗口字体光栅化，不能重新读取或改写 SVG 原稿。产品图标主题只加载字体与码点，SVG 不进入其 schema、解析器或渲染分支。
- 字体图标继承 `currentColor`，隐藏装饰性字符的可访问内容，保留按钮名称、键盘焦点和选中状态。由浏览器按窗口样式加载字体，IDE 不预加载 Sessions 字体；不保留普通图标的 SVG 字符串、回退闭包或逐图标字体加载检测。缺少或过期的字体清单必须在生成阶段失败，不能生成纯 SVG 目录替代字体。

## 验证

1. 检查 WOFF2 解码后的 cmap、非空轮廓、固定 advance、LSB 与边界；颜色字体检查 `COLR`、`CPAL`、前景色 palette index 与透明度；可变字体额外检查 `fvar`、`gvar`，并实例化 400、475、550、625、700，确认面积/线宽变化和位置稳定。
2. 通过本地 HTTP 预览加载**实际 WOFF2**，对比原 SVG 与生成轮廓，检查孔洞、描边、曲线和16px可读性。颜色字形在深浅主题下对比实际字体与 SVG 的像素，验证固定色与前景色。覆盖兼容性通过不等于外观通过。
3. 有产品接入变化时，在 Ash 的真实消费者核对实际 WOFF2 加载、尺寸、颜色、选中/禁用、深浅与高对比主题、键盘与可访问名称，以及专属图稿；共享宿主图标变化同时检查 IDE 与 Agent Window 的外观隔离约束。使用已有组件/浏览器测试和必要的自托管 UI 检查；不为纯尺寸检查新增全应用 smoke 测试。
4. 运行 `pnpm icons:check`（原稿或注册变更时先 `pnpm icons:generate`）、相关类型/样式检查。只有文档或脚本搬迁时，运行新路径命令、核对输出和链接即可。

维护脚本时运行 `python3 .agents/skills/svg-icon-font/scripts/test_build_font.py`，覆盖描边孔洞、曲线与组变换、evenodd、稳定映射和不能保真的输入。脚本本身不替代产品 UI 验证。

## Learnings

### Snapshot 工具栏独立图标

- Snapshot 的截图工具栏运行在隔离 Webview 中，不能继承宿主文档的字体，也不能导入宿主 UI 模块；它使用包内 `AshSnapshotIcons.woff2` 和独立的[语义映射清单](../../../extensions/snapshot/media/icons.json)。这份字体是插件资源边界的实现选择，不是截图功能或系统权限的要求。
- 只调整插件图标时，修改该清单的 `source`，保留既有 `id` 和 `unicode`；例如仅替换 `pen` 的图稿，可将 SVG 放入 `extensions/snapshot/media/icons/pen.svg` 并将其 `source` 指向 `icons/pen.svg`。需要专属外观时使用包内 SVG，不修改 `resources/icons/` 的共享原稿，也不重建 IDE 或 Sessions 字体；仍复用共享外观时可继续引用现有原稿。
- 按钮的语义绑定由 [screenshotEditor.ts](../../../extensions/snapshot/browser/screenshotEditor.ts) 消费清单，字体、尺寸和布局由 [screenshotEditor.css](../../../extensions/snapshot/browser/screenshotEditor.css) 拥有。工具栏保持纯图标按钮，保留本地化 tooltip、可访问名称、焦点和状态；仅更换图稿无需逐按钮修改字符。

使用已安装本 skill `requirements.txt` 的隔离 Python 环境，从仓库根目录重建；先检查生成预览和验证结果，再复制字体成品：

```sh
python3 .agents/skills/svg-icon-font/scripts/build_font.py extensions/snapshot/media/icons.json --out .build/snapshot-icons
# 完成上述字体与预览检查后执行：
cp .build/snapshot-icons/AshSnapshotIcons.woff2 extensions/snapshot/media/AshSnapshotIcons.woff2
```

- 扩展资源变更后，按自托管流程构建并运行 `pnpm prepare:backend`，确保 Ash 使用新打包的扩展资源；仅更新 renderer 可能仍加载旧工具栏。复用 [Snapshot 组件测试](../../../extensions/snapshot/test/browser/snapshot.test.ts) 和 [原生截图 smoke](../../../test/smoke/areas/chat/chat-screenshot.spec.ts)，在真实截图窗口框选后检查工具栏及字体实际加载，并保留截图证据。
- Webview 打包会将字体内联为 `data:` URL，原生 [imageView.html](../../../src/ash/code/electron-browser/imageView/imageView.html) 的 CSP 必须保留 `font-src 'self' data:`；普通浏览器组件测试不能替代这层验证。这是应用内部字体加载策略，不是用户授权弹窗或系统屏幕录制许可；替换字形无需增加授权流程，也不要为字体放宽脚本或网络策略。
