# `ash-model-tokenizer`

> 本文拥有本地 tokenizer 资产绑定、聊天模板执行与 token 计数的实现契约。预算数学与计量结果
> 语义由 [`ash-context-engine`](../context-engine/README.md) 拥有；provider 接入由
> [`ash-model-provider`](../model-provider/README.md) 拥有。

`ash-model-tokenizer` 对外只暴露整请求 `count_input_tokens(ModelRef, ModelRequest)`。内部按宿主提供的清单下载并
固定 `tokenizer.json` 与 `tokenizer_config.json`，用 `hf-chat-template` 把 messages、Tools 与 Tool
历史渲染为 prompt，再用 `tokenizers` 计数。它不声称本地结果必然等于远端 provider 的最终 usage。

## 1. 边界与公共契约

| Symbol                             | 职责                                                            | 接入义务                                            |
| ---------------------------------- | --------------------------------------------------------------- | --------------------------------------------------- |
| `PinnedTokenizerAsset`             | 绑定本地路径、上游 revision 和文件 SHA-256                      | 宿主必须先安装资产并提供不可变 revision             |
| `LocalTokenizerBinding`            | 将 tokenizer、chat template 和模板全局变量绑定到完整 `ModelRef` | provider 与 model 任一变化都必须建立独立绑定        |
| `LocalTokenizerRegistry::register` | 读取、验摘要、解析 tokenizer 并编译模板                         | 启动或配置 safe point 调用；失败不得注册半成品      |
| `LocalTokenizerService`            | provider adapter 使用的只读计数端口                             | 必须返回随两份资产变化的 source revision            |
| `LocalTokenizationOutcome`         | 区分已计数和不支持的请求                                        | 图片等没有 processor 的输入必须明确返回 unsupported |
| `ManagedLocalTokenizerService`     | 首次使用时后台发现/下载、持久化摘要清单并维护内存 LRU           | 网络失败不得阻塞模型调用或每次请求重复下载          |
| `TokenizerAssetDiscoverer`         | 宿主按完整 `ModelRef` 提供固定版本的资产清单                    | 返回前解析不可变 revision 并计算内容摘要            |

`hf-chat-template` 负责 tokenizer 配置中的 special token、Python/Jinja 兼容方法、`tojson`、
`strftime_now` 与 named template 语义；Ash 仍拥有 revision/SHA、磁盘目录、后台准备和 LRU。

## 2. 内部接口地图与调用路径

| Symbol                   | 可见性  | 单一职责                                            | 漂移信号                                          |
| ------------------------ | ------- | --------------------------------------------------- | ------------------------------------------------- |
| `LoadedTokenizer::load`  | private | 校验并一次性加载 tokenizer 与模板配置               | 网络、Hub branch 解析或 provider 名称判断进入此处 |
| `verified_asset`         | private | SHA-256 校验后才返回字节                            | 只信路径或只记录 revision 而不验内容              |
| `request::render_input`  | private | canonical request 转换为 HF 风格 `messages`/`tools` | provider wire JSON 或预算策略进入转换层           |
| `LoadedTokenizer::count` | private | 模板渲染后用 `add_special_tokens=false` 编码        | 跳过 chat template，只对正文编码                  |
| `source_revision`        | private | 组合两份 revision 与摘要                            | tokenizer 或 template 任一变化后仍复用旧来源版本  |

```text
exact ModelRef + complete ModelRequest
  → LocalTokenizerService::count_input_tokens
     → memory LRU / pinned disk cache / background asset preparation
     → request::render_input
     → hf-chat-template render
     → Tokenizer::encode(add_special_tokens = false)
     → LocalTokenCount(tokens, composite source revision)
```

聊天模板已经负责加入控制 token，因此编码阶段关闭 tokenizer 的额外 special-token 注入，避免重复。
模板语法错误在注册时作为 `LocalTokenizerError` 返回；请求触发模板运行时拒绝、未注册模型和没有
多模态 processor 的图片请求返回 `UnsupportedRequest`，让上层使用保守估算。已经通过加载校验的
tokenizer 若仍无法编码渲染结果，则作为运行时错误返回，避免掩盖损坏状态。

## 3. 测试、限制与扩展

```bash
just verify ash-model-tokenizer
```

- **Current**：精确 `ModelRef` registry、双资产 revision/digest 固定、`hf-chat-template 1.0`、文本/Tool
  整请求投影、按需后台下载、重启复用磁盘缓存和四项默认内存 LRU 已实现。
- **Current**：named `tool_use` 模板按请求是否带 Tools 自动选择，日期函数使用本地时钟；聊天模板由宿主提供的 `tokenizer_config.json` 固定。
- **Current limitation**：当前多模态输入没有 processor，明确 unsupported；依赖模型专有外部函数的
  模板在渲染时降级为 unsupported。
- **Current limitation**：本 crate 只报告本地模板栈的计数。远端 provider 是否添加隐藏 envelope、
  改写 Tool schema 或使用不同 revision，由 provider adapter 决定准确度。
- **Extension point**：新增 Hub/provider 资产来源时实现 `TokenizerAssetDiscoverer`；不得把下载、缓存
  或模板运行时泄漏给 Electron/TS 调用方。
