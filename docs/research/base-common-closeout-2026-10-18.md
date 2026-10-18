# Common 基座收尾核对 · 2026-10-18

本轮从 Ash `77b1986a3` 出发，对照本地 VS Code `72e9539ed6b` 的公开契约及生产调用证据收尾。逐文件结论见 [文件台账](base-common-file-alignment-2026-10-18.tsv)。实现从 Ash 当前调用、状态及生命周期独立整理，未复制上游实现。

## 本轮闭合的调用链

| 用户行为                       | 生产链与唯一 owner                                                                                      | 验证重点                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 打开、诊断 Prompt / Skill 文档 | `PromptFileParser` → `base/common/yaml.ts` 的普通语法树、UTF-16 偏移和解析错误                          | 引号、空值、重复键、块及流式集合、CRLF、深层输入、alias / anchor / tag 占位 |
| 读取系统或账户托管设置         | `ConfigurationRegistry` / `IPolicyData` → `base/common/policy.ts` 的值及 schema 类型 → 原有 Policy 服务 | IPC 校验、来源优先级、账户切换及撤销、映射后的有效配置                      |

YAML 通用层继续使用已有 `yaml` 依赖，采用显式工作栈投影为普通对象，不暴露库 AST，也不展开别名或标签。Prompt 层继续拥有 16 KiB、256 行、每行 2 KiB、八层限制，以及编辑器 `Range` 和已有本地化诊断。Markdown 正文引用提取未改动。Policy 服务的状态、校验、注册及通知行为未改变，旧平台层重复的值类型已退出全部 import。

## 文件清单的完成边界

计入同一目录口径下的 TypeScript 声明文件：Ash 94 个，上游 156 个；其中同路径 86 个、仅上游 70 个、仅 Ash 8 个。该计数只描述文件关系；原有同路径文件仍按台账中的 `presence-only` 标记，未据此宣称所有公开 API 或行为等价。

70 个仅上游文件已经逐组确认处置依据：

| 数量 | 结论                                                                                                                                           |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 60   | 已有不同语义或运行时 owner。其中 38 个属于 observable 私有拆分，其余覆盖实际 Editor diff、领域协议、验证、图片解码、历史导航、策略转换等职责。 |
| 6    | 当前没有能力入口或生产消费者：桌面环境遥测、ARC 统计、env 文件读取、产品配置聚合、MicrotaskDelay、URI template。                               |
| 3    | Ash 使用现有 lxicons 对应目录；未重复创建或改名图标目录。                                                                                      |
| 1    | `linkedText.ts` 对应 Welcome 内容的进一步 UI 能力，见下述边界。                                                                                |

`linkedText` 的生产证据是扩展 `viewsWelcome` → `ViewWelcomeController`。当前实现支持独立命令链接按钮；行内链接、多链接和标题需要同时改变 Welcome 呈现、键盘与可访问性交互并完成浏览器验证。本轮没有以新增解析器文件冒充该产品功能完成。

`range.ts` 的候选仅为 IconLabel 内部交集算式；`navigator.ts` 的历史游标已有完整 owner；`ports.ts` 的真实调用由操作系统分配空闲端口。未为增加文件数创建这些 API。8 个仅 Ash 文件保留原位置，本轮未改动其职责或归属。

此前两批已经闭合的切片包括比较与过滤、模糊评分、替换大小写、SSE、错误显示、Unicode 规范化、命令参数 URI 恢复、配置前缀及工作区 URI 归属；本轮由子代理交叉审查，并复用及重跑对应定向覆盖。台账保留各批实际验证时间点，未把历史通过结果改写成当前整仓通过。

## 本轮验证

使用 macOS、Node `24.21.0`。生成准备和 common 类型检查通过，21 个选定测试文件使用原测试编译选项单独编译通过；`pnpm build:prepared` 完成 Desktop Host 与 Renderer 构建。构建仅有既有第三方依赖的浏览器外置及 eval 提示。

通过标准单元测试 runner 运行：19 个业务测试文件共 99 项通过，包含本轮 YAML / Prompt、Policy 及此前 common 切片回归。YAML 重复键的测试初版误把库诊断的一字符定位当成完整键范围，修正断言、重新编译并单独复跑后 4 项全部通过。Windows 系统注册表读取用例在 macOS 按原测试条件跳过。

扩展验证如实保留两项失败：Sessions 配置文件中 17 项通过，跨窗口外部文件监听用例先后在 60 秒及单独复跑的 15 秒限制下超时；分层文件中 14 项通过，1 项命中其他进行中的 Sessions prompts / languageModels imports。策略迁移涉及的 8 个原有文件在移除注释后编译产物完全相同，包含上述 Sessions 测试，其文件监听逻辑未被本批修改。

完整 `pnpm test:unit` 的编译阶段还遇到本轮之外的 Sessions 测试及 workspace 上下文类型错误；生成准备完成后的 Renderer 检查剩余 `sessions/services/workspace/browser/workspaceContextService.ts` 的 `selected` 可能为 `undefined`。这些文件未纳入本次提交。仓库已无 `valid-layers-check` 脚本，本轮使用现有 `test/architecture/layer-boundaries.test.ts` 检查模块方向。
