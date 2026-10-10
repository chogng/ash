# Agent 任务评测

运行 `scripts/agent_eval.py`，让真实 `ash exec` 在固定初始文件上执行任务，再由独立 Python verifier
验收该 Turn 保存的最终文件。模型说“完成”只表示执行结束；执行成功、完整结果还原和 verifier
通过三者同时成立，任务才通过。

当前有三个手写种子用例：前缀筛选、混合换行和配置原子更新。前两项标为 development，配置更新
标为 holdout，演示分开选择任务的机制。它们覆盖基础契约，不能代表实际开发任务的整体质量，
也不能据此宣称某个模型更好。用例不会要求固定搜索顺序、工具顺序或回答措辞。

现已支持“校准评分器 → 运行基线 → 审阅证据 → 记录假设 → 生成实验 → 比较候选 → 保留任务回归”。
[审阅工具](../../scripts/agent_eval_review.py) 独立消费已保存的产物；`review`、`compare` 和 `handoff`
不调用模型，不修改原始 Trace、成果和评分，也不改动生产提示词或运行时。

## 先校准评分器

在仓库根目录运行：

```bash
./scripts/.venv/bin/python -B scripts/agent_eval_review.py audit-suite \
  --output /absolute/path/to/results/audit
```

`suite.json` 的 `referenceSolution` 指向已知正确的完整文件目录，`initialVerifierStatus` 声明初始
fixture 应通过还是失败。audit 对两套文件分别复制到独立目录，使用与产品评测相同的 verifier
执行契约，保存输出和 `audit.json`。缺少控制成果、预期不符、超时或评分错误使 audit 失败；
同时检查正反例可以发现“一律通过”的评分器。这是必要的机械校准，不能替代人工检查需求是否
完整、是否存在其他正确解、是否错误惩罚合理实现。

runner 只向 Agent 工作区复制 `fixture`；verifier 和参考成果不放入其中。这项文件隔离不等于
操作系统沙箱，真实质量评测还应使用产品正常的工作区权限。所有输出和实验声明放在 suite 之外，
避免评测产物或变体声明改变用例摘要。输出必须是新目录，不覆盖已有材料。

## 运行与比较

使用仓库固定 Python 解释器或 Python 3.11 以上、已经安装或完整装配的 Ash，以及专用评测 profile；profile 的模型接入和凭据按产品正常方式配置。
runner 仅复制 `config.toml` 和 `secrets`，为每次运行建立独立 profile、Git fixture 和 App Server。
开发树中的 CLI 需要将 `ASH_APP_SERVER_PATH` 指向完整运行包内的后端，并设置该包的
`ASH_PRODUCT_SERVICES_PATH`，以提供 tgrep 等产品资源；用 `just ash-package` 装配该运行包。

```bash
./scripts/.venv/bin/python -B scripts/agent_eval.py \
  --ash /absolute/path/to/ash \
  --profile-template /absolute/path/to/eval-profile \
  --model provider/model \
  --output /absolute/path/to/results/baseline \
  --repeat 3 --timeout-seconds 120 --split development

./scripts/.venv/bin/python -B scripts/agent_eval.py \
  --ash /absolute/path/to/ash \
  --profile-template /absolute/path/to/eval-profile \
  --model provider/candidate-model \
  --output /absolute/path/to/results/candidate \
  --repeat 3 --timeout-seconds 120 --split development \
  --baseline /absolute/path/to/results/baseline/report.json
```

默认权限模式为 `denyInteractiveRequests`；需要批准或用户输入时，产品中断任务并返回明确终态。
`--approval automaticReview` 使用产品自动审核，`bypassPermissions` 必须显式指定。比较要求任务内容、
profile 配置、重复次数、时间预算与权限模式相同；允许切换模型和产品二进制。
比较还要求任务与重复编号一一对应，缺少、重复或替换试次会明确拒绝。候选运行在创建输出和
启动任何产品／模型调用之前检查基线条件、试次身份和保留指标；不再等全部任务跑完才发现
基线不兼容。加 `--preflight-only` 可只检查输入和条件，输出 configuration 而不创建目录。
它不探测 provider、凭据和在线服务是否可用，不估算费用；正式运行前仍须固定准确模型、试次数和预算。

`--split development` 用于调优，`--split holdout` 用于冻结候选后的验收，`--split all` 保持原有默认行为。
没有 split 的自定义用例默认 development；空选择直接拒绝。配置保存 `caseSelection`，试次必须与
声明一致；两侧声明的选择不一致也拒绝比较。`suiteDigestVersion: 2` 对语义任务声明、fixture、参考成果、
verifier 所在目录及额外 `gradingResources` 文件／目录计算摘要；顶层 README 和示例实验文件不作为执行输入。
JSON 排版变化不使基线失效，实际文件内容和 grader 依赖变化仍会失效。评分器依赖放在同一 verifier
目录，其他规则文件在 suite.json 的 `gradingResources` 列表显式登记。旧摘要与 V2 不混合比较，升级后建立新基线。

需要改变工具、上下文或其他配置时，用 `--experiment /absolute/path/to/experiment.json` 声明实验。
从 [experiment.example.json](experiment.example.json) 复制到 suite 目录以外，为 control／candidate
分别填写 `variant`，保持相同 `id`、`hypothesis` 和 `changedFactors`；不要在两次运行之间修改 suite 内的声明文件。
允许变化的条件可以是 `model`、`ashExecutableDigest`、`appServerExecutable`、`productServices`、
`platform`、`python`，或 `profile:/...` 的配置叶路径。profile 路径使用 JSON Pointer 的 `~0`／`~1` 转义，
数组作为一个叶项；报告只保留语义值的 SHA-256，不复制值。双方都必须带同一实验声明。
实际变更超出声明时拒绝比较；任务、时间预算、权限模式和重复次数始终固定。该声明验证受控条件，
不直接修改工具、提示词或运行时，也不证明某项改动带来了因果收益。已有不带声明的报告不能事后
改写为某项新实验的 control；生成新假设后，用 control 声明建立新的受控基线。

每次任务保存 `events.jsonl`、`trace.json`、`turn-changes.json`、还原后的 `workspace/`、`changes.patch`、
执行与 verifier 输出、配置及 `result.json`。runner 为每次任务设置专用 `diagnostics/` 本地记录目录，
开启模型 attempt 与请求／响应捕获，并保留原始诊断文件。配置记录 CLI、后端和显式指定的产品服务清单的文件摘要，
便于区分模型变化与产品版本变化。汇总见 `report.json` 和 `report.md`。失败时保留后端诊断；
清理失败时报告 `retainedProfile`，可以用该 `ASH_HOME` 重试 `ash app-server daemon stop`。

在 Workbench 命令面板运行“开发人员：打开执行 Trace”（`ash.agentTrace.open`），再选择“导入 Trace”
打开报告对应的 `trace.json`。Sessions 的“查看执行 Trace”复用同一个编辑器，并默认读取当前会话。
Trace 保留历史事实、模型 attempt、Core／ModelService 的语义请求、响应、取消前部分输出及执行关系。
语义请求不等于 provider HTTP 字节；逐个 streaming chunk 未保存。`modelAttempts`、`failedAttempts`、
`cancelledAttempts` 和 `abandonedAttempts` 表示保留的 ModelService attempt 生命周期，
不能直接解释为 provider HTTP 重试次数。结果还原目前支持单 Git 仓库的完整 UTF-8 普通文件，
二进制、截断、符号链接、多仓库及未封存结果明确失败。

## 审阅、反馈与实验交接

```bash
./scripts/.venv/bin/python -B scripts/agent_eval_review.py review \
  --report /absolute/path/to/results/baseline/report.json \
  --output /absolute/path/to/results/review
```

生成 `review.md`、`review.json` 和 `feedback.template.json`。工具从原始 Trace 重新派生过程指标，
校验保存的通过判定与执行、成果还原及 grader 是否一致，并重算汇总；不信任旧的缓存总分。
另外从原始 events.jsonl 核对终态；缺失、无法解析或与报告不符的执行证据单列呈现，不能通过可信的 gate。
分组列出执行终态、验收失败、评分设施错误、成果缺失、清理失败和 Trace 观察，保留试次分母、
文件摘要与事件位置。通过任务中的工具失败也会出现，便于检查成功后的恢复成本；这些分组不是根因归类。
Markdown 每组最多展示十项，JSON 保留全部位置。原始产物必须与 report 保存在同一目录树。

在反馈模板的 findings 中写入已审阅的问题。下面的摘要占位值须从模板和 review.json 复制；
`eventId` 可省略，填写时必须是这份 Trace 中唯一且实际存在的事件。

```json
{
  "schemaVersion": 1,
  "reportSha256": "COPY_REPORT_SHA256_FROM_TEMPLATE",
  "findings": [
    {
      "caseId": "prefix-filter",
      "repetition": 1,
      "component": "unknown",
      "observation": "记录实际看到的失败与证据，不直接写成原因。",
      "hypothesis": "说明要检验的候选原因，以及预期改变什么行为。",
      "proposedChange": "写出具体修改对象和范围。",
      "acceptance": "写出恢复条件、必须保留的能力和回归条件。",
      "evidence": [
        {
          "artifact": "trace.json",
          "sha256": "COPY_ARTIFACT_SHA256_FROM_REVIEW",
          "eventId": "COPY_EXISTING_EVENT_ID"
        }
      ]
    }
  ]
}
```

component 可选 `prompt`、`tool`、`context`、`orchestration`、`runtime`、`model`、`grader`、`task`、
`interaction` 或 `unknown`；这是审阅者的调查对象，不是运行时推断。证据只能引用本试次已有的
Trace、事件、变更、评分和执行输出。报告摘要、文件摘要、试次或事件不符时拒绝反馈。
派生报告另外保存反馈文件的来源与摘要。
可用 `review --feedback /absolute/path/to/feedback.json` 校验并另存带反馈的审阅报告。

```bash
./scripts/.venv/bin/python -B scripts/agent_eval_review.py handoff \
  --report /absolute/path/to/results/baseline/report.json \
  --feedback /absolute/path/to/results/review/feedback.json \
  --finding 1 --experiment-id preserve-task-constraint \
  --factor ashExecutableDigest --factor appServerExecutable \
  --output /absolute/path/to/results/experiment
```

该例声明产品实现的变化；只改模型、某个配置叶项或产品资源时使用对应 factor，不能机械照抄。
交接保存 `handoff.md`、`handoff.json` 和双方实验声明，包含真实试次、证据摘要、审阅者假设、
修改范围与验收条件。它不执行改动或生成虚构根因。按交接建立新的 control，再使用生成的
candidate 声明、相同 development 任务与重复数运行候选；先加 `--preflight-only` 检查条件。

## 对照与回归检查

```bash
./scripts/.venv/bin/python -B scripts/agent_eval_review.py compare \
  --current /absolute/path/to/results/candidate/report.json \
  --baseline /absolute/path/to/results/control/report.json \
  --goal quality --output /absolute/path/to/results/comparison
```

两侧独立重新分析，生成带来源的 `comparison.json` 和 `comparison.md`。不需要重新调用模型。

| goal                            | 本批次通过条件                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------- |
| `quality`                       | 至少一个原失败试次恢复，没有原通过试次回归                                        |
| `regression`                    | 没有观察到回归；同分可通过，但不能证明改进                                        |
| `latency`                       | 没有验收回归；双方均通过的试次具备完整耗时测量，且平台／Python 条件一致，均值下降 |
| `input-tokens`／`output-tokens` | 没有验收回归；双方均通过的试次具备对应维度的完整用量和调用覆盖，均值下降          |

评分、成果或必要证据缺失为 `inconclusive`；明确回归或没有达到所选目标为 `failed`。
退出 0 表示本批次 gate 通过，1 表示失败或证据不足，2 表示输入／比较条件错误。
资源检查另列成功试次和排除分母，不把更快的失败或缺失用量算作收益，也不声称总体成本下降。
所有 gate 都是有限批次观察，不提供统计显著性、泛化保证或自动发布决定。

冻结候选后，对相同 holdout 任务分别运行 control 和 candidate，再用 `--goal regression` 检查。
holdout 若用于下一轮修改或选择候选，应转为 development 并补充新的保留任务家族。
当前三个种子只是机制演示；真正的质量结论需要从实际 Ash 任务扩充、人工校准且未用于调优的案例。

## Trace 证据与评测结论

[只读 Trace 分析层](../../scripts/agent_eval_trace.py)为 runner 提供过程指标，不执行历史操作，
不改变任务通过条件。分析时核对 Trace 与本次执行的 Session／Thread／Turn 身份，保留各流本地顺序，
不按时间戳制造跨 Thread 的总顺序。工具调用／结果按 Thread、Turn、tool call 身份区分；
工具错误和 loop 停止都是观察，不能单独判定任务失败、无效重试或提示词错误。

报告格式为 V2，每次运行的 `trace.analysisVersion` 为 2；比较兼容已有分析 V1。主要内容如下：

- `usage` 分别记录输入、输出、缓存读取／写入和推理用量的实报小计、已报告调用数、缺失数与完整度。
  没有任何实报值时为 `null`，供应商实际报告的 0 保留为 0；已有部分用量时保留小计，完整度为 false。
  `inputTokensReported`／`outputTokensReported` 仍为便捷字段；不加入估算或另算货币成本。
  各维度完整度及 `usageComplete` 只覆盖已保留的持久用量账目。诊断 V2 的 `accountingLinks` 只接受
  实际提交后的 invocation ID、所属 Thread／Turn 和历史序号；旧 V1 的关联保持未知。
  旧 V1 仍可展示实报用量及参与成果对照，但不进入完整用量比较。
  失败／取消／放弃的 attempt 不保证有账目；`usageComparisonComplete` 另外要求诊断覆盖完整、
  V2 中调用和账目均已关联且没有这些 attempt，
  不满足时仍展示实报小计，但不进入完整用量比较。`modelCalls` 是账目记录数，不是全部 provider 请求数。
- `diagnosticRecordingStatus` 和 `diagnosticEvidenceComplete` 分别描述录制状态与导出证据覆盖。
  `evidenceCoverage` 记录丢失记录、待写记录、未关联调用／未观察到账目、遗漏／缺失／截断正文和未闭合／缺少起点的 attempt。旧证据的关联覆盖是 `null`，不是 0。
  诊断关闭或不可用且没有观测时，attempt 计数为 `null`。
  中途开启录制而未观察到已有账目，或回执找不到对应历史时，不声称完整覆盖；重复回执明确拒绝分析。
- `summary.grading` 单列已评分、评分器错误、评分超时和未知数量。verifier 退出 0 表示通过，1 表示成果不通过，其他退出码或无法启动表示评分设施错误；错误不视为任务已得到有效评分。全运行通过率仍要求产品完成、完整成果还原和有效验收同时成立。
- `toolCalls`／`toolResults`／`failedToolResults` 统计保留的请求与结果，另外报告尚无结果的请求和未匹配结果。
  `loopDecisions` 保留宿主已有的循环动作、原因、停止原因及消息阶段；没有保留决策时标明证据不可用。
- `instructionSelections` 指向 Turn 接受或模式变化的事件，保留冻结组合的身份、revision、模式、模型及工具 profile。
  `snapshotDigest` 是对完整组合进行键排序、紧凑 UTF-8 JSON 编码后的 SHA-256；不复制提示词正文，
  不替代协议摘要，也不证明某次请求实际包含全部指导，实际输入仍须查语义请求。
- `observations` 保留上述问题的 Thread、Turn、事件 ID、sequence 和持久／诊断来源。
  Markdown 报告每次最多展示 40 项并标明数量，完整列表保存在 `result.json`；导入 Trace 后按事件 ID 过滤。

汇总的 `repeatReliability` 展示本批次“至少一次通过”和“每次都通过”的任务比例，明确列出重复次数。
这些是有限试次的实际观察，不当作 pass@k／pass^k 概率估计或泛化结论。
`processMetrics` 对调用、工具错误、耗时和输入／输出用量分别列出可报告与完整的运行数及均值。
调用计数描述保存事件，诊断与用量指标的完整度分别检查；缺失数据不会补成 0。

基线比较只在同一任务、同一重复编号且双方测量完整的运行上计算过程差值，同时保留排除数量、
任务通过率、观察到的恢复与回归试次。重复编号不意味着相同随机采样；这些差值不提供统计显著性。
平台或 Python 版本记录不同的运行不计算耗时差值。`changedFactors` 列出记录到的模型、产品摘要与环境差异，
多项同时变化时需要进一步隔离实验。资源减少仍须结合成果验收判断，不能把更快的失败算作优化。
旧 V1 报告可以参与结果对照，但未声明新分析完整度的 Trace 指标不参与过程差值。

## 用例如何扩充

1. 从实际失败的 Trace 或人工验收失败中选取一个清楚的问题，记录来源、失败类型和复现条件。
2. 去掉与问题无关的文件和敏感内容，将执行前文件放入 `fixtures/<case-id>/`。
3. 写出用户需求和可观察的验收标准；在 `suite.json` 登记 prompt、来源和 verifier。
4. 将 verifier 放在 `verifiers/`，覆盖正常、边界和原失败行为；登记 `referenceSolution`、`initialVerifierStatus` 和 split。用 audit-suite 确认已知错误解被拒绝、正确解通过，人工检查是否接受其他合理实现。
5. 先运行产品契约 smoke，再用受支持的真实模型重复运行；按失败类型审阅 Trace，保留一部分任务供后续验收，避免只针对已知用例调提示词。

## 验证执行链路

```bash
just test-python scripts
ASH_AGENT_EVAL_TEST_BINARY=/absolute/path/to/ash \
  ./scripts/.venv/bin/python -B -m unittest discover -s scripts -p test_agent_eval_product.py -v
```

第二条使用本地脚本化 HTTP 模型，经过真实产品的模型 stream、工具调用、文件变更、Trace 导出、
结果还原及独立 verifier。它先校准评分器，再比较“只声明完成”的 control 与真正通过工具修复的
candidate，并生成审阅、反馈和实验交接；另检查模型失败、一次失败后重试、带部分输出的 Turn 超时
仍有正确终态及完整诊断产物。
它不使用真实模型凭据，也不提供模型效果分数；普通 Python 测试默认跳过
该显式产品测试。

设置 `ASH_AGENT_EVAL_TEST_OUTPUT` 可保留该产品测试的报告目录；再将其中一份 `trace.json` 的绝对路径
通过 `ASH_AGENT_TRACE_EVAL_FIXTURE` 传给 `test/smoke/areas/sessions/trace.spec.ts`，可在 Web 和 Electron 中
验证真实评测 Trace 的导入与模型调用详情。
