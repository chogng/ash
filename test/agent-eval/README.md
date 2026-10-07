# Agent 任务评测

运行 `scripts/agent_eval.py`，让真实 `ash exec` 在固定初始文件上执行任务，再由独立 Python verifier
验收该 Turn 保存的最终文件。模型说“完成”只表示执行结束；执行成功、完整结果还原和 verifier
通过三者同时成立，任务才通过。

当前有三个手写种子用例：前缀筛选、混合换行和配置原子更新。它们覆盖基础契约，不能代表实际
开发任务的整体质量，也不能据此宣称某个模型更好。用例不会要求固定搜索顺序、工具顺序或回答措辞。

## 运行与比较

使用已经安装或完整装配的 Ash，以及专用评测 profile；profile 的模型接入和凭据按产品正常方式配置。
runner 仅复制 `config.toml` 和 `secrets`，为每次运行建立独立 profile、Git fixture 和 App Server。
开发树中的 CLI 需要将 `ASH_APP_SERVER_PATH` 指向完整运行包内的后端，并设置该包的
`ASH_PRODUCT_SERVICES_PATH`，以提供 tgrep 等产品资源；用 `just ash-package` 装配该运行包。

```bash
python3 -B scripts/agent_eval.py \
  --ash /absolute/path/to/ash \
  --profile-template /absolute/path/to/eval-profile \
  --model provider/model \
  --output /absolute/path/to/results/baseline \
  --repeat 3 --timeout-seconds 120

python3 -B scripts/agent_eval.py \
  --ash /absolute/path/to/ash \
  --profile-template /absolute/path/to/eval-profile \
  --model provider/candidate-model \
  --output /absolute/path/to/results/candidate \
  --repeat 3 --timeout-seconds 120 \
  --baseline /absolute/path/to/results/baseline/report.json
```

默认权限模式为 `denyInteractiveRequests`；需要批准或用户输入时，产品中断任务并返回明确终态。
`--approval automaticReview` 使用产品自动审核，`bypassPermissions` 必须显式指定。比较要求任务内容、
profile 配置、重复次数、时间预算与权限模式相同；允许切换模型和产品二进制。

每次任务保存 `events.jsonl`、`trace.json`、`turn-changes.json`、还原后的 `workspace/`、`changes.patch`、
执行与 verifier 输出、配置及 `result.json`。runner 为每次任务设置专用 `diagnostics/` 本地记录目录，
开启模型 attempt 与请求／响应捕获，并保留原始诊断文件。配置记录 CLI、后端和显式指定的产品服务清单的文件摘要，
便于区分模型变化与产品版本变化。汇总见 `report.json` 和 `report.md`。失败时保留后端诊断；
清理失败时报告 `retainedProfile`，可以用该 `ASH_HOME` 重试 `ash app-server daemon stop`。

在 Workbench 命令面板运行“开发人员：打开执行 Trace”（`ash.agentTrace.open`），再选择“导入 Trace”
打开报告对应的 `trace.json`。Sessions 的“查看执行 Trace”复用同一个编辑器，并默认读取当前会话。
Trace 保留历史事实、模型 attempt、Core／ModelService 的语义请求、响应、取消前部分输出及执行关系。
语义请求不等于 provider HTTP 字节；逐个 streaming chunk 未保存。`modelAttempts`、`failedAttempts`、
`cancelledAttempts` 和 `diagnosticRecordingStatus` 帮助识别重试与证据缺口。用量缺失时报告
`usageComplete: false`，不会补成估算用量。结果还原目前支持单 Git 仓库的完整 UTF-8 普通文件，
二进制、截断、符号链接、多仓库及未封存结果明确失败。

## 用例如何扩充

1. 从实际失败的 Trace 或人工验收失败中选取一个清楚的问题，记录来源、失败类型和复现条件。
2. 去掉与问题无关的文件和敏感内容，将执行前文件放入 `fixtures/<case-id>/`。
3. 写出用户需求和可观察的验收标准；在 `suite.json` 登记 prompt、来源和 verifier。
4. 将 verifier 放在 `verifiers/`，覆盖正常、边界和原失败行为。先确认初始 fixture 会失败，再确认已知正确解会通过。
5. 先运行产品契约 smoke，再用受支持的真实模型重复运行；按失败类型审阅 Trace，保留一部分任务供后续验收，避免只针对已知用例调提示词。

## 验证执行链路

```bash
just test-python scripts
ASH_AGENT_EVAL_TEST_BINARY=/absolute/path/to/ash \
  python3 -B -m unittest discover -s scripts -p test_agent_eval_product.py -v
```

第二条使用本地脚本化 HTTP 模型，经过真实产品的模型 stream、工具调用、文件变更、Trace 导出、
结果还原及独立 verifier，并检查模型失败、一次失败后重试、带部分输出的 Turn 超时仍有正确终态及完整诊断产物。
它不使用真实模型凭据，也不提供模型效果分数；普通 Python 测试默认跳过
该显式产品测试。

设置 `ASH_AGENT_EVAL_TEST_OUTPUT` 可保留该产品测试的报告目录；再将其中一份 `trace.json` 的绝对路径
通过 `ASH_AGENT_TRACE_EVAL_FIXTURE` 传给 `test/smoke/areas/sessions/trace.spec.ts`，可在 Web 和 Electron 中
验证真实评测 Trace 的导入与模型调用详情。
