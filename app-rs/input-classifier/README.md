# `ash-input-classifier`

1. 位于 `app-rs/input-classifier`，拥有 App 进程内的 Shell/Agent 输入分类与模型依赖。
2. 管理自然语言解析、提交历史匹配、决策规则、BERT-Tiny 模型、tokenizer 和词典。
3. 消费 [`ash-shell-completion`](../shell-completion/README.md) 的 Shell 解析与补全快照。
4. 宿主提供工作目录、当前路由和会话位置；分类不判断命令风险，也不授权执行。

标签顺序、阈值和词典由本 crate 唯一持有。输入版本、推理调度、候选展示和提交由 App 的 Session 输入框负责。

## 公共契约

| Symbol | 职责 | 接入要求 |
| --- | --- | --- |
| `InputClassifier` | 持有工作目录和 PATH 快照，执行整条分类管线 | 一个 Composer 持有一个实例；工作区切换时调用 `set_working_directory` |
| `InputClassificationContext` | 提供 `current_route` 和 `InputConversation` | 每次输入变化时提供当前分类路由和会话位置 |
| `InputConversation` | 区分普通输入与 Agent 回复后的短追问 | Agent Turn 完成后设为 `AgentFollowUp`，新提交或失败后复位 |
| `InputHistoryEntry` | 提供按时间排序的 Shell 命令和 Agent prompt | Snapshot 必须按 Turn 顺序重建；command-not-found 不进入 Shell 历史 |
| `InputClassification` | 返回路由、置信度与决策来源 | 置信度只用于诊断，不得作为执行授权 |
| `start_background_warmup` | 后台解码模型、缓存权重张量和加载 tokenizer | 创建输入界面时调用，避免首次推理承担加载延迟 |
| `InputClassifier::prepare` / `InputClassificationTask` | 立即执行规则与 Shell 证据判断，捕获剩余推理任务 | `classification()` 有结果时直接使用，否则在后台调用 `run()`；任务持有准备时的输入和上下文 |
| `shell_completions` / `shell_completion_snapshot` | 从分类器持有的同一 Shell context 返回补全项；snapshot 另含当前 token 的精确匹配状态 | UI 可投影结果，但不能建立第二套 parser/registry |
| `replace_shell_aliases` / `set_shell_path_entries` | 更新宿主提供的 Shell 环境快照 | 只能传入当前执行环境的事实；不得猜测 alias |

App 只把 `InputRoute` 映射为 Composer 路由，并把真实 Turn 生命周期投影成
`InputConversation` 和按顺序排列的 `InputHistoryEntry`。Shell parser、相似度计算、PATH/manifest
检查和 fallback 不再属于产品宿主。

## 执行路径

```text
InputClassifier::classify
  → parse_query_into_tokens
  → contextual rules
      empty / current-Agent NL one-off / Agent follow-up
  → InputHistory
      newest Shell command / Agent prompt close match, cutoff 0.9
  → NL one-off / Shell allowlist
  → ShellContext::analyze
      ash-shell-completion::ShellCompletionEngine::analyze
      executable + builtin + recursive signature + directory/alias/path descriptions
      strict token threshold
  → EmbeddedClassifier
      Tokenizer::encode_fast
      candle_onnx::simple_eval
      temperature scaling + softmax
  → ordinary error: current_route
  → panic: dictionary/stemmer heuristic fallback
```

Shell token 阈值采用 Warp 当前严格方案：所有解析 token 都有 Shell 语义时直接判为 Shell；少于
3 个自然语言 token 时，只要最后一个 command-position token 是已知命令也判为 Shell。其他输入交给模型，避免把
`git status 是做什么的` 这类 command-prefix 问句提前截成命令。

这里对齐的是判定顺序和阈值，不是复制 Warp 的补全器数据。两者当前的 Shell 证据边界如下：

| 证据 | Warp | Ash 当前实现 |
| --- | --- | --- |
| 顶层命令 | 补全器的 `ParsedTokensSnapshot` | `ash-shell-completion` registry、Shell builtin 和 PATH 可执行文件 |
| 参数 | 命令签名和 token description | 递归 command spec、精确 option/value、现有路径和工作区 target |
| alias | 在分类前用当前会话的补全上下文展开 | engine 已实现有界展开；由产品宿主提供 alias snapshot |
| 证据不足 | 交给 BERT-Tiny | 交给 BERT-Tiny |

当前 App 的 Shell Turn 由 App Server 以 `/bin/sh -lc` 执行，尚未向 engine 提供交互 PTY alias 和动态
generator 候选；因此静态 command grammar、PATH 和 directory evidence 已生效，alias API 暂时没有产品数据源。
如果后续让 Composer 直接执行到交互 PTY，应由 App adapter 提供带环境 revision 的 alias/动态候选快照；
不应把 PTY 或命令执行运行时移进 `ash-input-classifier` 或 `ash-shell-completion`。

`natural_language.rs` 的 fallback 会分别尝试排除和包含未完成的末 token，并按 1.0、0.8、
0.6 的长度阈值使用 English stems、developer terms 和 command-overlap 词典打分。这三份词典为
Ash 独立构建，没有导入或变换 Warp 的词表。英文候选数据来自 MIT 许可的 TextBlob bundled
spelling-frequency data，并经过 frequency threshold 和 Snowball stemming；developer terms 和
command-overlap 是为 Ash 独立整理的集合。TextBlob 许可文本位于
[`dictionaries/THIRD_PARTY_NOTICES.txt`](dictionaries/THIRD_PARTY_NOTICES.txt)。词典作为本 crate
的数据内嵌进二进制，不引入单独运行时。

## 模型资产与失败语义

当前发布来自 `chogng/ash-classifier` 的 `models/bert_tiny_v3`：

- `bert_tiny_v3_candle.onnx`：Candle 0.9 专用 FP32、opset 16；
- `bert_tiny_tokenizer.json`：训练分区适配 tokenizer；
- `metadata.json`：标签、温度、算子与摘要；
- 输出 index 0 为 Shell、index 1 为 Agent；softmax 前温度为 `1.6894922825552194`。

模型和 tokenizer 通过 `include_bytes!` 固定进二进制，不在运行时下载。`EmbeddedClassifier` 是
模型、权重张量、tokenizer 和 CPU device 的唯一 owner。模型或 tokenizer 初始化失败会直接启用完整
`HeuristicFallback`；初始化成功后的编码、推理或输出校验错误返回 `CurrentRouteFallback`，保留当前
路由；Candle panic 会被隔离，并在当前进程永久改走 `HeuristicFallback`。官方
仓库补丁让 `candle-onnx` 的构建脚本通过 `protoc-bin-vendored` 获取 `protoc`，不依赖系统安装；
产品运行时不需要也不会携带 `protoc`。
Bazel 通过根 `MODULE.bazel` 和 `third_party/candle-onnx/BUILD.bazel` 声明构建工具，按执行平台选择同一已锁定的 `protoc`，并通过 `PROTOC` 传入当前沙箱路径。

更新模型时必须一起更新 ONNX、tokenizer、`metadata.json`、摘要常量、标签解释、温度和概率基线
测试，不能只替换其中一个文件。

词表中的普通单词是模型训练数据，产品重命名不能改写词条；例如 `zeta` 必须保留原 token ID `23870`。

初始化时将 ONNX initializer 转成共享的 CPU Tensor，并从解码后的图中移除对应 protobuf 数据。
每次推理只复制 Tensor 引用，将当前输入张量加入独立的求值表；仍由上游 `simple_eval` 执行算子，
不修改第三方运行时代码。文本资产通过 `.gitattributes` 固定 LF，二进制 ONNX 禁止文本转换。

## 内部所有者与修改影响

- `classifier::prepare_classification` 固定决策顺序，`InputClassificationTask::run` 完成模型与失败分支；改动会影响所有路由消费者。
- `history::InputHistory` 拥有 0.9 相似度门槛和“最新匹配胜出”语义；宿主只提供有序事实。
- `shell::ShellContext` 只适配 `ash-shell-completion::ShellCompletionEngine` 与 classifier 阈值；parser、
  command registry 和 completion 不得移回本 crate 或 Workbench/Session 组合层。
- `rules` 只放低风险、确定性的上下文和 allowlist 短路；模糊规则不得绕过模型。
- `model::EmbeddedClassifier` 绑定模型图、tokenizer、标签和温度；任一资产变更都需要概率测试。
- `natural_language::classify_with_fallback_heuristic` 只在模型不可用或 panic 后接管；它使用 Ash
  自有词典，不应成为正常主路径。`natural_language` 保持为本 crate 的私有模块：产品消费者必须
  调用完整 `InputClassifier`，不得直接依赖词典分数绕过历史、Shell evidence 和模型。

当前没有第二个需要“原始自然语言分数”而非 Shell/Agent 路由的后端无关消费者，因此不拆独立
natural-language-detection crate。只有出现这样的真实消费者，并且能定义不依赖 `InputRoute`、
`ShellTokenSnapshot` 和 classifier fallback 阈值的纯打分契约时，才应把词典和 scorer 一起抽出；
路由顺序与失败语义仍由 `ash-input-classifier` 拥有。

## 验证

```bash
just check ash-input-classifier --locked
just test ash-input-classifier --lib --locked
just rust-warnings ash-input-classifier --locked
just test ash-input-classifier --lib inference_latency -- --ignored --nocapture
```

测试覆盖 parser、历史冲突、严格 token 阈值、工作区命令、自然语言词典、follow-up、普通模型错误、模型 panic、
模型路由样例、资产 SHA 和 Candle FP32 概率基线。当前模型仍可能误判自由措辞，例如
`chmod 755 是什么意思`；普通推理错误保留当前路由，输入继续变化时由宿主再次分类。

`InputClassifier::classify` 同步完成整条管线；App 使用 `prepare` 获取立即结果或可移动到后台的任务。
ChatInput 对需要模型的连续输入合并 40ms，仅文本或分类上下文变化时重新准备任务，光标移动和 IME
preedit 不重复推理。窗口通过 ZUI 后台执行器最多运行一个分类任务，结果按输入版本检查后更新界面；
修改文本、目录、历史、会话或清空输入后，旧结果失效。

分类尚未完成时，Enter 请求等待当前版本的结果，并跳过尚未开始的合并延迟；编辑或 Escape 取消等待提交。
Shell completion 仍使用同一个 `InputClassifier` 的 Shell context；ChatInput 将候选作为 ghost text，
通过 editor 的精确 text edit 应用，Slash/模型选择 Pane 不承载 Shell 候选。

`inference_latency` 是手动性能比较，交替运行原始图和缓存权重的图，输出初始化耗时及推理 p50/p95；
它不设置依赖机器负载的测试阈值。概率回归同时验证不同输入长度和多个线程共享权重时的结果。
