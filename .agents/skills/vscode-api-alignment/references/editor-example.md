# Editor 对齐

仅在目标位于 `ash-ts/src/ash/editor` 时读取。Editor 与其他 TypeScript 范围使用相同的非对称对比规则，不启用额外的严格模式。

## 对应范围

- 本地根目录：`ash-ts/src/ash/editor`
- 上游根目录：`../vscode/src/vs/editor`
- 目标：VS Code 已有而 Ash 缺失的生产文件和公开 API 持续补齐；Ash 已有而 VS Code 没有的文件和公开 API 交由用户决定；对应实现承担相同公开契约、职责、状态所有权、生命周期和调用链。CSS 参与文件集合和可观察行为核对，但由 Ash DOM、品牌 class 与主题系统独立实现。
- `editor` 可以依赖 `base`、`platform` 和自身更低运行环境的模块，不为“自包含”复制这些能力。运行环境与职责归属按[代码组织规范](../../../../.github/instructions/source-code-organization.instructions.md)分别判断；`common` 不使用 DOM，不代表所有无 DOM 代码都归 `common`。

## 批量调查示例

用户指定 Editor 目录或同一目录下多个文件时，首次调查直接批量取得该目录双方文件集合、imports、exports、生产调用方和测试。输出过大时按结果维度拆分，不逐文件暂停。

修改前保存工作树来源基线，并对整个目标目录分类同路径、仅 Ash、仅 VS Code 和大小写差异。只有进入当前依赖闭合切片的仅 VS Code 项才在对应路径建立文件：先对齐 API 名称与职责，再独立实现逻辑并把调用方 import 一次迁入；其余缺失项只记台账。双方已有文件直接原地修改。尚无决定的仅 Ash 项完成整批调查后一次性请求用户决定，已有决定的 Ash 专属归属按确认职责继续使用。

Editor 浏览器改动开始前必须单独写出当前 `View`/ViewPart 的状态 owner、DOM owner、滚动与输入入口、布局坐标来源和 render 生命周期。上游构造函数或 ViewPart 拆分不能反向要求 Ash 更换这些 owner；若公开签名与本地模型冲突，先对齐其依赖的本地 owner 并用一个最小行为切片验证，禁止同时重做 DOM wrapper、滚动状态和全部调用方。

“成员差异为零”与“同路径文件数量增加”都不是 Editor 进度。先证明焦点、滚动、指针、布局、渲染失效和释放至少一条真实链路不退化，再扩大到用户要求的批量；类型检查只能在这之后证明契约没有断裂。

## 对齐端口与实施顺序

Editor 不从“上游缺哪些文件”开始写，而从当前要保住的用户行为入口开始追生产链。先找 `CodeEditorWidget`、输入入口或已有 contribution 的真实调用，再确认 `ViewModel`、`View`、controller、model 中谁拥有状态和副作用；沿依赖向下收敛到一个可以单独测试的公开端口，完成后再向上迁移调用方。依赖顺序固定为基础契约与命令 → 纯操作 → 状态控制器 → 运行环境入口 → contribution，不能从 contribution 倒着补出一套上游对象图。

候选文件只有同时满足以下条件才能进入修改批次：

- 位于当前生产调用链上，并且直接调用方已经找到；
- 它依赖的状态、DOM、坐标和生命周期 owner 已经明确，且不经过尚未确认的仅 Ash 载体；
- 改动会收敛到唯一实现，而不是新增 wrapper、alias、平行 controller 或新旧 API 双轨；
- 有一个能直接触发该职责的现有测试，或能先补出最小行为测试。

VS Code 有而 Ash 缺失的文件在调用链到达时直接按同路径创建；尚未到达时只写入台账。双方都有的文件只改本批职责，不删除整文件重写，也不把未涉及的 Ash 专属行为顺手改成上游结构。仅因文件清单发现某个外围调试 decoration、贡献或 CSS 缺失，不构成创建理由。

批量要求用于方向已证明后的调用方迁移，不用于同时探索十个 owner。一个端口的最小行为测试通过后，可以一次迁移十个以上同类调用方；若其中任何调用方暴露新的状态 owner、DOM owner 或未确认的仅 Ash 文件，就把该分支留在台账，继续完成已闭合部分。

### Editor 端口反例

`contrib/format/common/formatCommands.ts` 同时承载 provider 类型和请求调度时，不能因为它没有 DOM 就认可整个文件的归属，也不能把整个文件移入 `browser`，使公共 registry 和宿主适配器反向依赖浏览器功能。应按以下职责核对本地与上游：

| 职责 | 对应 owner |
| --- | --- |
| 格式化选项、文档/范围/输入格式化 provider 契约 | `editor/common/languages.ts` |
| 共享 provider registry | `editor/common/services/languageFeatures.ts` |
| provider 选择与格式化请求编排 | `editor/contrib/format/browser/format.ts` |
| 命令注册与编辑提交 | `formatActions.ts`、`formattingEdit.ts` |

先沿注册入口和实际请求核对公共契约，再迁移贡献与适配器调用方、测试和旧入口。只补 `formatActions.ts` 等同路径文件，却让公共 registry 继续从贡献导入 provider 类型，不能算职责对齐。此表是迁移目标，不代表 Ash 已完成这些迁移；代码现状见[对齐台账](../../../../ash-ts/src/ash/editor/api-alignment-status.md)。独立的 schema、序列化或协作算法仍按其实际职责判断，不按上游是否存在 `common` 目录一律搬迁。

`editor/common/commands/editorEditCommand.ts` 在 VS Code 没有同路径文件，因此不能为了集中 selection、history 或 edit helper 自行创建，再让标准 Editor 命令反向依赖它。除非用户明确确认它是 Ash 专属 owner，否则应把公开契约和实现收敛到真实存在的标准命令、cursor 或 model owner，并让这个仅 Ash 文件保持不存在。

`workbench/contrib/debug/browser/debugBreakpointDecorations.ts` 同样不是 VS Code 同路径文件。即使断点装饰行为确实需要实现，也不能在 Editor 对齐批次里因为“上游附近有类似能力”而创建或改造它；先暂停并取得用户对这个仅 Ash 路径及职责的决定，再由独立的 Workbench 调用链证明其 owner、消费者和测试。

`EditorScrollbar.getDomNode()` 在上游成立，是因为对应类拥有整体 scrollable wrapper。若 Ash 同路径类只拥有附着在 `View` 根节点上的水平、垂直轨道，返回 `View` 根节点会谎报 DOM owner，为补这个成员新造 wrapper 又会改变已经验证的布局与滚动模型；此时该成员必须留在台账，直到真实生产调用链需要它且正确 owner 已对齐。

同理，`delegateVerticalScrollbarPointerDown` 或 `delegateScrollFromMouseWheelEvent` 不能因为上游公开就直接加到同名类。只有当 Ash 的 diff overview、gutter 等生产调用方同批迁入，并且事件确实复用现有唯一的滚动状态和轴输入实现，且指针或滚轮行为测试观察到编辑器滚动时，才算可进入修改批次。只有同名 method、没有生产调用方，属于假对齐。

遇到这种 owner 不兼容后，不得改选另一个 public-member 差异更少的类继续补数量；回到当前用户行为入口，向下寻找尚未闭合的状态、输入或布局依赖。成员比较输出只更新台账优先级，不能替代这一步。

## 专用检查

默认运行：

```powershell
node .agents/skills/vscode-api-alignment/scripts/check-editor-alignment.mjs
```

该入口依次执行：

- `verify-editor-api-ledger.mjs`：从摘要读取总数，验证台账的唯一声明及已处理/待处理数量；
- `audit-editor-file-set.mjs`：审计整个 Editor 生产文件集合；
- `audit-editor-css-ownership.mjs`：阻止完全复制的上游 CSS、上游产品 root 和本批新增的上游品牌词汇，并报告仅做品牌替换的 CSS；
- `compare-editor-api-members.mjs`：按台账中的同名声明报告成员名差异；
- `git diff --check`；
- 仓库 `typecheck:stanza`；
- 检查运行前后是否新增未跟踪 `.js`。

需要完整逐文件输出时使用 `--full`。仅做修改前结构调查时可以使用 `--structure-only`。最终验证必须显式选择测试：无浏览器依赖的职责使用 `--test=unit`，浏览器职责使用 `--test=browser`，同时影响两类运行环境时使用 `--test=all`。不带 `--test` 的成功结果只代表结构与类型检查完成。

成员名报告只用于缩小人工核对范围。缺少的上游成员进入待补队列；尚无决定的仅 Ash 成员必须请求用户决定，已有决定的 Ash 专属 API 按确认职责检查。差异为零仍需检查签名、可见性、继承、owner、行为和调用链。

成员比较按声明 owner 计数：上游在当前类声明的公开或 protected 成员可以由本地基类继承满足，但本地基类自己的额外成员不在每个子类上重复记为新增。检查器必须解析 Editor 范围内的继承关系；不得为了让只读报告归零，在子类中添加只调用 `super` 的转发方法。

CSS ownership 报告同样不能代替人工判断。`upstream-equivalent after branding` 表示文件主体仍与上游一致，必须作为待清理项报告，不能因为 root 已改名就计为本地独立实现。新增 CSS 前先从对应 TypeScript DOM 创建点确认 owner 和稳定 class，再使用 Ash 主题 token 实现并以真实浏览器计算样式验证。

历史上未触及的 branding-equivalent CSS 作为债务报告；本次改动后仍属于该分类的 CSS 是阻断项。目标包含 CSS 时用 `--full` 查看准确路径，并确认目标文件不在 `changed CSS equivalent after branding` 中。

## TypeScript 输出边界

`ash-ts/tsconfig.renderer.json` 必须保持 `noEmit: true`，Stanza 与扩展检查配置继承该不变量。只有负责生成产物的构建或测试配置可以启用输出，并必须把 `outDir` 明确设置在源码树外。

## 完成判定

一项 Editor API 只有在下列事实同时成立后才能从待处理表移入已处理表：

- 文件和 owning module 对应；
- 公开名称、签名和调用方对应；
- 状态、失效、调度、坐标、副作用、错误和释放职责对应；
- 生产调用真实经过对应 owner；
- 能直接触发该职责的本地独立行为测试通过，并在结果中列出测试名称；
- 涉及 CSS 时，Ash root、状态 class、主题 token、高对比度和计算样式均通过真实浏览器验证，且 CSS ownership audit 没有阻断项；
- 专用检查入口通过。

仅 Ash 文件或公开 API 必须先取得用户决定；确认作为 Ash 专属归属后可以承接确认范围内的职责。调用方归零或 VS Code 不存在对应项都不能代替该决定。

当前 `test:editor:unit` 的编译范围还包含 Sessions 和聊天模块；若它被范围外类型错误阻塞，必须原样报告，不能把测试记为通过，也不能为了绕过错误使用跳过类型检查的执行方式。此时仍可运行独立的浏览器测试或更小的现有定向入口，但不能用无关测试替代受影响行为。
