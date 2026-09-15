# `app` 应用根迁移计划

> 状态：当前迁移计划。本文拥有 `app` 从 `ash-rs/native` 迁移到仓库根 `app/` 的阶段、边界和验收条件；
> 共享 Rust backend 的 crate contract 由对应 `ash-rs` README 维护，Native UI framework 的当前 contract 见
> [`../zui/README.md`](../zui/README.md) 和 [`../ui-components/README.md`](../ui-components/README.md)；兼容边界见
> [`native-deprecation-plan.md`](native-deprecation-plan.md)。

## 快速理解

`ash-rs` 作为 `ash-ts` 和 `app` 共用的 Rust backend；`app/` 作为 `app` 的独立产品宿主；
`ash-ts/` 继续作为 Electron 宿主。当前 `ash-rs/native` 把产品宿主、Native UI framework 和 GPU
接线放在共享 Rust workspace 中，边界已经不再清晰。本计划先把宿主整体迁到 `app/`，再把只服务
Native UI 的 crate 从共享 workspace 中分离。

| 读者关心的对象 | 当前路径 | 目标 owner | 迁移状态 |
| --- | --- | --- | --- |
| `app` binary 与产品事件语义 | `ash-rs/native` | `app/` | 已实现 `zui::App` |
| 通用 application/window runtime | `ash-rs/native` 的历史宿主 glue | public `app/zui` | 已拥有 event loop、window registry、renderer 初始化与 resize/scale 同步；内部由 `app/window/input/render` 能力目录隔离 |
| `app` Root/Shell/Workspace 产品布局 | `ash-rs/native/src` | `ash-workbench` + `ash-session` | Workbench 管完整产品组合与窗口场景，Session Pane 的 Thread/Composer state、input、interaction、layout 由 `ash-session` 拥有 |
| 通用 icon asset contract | 旧 Native icon types | `app/zui::ui` | 已收入单一 `zui` crate；产品 catalog 保留在 `app/icons` |
| Element、Scene、Interaction、Animation、Retained Runtime | `app/zui` | app-owned crates in root workspace | 已迁入 app |
| Button、Tree、List、Editor/Environment pane presentation | `app/ui-components`、`editor`、`workbench/environment` | app-owned modules and crates in root workspace | 已迁入 app |
| Renderer、wgpu、winit | 历史 `app/renderer`、`wgpu`、`winit` | private `app/zui` modules | 已收入单一 `zui` crate |
| App Server、Core、Protocol、Session、File/Git、Diff、Terminal model | `ash-rs/*` | `ash-rs` | 保留 |
| 纯 Rust editor transaction、syntax、LSP manager | `ash-rs/editor-core`、`syntax`、`lsp-manager` | `ash-rs` | 保留；presentation 与底层分离 |

`ash-rs` 的“共享”按宿主无关的 Rust 语义和 backend contract 判断，不要求 Electron TypeScript 直接
链接 Rust crate；Electron 通过 App Server protocol 使用同一套 authority。只有产品布局、窗口、GPU、
Native interaction composition 和平台生命周期不能继续进入 `ash-rs` shared layer。

## 目标结构

迁移完成后的物理结构为：

```text
ash/
├── app/
│   ├── Cargo.toml              # app application package
│   ├── README.md
│   ├── src/                    # app product host and composition root
│   ├── zui/                    # complete public framework; capability-owned internal directories
│   ├── composer/               # app Composer state, input, interaction and geometry
│   ├── ui/                     # reusable UI components
│   ├── workbench/              # pure Tab/Pane Workbench model
│   ├── workbench/              # Workbench model, layout, chrome UI and binding boundary
│   └── ...                     # other presentation crates
├── ash-rs/
│   ├── ...                     # shared Rust backend crates
│   ├── core/
│   ├── app-server*/
│   ├── protocol/
│   ├── editor-core/
│   ├── terminal/
│   └── ...
└── ash-ts/                    # Electron product host
```

依赖方向固定为：

```text
desktop ───────→ ash-rs protocol/App Server
app ────→ ash-rs backend/domain
             └─→ app UI workspace
ash-rs ───────→ no app/desktop product host
```

## 阶段与当前状态

### 阶段零：冻结旧 Native（已完成）

- [x] 在 `AGENTS.md` 中禁止向 `ash-rs/native` 新增能力；
- [x] 将 Native split scene/interaction host API 迁移到 `UiFrame`，并删除旧兼容入口；
- [x] 明确 `zui`、`ash-ui-components`、renderer 和生命周期机制的长期 owner；
- [x] 迁移期间将 `ash-rs/native` 作为只读迁移源，期间不再把它当作新功能落点；阶段一完成后已删除。

### 阶段一：迁移 `app` 产品宿主（已完成）

- [x] 在仓库根建立 `app/` 产品目录，并以 `app` 作为发布 binary；
- [x] 将当前 `ash-rs/native` 的产品宿主、测试和 README 整体迁移到 `app/`，保留现有模块边界和行为；
- [x] 将 app 的依赖改为明确的 `ash-rs` path dependency，不让 `ash-rs` 反向知道 app；
- [x] 从 shared crate 集合移除 `native` member 和产品入口；
- [x] 更新 `just app`、package/build 入口和产品线文档；
- [x] 阶段完成后删除旧 `ash-rs/native` 路径，不保留两个可运行宿主。

阶段一先解决产品宿主和共享 backend 的边界；阶段二继续把 Native-only crate 物理移动到
`app/` 的直接子目录。现在由仓库根 Cargo workspace 统一解析所有 crate，app 仍作为独立 package 和发布
边界存在；Bazel 使用同一个 root graph。

### 阶段二：分离 Native UI workspace（核心迁移已完成）

- [x] 将 Native UI crates 迁入 `app/`，再把 icon/UI/runtime/wgpu/winit 职责收敛为单一 public `zui` crate 的同名能力目录；
- [x] 保留 `ash-editor-core`、`ash-syntax` 等纯 Rust core 在 `ash-rs`，将 `ash-editor` presentation 迁入 app；
- [x] 将 Files/SCM workspace panes、Native settings UI 和 Native keybinding UI 迁入 app-side modules/crates；
- [x] 将 Markdown presentation crate 迁入 app-side crates，Theme manifest/resolver 保留在 shared backend；
- [x] 保证 `ash-rs` backend crates 不再直接依赖 Native UI crate。

当前根 `Cargo.toml` 是唯一 workspace，`app/Cargo.toml` 是 `app` package。`app/BUILD.bazel` 已
提供 `//app:app`、`//app:app_sources`、`//app:app_release_inputs`、
`//app:app_package_contract` 和 `//app:app_ci`；所有 app/shared crates 通过单一 `@crates`
hub 消费 rules_rs 生成的 package deps。`bazel build //app:app` 已在当前 macOS toolchain 通过；
此前由 apple-cf Swift bridge 引起的限制已随 zui 的字体目录实现迁移而消除。

### 阶段三：收敛应用组合根

- [x] 删除 `app/src`；`app/main.rs` 只启动 `ash-workbench`，窗口/平台适配、产品状态、command 执行和具体 Part/Overlay 组合统一由 Workbench 管理；
- [x] `ShellPresentation` 使用单一 `zui::UiFrame` owner；
- [x] 清零 split scene/interaction API 的生产调用并删除旧入口；
- [x] retained fragment cleanup、animation deadline 和 redraw invalidation 全部从 `zui::RetainedRuntime`/
      `AnimationRegistry` 派生；具体产品 fragment 是否采用 exit retention 仍由产品状态决定；
- [x] 删除剩余 `ash-native` 命名、旧 build target 和旧文档引用；迁移历史中的旧名称只保留在迁移历史、
      AGENTS 约束和边界检查器中。

### 阶段四：独立产品发布

- [x] `app` 能独立构建、测试，并通过 package staging 生成带 binary digest 的 unsigned `app` artifact；
- [x] 为 `app` 建立发布输入和 boundary CI graph；`//app:app_ci` 验证 workspace ownership，
      `//app:app_release_inputs` 固定 package/signing contract；Cargo workspace 仍是唯一 canonical
      Rust build graph；
- [x] 建立 `app/` 与 `ash-rs` shared crates 的 metadata-derived hermetic Bazel Rust graph；
      单一 root workspace 已消除跨 workspace path dependency bridge；
- [x] 在 CI 入口中通过完整 `//app:app` build 验证平台 toolchain；本机已通过同一 target，
      `//app:app_ci` 继续验证 boundary/package/signing contract。
- [x] 提供平台签名与验证入口；`build/release/app/build.py` 负责 Build → Stage，
      `build/release/app/signing.py` 负责 Sign → Verify；平台任务绑定签名工具和凭据，只发布
      `verified` artifact；
- [x] `ash-ts` 构建不拉入 Native UI/GPU 依赖；desktop 侧只保留自身的 platform adapter，边界检查未发现
      对 app UI/GPU crate 的依赖。
- [ ] `ash-rs` backend 可独立测试、发布和被多个宿主复用；
- [ ] App Server protocol、theme manifest 和 shared domain revision 具备明确兼容策略；
- [x] packaging、CI、开发命令和文档只引用新的 product roots。

### 阶段五：通用框架可移植性（当前演进）

- [x] 将 `IconId`、SVG definition 和 rendering mode 收入 `zui` 通用 contract；`ash-icons`
      只保留可选的 app product catalog，`zui`/`ash-ui-components` 不依赖该 catalog；
- [x] 将 Workbench/Pane 的结构布局收回 `ash-workbench`，并让 `ash-ui-components` 只保留可复用组件；
- [x] 将 Tab/Pane 模型、`PaneNode`、ratio contract、Part 布局和基础 UI 统一收回 `ash-workbench`；
- [x] 由公开 `WorkbenchHost` 统一提交 Tab、Pane、布局和 binding 周期；内部 Pane binding 表不再允许产品层分别修改；
- [x] 将 Composer text/routing/history/completion、Slash/model interaction、scroll state、panel/list geometry 收入 `ash-session`，和 Thread、时间线组成一个完整 Session Pane；产品宿主只保留提交 effect 与平台事件接线；
- [x] 将 Session、Workspace、Editor 和 Remote 的可复用状态/视图按 owner 分批抽到
      `app/` 下的产品 crate；组合根只保留宿主快照、effect 和平台事件接线；
- [ ] 将更多 Shell domain composition 按 owner 继续抽取；不把产品 state、command 或平台事件
      下沉到 `zui`；
- [x] 将 `zui` 保持为一个对外 crate，内部使用 `app/window/input/ui/runtime/render/services`
      等同名能力目录维持边界，降低跨 crate API churn 并支持其他 app 直接依赖。

### Workbench 产品组合审计（2026-08-27）

App Server Session 的连接 worker、订阅、命令队列和重连策略已经与 Session Pane 统一进入 `ash-session`；文件、Git 和配置请求由 Workbench 产品组合根持有连接句柄执行。`ash-session` 同时拥有单个 Session Pane 的 Thread、时间线与 Composer；`ash-editor`、`ash-ui-components`、`ash-terminal`、`ash-remote*` 和 LSP crate 继续拥有各自能力，`ash-workbench` 负责产品 effect、样式、窗口事件和输入路由。

新增的 app-side crate 如下：

| crate | 进入的职责 | Workbench 组合职责 |
| --- | --- | --- |
| `ash-session` | App Server Session client、worker、订阅、命令/事件队列和重连策略；单个 Session Pane 的 Thread metadata、后端 transcript 条目、时间线、滚动、Composer 状态、输入、交互、布局和绘制 | Local/Remote 连接目标、文件/Git/配置请求、提交 effect 和平台事件接线 |
| `ash-terminal-runtime` | Terminal runtime、Pane binding、每个 PaneInput 的滚动/指针/选择视图状态 | 平台事件转发和终端进程适配 |
| `ash-files` | Files Pane、目录树、文件搜索状态、滚动、布局、Toolbar 和交互 | 目录 DTO 转换以及打开文件、加载目录副作用 |
| `ash-scm` | Changes Pane、变更文件状态、多文件 Diff、折叠、滚动、布局和交互 | 仓库快照转换以及 Git 请求 |
| `ash-editor-host` | Editor Tab、文档/视口、保存冲突、查找替换、诊断、补全和自动滚动 | 文件与 LSP 请求、平台输入转发 |
| `ash-settings` | `SettingsState`、页面与 section UI、快捷键录制、feature 展示快照和交互 action；连接列表、picker、连接管理和 Tunnel 状态/视图 | 配置与快捷键持久化和平台事件转发；SSH/runtime/子进程启动、profile 和窗口事件 |
| `ash-ui-theme` | Rust GUI 自有主题目录、格式、加载、解析，以及快照到 UI 颜色、尺寸和基础控件样式的转换 | 业务组件样式、主题选择配置、组件状态、布局和产品 action |

所有新 crate 都在 `app/`，不进入 `ash-rs`，也不依赖 `app` package。UI 能力通过宿主输入快照返回 typed action；`ash-session` 直接持有 Session/Thread 的 App Server 请求和 worker。`ash-ui-theme` 统一解析 UI 语义颜色，各能力 crate 把它转换成自己拥有的样式；Files、SCM 与 Workbench 分别拥有自身交互 ID，避免能力 crate 反向依赖组合根。

已清理的重复实现包括 Workspace pane、Session UI 辅助状态、Editor 辅助状态、Terminal Pane 视图状态、Settings UI/草稿/快捷键录制和 Agent Session App Server worker；相应测试随实现迁移到所属 crate。平台输入、命令执行、进程适配和组合层继续保留产品协调职责。

App Server Session 运行时由 `just test ash-session` 验证；协议 fixture 必须与当前 `goal`、`transcript` 和 `tool_mode` contract 同步。

### 当前审计结论（2026-08-03）

物理迁移已经完成：旧 Native UI 目录、旧 workspace、旧产品 build target 和 shared backend 到 UI 的
反向依赖均已清除；根 Cargo workspace、Bazel target graph、`app` binary build、targeted tests 和
boundary CI 均已通过。

剩余两个未勾选项是产品演进工作，不是迁移残留：一是为 shared backend 建立独立发布 artifact/CI
流程，二是为 App Server、theme manifest 和 shared domain revision 定义跨版本兼容策略。它们可以在
当前迁移后的边界上继续建设，不应再把 UI 从 `ash-rs` 搬迁作为前置条件。

## 迁移约束

- 不复制 `ash-rs/native` 形成第二个并行宿主；迁移必须保持单一运行入口。
- 不在旧 Native 中修建新功能；若迁移过程中发现缺少通用能力，先在正确的下层 owner 实现，再由
  app 做最小接线。
- 不把 `app/editor` 或 `app/workbench/environment` 等 presentation owner 直接误判为 shared backend；
  先按“headless model/core”和“Native presentation”拆分。
- 不让 `app` 类型、产品命令、窗口事件或布局类型进入 `ash-rs`。
- 每个迁移阶段都必须保留 deterministic unit tests 和至少一个产品 targeted test；测试失败时先区分
  迁移回归与工作区已有的无关 dirty change。

## 验收入口

阶段一完成后至少通过：

```text
python3 -B scripts/cargo.py check --workspace
python3 -B scripts/cargo.py check -p app
python3 -B scripts/cargo.py test -p app
python3 -B scripts/cargo.py test --workspace
just --dry-run app
```

`just --dry-run app` 只验证入口已经指向根 workspace 的 `app` package；真正启动窗口时使用
`just app`。根 workspace 的 app package 与 shared backend 已通过 workspace check 和 targeted
check/test 验证；Bazel graph 的完整入口是 `bazel build //app:app`，发布 contract 入口是
`bazel test //app:app_ci`，package staging 使用 `just app-package`，
签名和验证使用 `build/release/app/signing.py`，发布细节见
[`app-release-graph.md`](app-release-graph.md)。

并满足以下结构检查：

- `rg 'ash-rs/native|ash-native'` 只剩迁移历史、兼容说明或明确的旧版本记录；
- 根 `Cargo.toml` 是唯一 Cargo workspace；`app/Cargo.toml` 不声明 nested workspace；
- `app` 只向下依赖 `ash-rs` shared crates 与 app-owned UI crates；
- 任何 shared crate 都不依赖 `app`、窗口实例、GPU handle 或产品 layout。
