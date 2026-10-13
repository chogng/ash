# 界面语言

界面语言在启动时确定。`workbench.locale` 保存下一次启动使用的语言；选择语言后，可立即重启或稍后重启。当前窗口不重新翻译已经创建的界面。

Electron 的 Workbench 和 Sessions 在加载贡献注册模块前读取语言偏好及浏览器缓存，再把解析后的目录交给 Main 更新系统菜单。Web 同样在页面启动时完成解析。当前窗口的界面与扩展译文固定到启动快照。

## 文案来源

- 普通文案在功能代码中调用 `localize(key, 'English message')`。
- 命令标题等同时需要英文原文和译文的地方调用 `localize2(key, 'English message')`；返回 `{ original, value }`，两者都在调用时确定。命令面板显示译文，并支持按英文原名、译文或命令 ID 搜索。
- 跨 bundle 的文案使用 `{ bundle, key }`。已有 bundle/key 是稳定标识，不随文件移动改名。
- `extensions/language-pack-zh-cn/translations/*.json` 按 Editor、Workbench、Settings、Sessions 等较大的领域维护译文。不要为每个组件建一个文件。
- 英文原文由功能代码拥有。普通文案直接使用 `localize/localize2`；数据表可通过 getter 或函数声明静态调用，避免另存一份英文。
- 生成器也提取本地化服务的静态调用、同类中转发 key 和英文参数的多层包装方法，以及视图和区域描述符中配对的翻译 key 与英文文案。
- 枚举和动态 key 的数据表在所属模块通过静态 `localize2` 声明文案。需要保留英文供指定窗口的本地化服务使用时，取其 `.original`，避免在模块初始化时固定为当前语言。英文 JSON 字典已退出生成链；新增英文词条必须回到所属源码，校验会拒绝 `en/*.json` 中的非空声明。
- 主题颜色说明由主题注册代码声明。审批模式的英中说明和产品 Slash Command 的英文说明来自生成的协议元数据，不在客户端另存副本。

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

英语是核心基础回退。简中由 [`extensions/language-pack-zh-cn`](../extensions/language-pack-zh-cn/package.json) 以静态语言包扩展随应用预装，断网也可使用。安装或更新 Extensions 语言包后，客户端把完整目录保存到本地 UI profile：Electron 和 Web 都使用 IndexedDB `ash-language-packs`，不使用 Node 文件缓存。缓存索引保存 locale、包 ID、版本、摘要和有效目录；Rust 扩展管理仍是安装状态的所有者。

保存语言偏好之前必须先保存语言资源。启动读取本地资源，不等待 App Server 或 Extensions；先匹配指定语言，再逐级尝试基础语言（例如 `fr-CA` → `fr`），最后使用内置英语。缺失、损坏或契约版本不兼容的资源不阻止启动，也不改写语言偏好；重新安装有效语言包后，下次启动可恢复原来的语言。成功刷新安装状态后，客户端原子替换缓存索引，清理卸载、损坏或冲突的提供者。卸载简中更新后恢复预装版本；其他语言回退英语。后端不可用时保留上次有效缓存。

核心英语始终优先。与预装简中相同包 ID 的安装版本可独立替换预装目录，其他包不能覆盖预装语言。多个已安装扩展提供同一语言时，该语言不进入可选列表，也不写入本地资源；卸载重复的包后，剩下的包会重新加载。其他语言正常加载。

`network.meteredConnection` 控制启动后的语言包缓存同步。在计费网络下，客户端先读取本地缓存并继续使用启动语言，推迟从 App Server 读取完整的已安装语言目录；恢复非计费网络后补做一次同步。用户主动获取语言列表、刷新，或安装状态变化后的同步照常执行。Web Workbench 和 Sessions 使用浏览器状态服务及本地应用配置；Electron 使用 Main 统一管理的计费状态。`auto` 只采用浏览器明确的省流量或计费信号，不以网速推断。

## 预装简中语言包

简中的扩展清单使用 `engines.ash` 和 `contributes.localizations`，声明 `localization/package.json` 目录资源；不声明可执行入口。`localization/languages.json` 仅保留英语。

`pnpm localization:generate` 从扩展的领域译文生成完整目录，并在 `.build/desktop/localization/extensions/ash.language-pack-zh-cn/` 输出可分发包，包括 `package.json`、`manifest.json`、`localization/package.json` 和声明的 `extension-translations/*.json`。正常扩展打包将同一目录加入预装扩展资源；启动时的快照也由这份扩展译文生成。

生成后可在该目录运行 `zip -r ../../ash-language-pack-zh-cn.zip package.json manifest.json localization extension-translations`。后安装语言包仍走现有 Extensions 签名分发流程。

## 扩展译文

`contributes.localizations[].translations` 中的 `ash` 目标声明界面目录，其他目标使用扩展 ID，例如 `ash.git`。扩展译文包含 `contents.package`（清单 `%key%` 标签）和 `contents.bundle`（`vscode.l10n` 文案）。预装简中已包含 Git、Remote SSH、Media Preview 和 Markdown 的译文。

MainThreadLocalization 在客户端解析启动时的译文，传给 Worker 与 Rust/V8 扩展的初始化快照。缺失文案保留英语原文；语言包资源损坏时尝试扩展自己的地区和基础语言资源。App Server 不保存全局语言。

## Ash 语言包示例

[`examples/fr`](examples/fr) 提供一个仅面向 Ash 的法语示例包。`manifest.json` 是 Extensions 分发目录的 manifest；`localization/package.json` 是 capability 读取的 Ash 翻译目录。法语示例只翻译命令搜索入口和语言设置，其余文案回退英文。

发布者按现有 Extensions 签名分发流程发布该 manifest 和静态资源。可以在示例目录中运行 `zip -r ash-language-fr-example.zip localization` 生成资源包，再由分发流程生成摘要、统计和签名；ZIP 本身不代表已经发布或受信任。安装后通过“配置显示语言”选择 Français，再重启应用或刷新页面。

新增语言时使用自己的包 ID、locale、语言名称和译文，保留 `catalogVersion: "ash-1"` 与 Ash 的 bundle/key。翻译参数必须与英文原文一致，例如 `{0}`；缺少的词条使用调用位置的英文。包只包含静态 JSON，不需要脚本或 Extension Host。
