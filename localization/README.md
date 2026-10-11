# 界面语言

界面语言在启动时确定。`workbench.locale` 保存下一次启动使用的语言；选择语言后，可立即重启或稍后重启。当前窗口不重新翻译已经创建的界面。

Electron Main 在创建窗口前读取语言资源，Workbench、Sessions 和系统菜单使用同一份启动快照。刷新 Electron 的单个窗口不会重新读取语言偏好。Web 的每次页面启动先读取浏览器设置和语言资源，再加载贡献注册模块。

## 文案来源

- 普通文案在功能代码中调用 `localize(key, 'English message')`。
- 命令标题等同时需要英文原文和译文的地方调用 `localize2(key, 'English message')`；返回 `{ original, value }`，两者都在调用时确定。命令面板显示译文，并支持按英文原名、译文或命令 ID 搜索。
- 跨 bundle 的文案使用 `{ bundle, key }`。已有 bundle/key 是稳定标识，不随文件移动改名。
- `zh-CN/*.json` 按 Editor、Workbench、Settings、Sessions 等较大的领域维护译文。不要为每个组件建一个文件。
- `en/*.json` 只保存不能由静态调用提取的声明，例如以数据表或动态 key 调用的文案。可以静态提取的英文留在调用位置。
- 主题颜色说明由主题注册代码声明。审批模式的英中说明由生成的 `ApprovalModes` 提供，不在这里重复维护。

`build/resources/localization.ts` 提取英文、合并领域资源，生成 `.build/desktop/localization/` 中的语言目录。生成文件不提交到 Git，也不要手工修改。源码中的 `src/ash/workbench/services/localization/common/localizationCatalogs.ts` 是固定加载入口，不随词条变化。

## 生成与校验

在仓库根目录运行：

```sh
pnpm localization:generate
pnpm localization:check
pnpm localization:check --report-missing
```

`localization:check` 只校验源词条，不要求已有生成文件，也不写入产物。生成和校验均拒绝冲突的英文声明、重复译文、未知翻译 key 和不匹配的参数。没有语言条目的文案显示代码中的原文，并报告数量；`--report-missing` 列出具体 key。

不是所有内容都需要翻译。产品名、技术名称、颜色通道符号等可以保留原文，在所属语言 JSON 中显式填写相同内容，例如 `"hueShort": "H"`。生成器分别报告没有语言条目的文案与显式保留原文的条目。配置键、命令标识、协议字段、路径和用户内容保持原样，不作为界面文案翻译。

正常构建和测试准备会生成资源，干净 checkout 无需预先保存生成文件。Vite 开发服务会在文案或领域 JSON 改动时重新生成，资源变化后重新加载页面。多设备同步只需合并功能文案与领域 JSON，再运行正常开发、构建或测试命令；生成资源不会改动源码工作区。

## 本地语言资源

内置语言随程序发布。安装或更新 Extensions 语言包后，客户端把完整目录保存到本地 UI profile：Electron 使用 `<profile>/languagepacks/<locale>.json`，Web 使用 IndexedDB `ash-language-packs`。

保存语言偏好之前必须先保存语言资源。启动读取本地资源，不等待 App Server 或 Extensions；先匹配指定语言，再逐级尝试基础语言（例如 `fr-CA` → `fr`），最后使用内置英语。缺失、损坏或契约版本不兼容的资源不阻止启动，也不改写语言偏好；重新安装有效语言包后，下次启动可恢复原来的语言。移除 Extensions 包不会删除已经保存的启动资源。

内置语言优先于扩展提供的同语言目录。多个已安装扩展提供同一语言时，该语言不进入可选列表，也不写入本地资源；卸载重复的包后，剩下的包会重新加载。其他语言正常加载。

## Ash 语言包示例

[`examples/fr`](examples/fr) 提供一个仅面向 Ash 的法语示例包。`manifest.json` 是 Extensions 分发目录的 manifest；`localization/package.json` 是 capability 读取的 Ash 翻译目录。法语示例只翻译命令搜索入口和语言设置，其余文案回退英文。

发布者按现有 Extensions 签名分发流程发布该 manifest 和静态资源。可以在示例目录中运行 `zip -r ash-language-fr-example.zip localization` 生成资源包，再由分发流程生成摘要、统计和签名；ZIP 本身不代表已经发布或受信任。安装后通过“配置显示语言”选择 Français，再重启应用或刷新页面。

新增语言时使用自己的包 ID、locale、语言名称和译文，保留 `catalogVersion: "ash-1"` 与 Ash 的 bundle/key。翻译参数必须与英文原文一致，例如 `{0}`；缺少的词条使用调用位置的英文。包只包含静态 JSON，不需要脚本或 Extension Host。
