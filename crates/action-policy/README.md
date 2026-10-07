# `ash-action-policy`

> 本 README 负责最终 action authority 的 crate 契约。确定性规则语言、layer merge 和 semantic
> revision 由 [`ash-execpolicy`](../execpolicy/README.md) 负责；端到端权限语义见
> [`docs/permissions.md`](../../docs/permissions.md)，Guardian 审核系统见
> [`docs/guardian.md`](../../docs/guardian.md)。

`ash-action-policy` 是执行前最终决策 authority。它消费 immutable `ExecPolicySnapshot`、已完整
materialize 的 action、sandbox compatibility、exact one-action grants 和 advisory classifier 输出，
产生 typed `ExecutionDecision`。它不解析或持久化规则，不执行 Tool，不选择 sandbox backend，也不
显示 approval UI。

## 公共契约与所有权

| 领域                | 关键类型                                                                                   | 所有权                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Action identity     | `ResolvedAction`；protocol 的 `ActionDigest`, `ActionKind`, `ActionProvenance`             | 本 crate 保存规则求值所需的完整动作；共享身份和来源由 protocol 定义，host 负责准确解析                    |
| Capability          | protocol 的 `Capability`, `CapabilityKind`, `CapabilitySet`                                | exact `kind + scope`，canonical ordering；规则映射和授权约束由本 crate 执行                               |
| Safe point          | `ActionReviewRequest`；protocol 的 `ActionPolicyRevision`, `ActionReviewPhase`             | 本 crate 持有沙箱与执行上下文；共享数据保持与具体策略引擎无关，request 与当前 snapshot 必须 revision 相等 |
| Deterministic input | `ash_execpolicy::ExecPolicySnapshot`                                                       | 只消费；selector、layer、revision 与 rule source 属于 `ash-execpolicy`                                    |
| Exact grants        | `DeterministicPolicyGrant`, `UnsandboxedGrant`, `AutoReviewGrant`, `PermissionBypassGrant` | 都绑定 action digest、完整 capabilities 和 action-policy revision                                         |
| Advisory port       | `ActionClassifier`；protocol 的 `ClassifierAssessment`, `ClassifierRecommendation`         | 分类器接口及建议校验由本 crate 定义；建议和绑定结果直接使用 protocol 类型                                 |
| Final outcome       | `ExecutionDecision`, `BlockReason`, `ApprovalRequest`, `SaferActionRequest`                | caller 必须按 typed branch durable 记录并执行                                                             |

共享审核类型的唯一入口是 [`protocol/guardian.rs`](../protocol/src/guardian.rs)，本 crate 不重新导出
这些类型；调用方直接依赖 protocol，避免为读取数据而依赖授权实现。

`derive_action_policy_revision` 把 exec-policy revision、exact-grant snapshot revision 和
reviewer policy revision 组合为一个 safe-point identity。只更新其中一项也会使旧 request/grant
失效。

## 文件与调用关系

```text
src/action.rs      完整动作、沙箱执行上下文、规则映射和策略版本计算
src/classifier.rs  分类器接口与 validate_recommendation 授权能力约束校验
src/grant.rs       explicit exact user grant
src/grants.rs      exact grant snapshot lookup
src/decision.rs    typed decisions 与 engine-only grants
src/engine.rs      唯一最终 precedence entry
```

```text
ActionPolicyEngine::decide
→ verify ActionPolicyRevision
→ ExecPolicySnapshot::evaluate
   → Deny              → Block
   → RequireSandbox    → RunSandboxed，或 unavailable/denial 时 Block
   → RequireApproval   → AskUser
   → AllowUnsandboxed  → RunExecPolicyGranted(exact rule + revisions + action binding)
   → Continue          → continue
→ exact UserAllowlist match → RunUnsandboxed
→ initial sandbox-supported action → RunSandboxed
→ ActionClassifier::classify
→ validate assessment digest/revision/capability constraints
→ automatic review risk/authorization matrix → grant / revise / ask / block
```

这一顺序是安全 contract：deterministic rule 先于历史 exact grant，sandbox fast path 先于模型审查；
classifier failure 按显式 `ReviewFailurePolicy` fail closed 或转人工。

## 关键实现符号

| Symbol                              | 职责                                                       | 漂移信号                                           |
| ----------------------------------- | ---------------------------------------------------------- | -------------------------------------------------- |
| `ActionPolicyEngine::decide`        | 唯一 top-level final decision entry                        | host 在外部重新实现 precedence                     |
| `evaluate_exec_policy`              | 把 trusted action fields 投影为 `ExecPolicySubject`        | 用 summary 或未 materialize 字符串参与授权         |
| `apply_exec_policy`                 | 把纯 effect 映射为 sandbox、approval、block 或 exact grant | `ash-execpolicy` 自己签发执行 authority            |
| `ensure_revision`                   | request/engine safe-point equality                         | mismatch 被降级为普通 Tool failure                 |
| `UserAllowlist::matching_grant`     | exact digest + capabilities + revision lookup              | Tool 名称或 command prefix 被当成 historical grant |
| `apply_assessment`                  | classifier identity 与 capability constraints 复检         | 约束只存在于某个 classifier implementation         |
| `automatic_approval_decision`       | automatic review risk/authorization gate                   | classifier 或外层直接构造 `AutoReviewGrant`        |
| `DeterministicPolicyGrant::matches` | Core execution-time recheck                                | durable authority 不再绑定 exact action/revision   |

## 失败语义

| Condition                                       | Outcome                                            |
| ----------------------------------------------- | -------------------------------------------------- |
| engine/request revision 不同                    | `Err(PolicyError::RevisionMismatch)`               |
| allow effect 缺少 exact rule source             | `Err(PolicyError::ExecPolicyAuthorityMissing)`     |
| classifier digest/revision 不匹配               | `Err(PolicyError::ClassifierBindingMismatch)`      |
| require-sandbox 但 action 不支持或已确认 denial | `Block(SandboxRequiredButUnavailable)`             |
| classifier failure                              | 按 `ReviewFailurePolicy` 返回 `Block` 或 `AskUser` |
| approve/revise capability 违反约束              | `Block(ReviewFailed)`                              |

`PolicyError` 是调用与 binding contract 被破坏；`Block` 是合法请求的 policy outcome，两者不能互换。

## 验证与修改影响

```text
just verify ash-action-policy
bazel test //crates/action-policy:action-policy-unit-tests
```

测试覆盖 deterministic effect mapping、exact grant binding、sandbox denial、revision mismatch、
classifier constraints、风险矩阵和失败策略。新增 effect/decision/capability 时必须同步这些组件：
包括 `ash-execpolicy`、Core scheduler/durable authority、App Server materializer、Guardian 审查 schema、
protocol contract tests 和权限文档。
