# `ash-execpolicy`

`ash-execpolicy` 是后端无关的确定性执行规则层。它把 host、organization、user 与 workspace
提供的 immutable rule layers 组合成一个带 semantic revision 的 snapshot，并对 host 已完整
materialize 的 action subject 做纯求值。

它不执行 Tool、不选择 sandbox backend、不调用 Guardian、不显示 approval UI，也不签发
execution grant。最终执行决定和 exact action binding 属于
[`ash-action-policy`](../action-policy/README.md)；跨 crate 权限语义由
[`docs/permissions.md`](../../docs/permissions.md) 统一说明。

## 公共契约

| 类型                   | 责任                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `ExecPolicySubject`    | action digest、kind、可信来源、capability 与可选 command/network projection         |
| `ExecPolicySelector`   | exact digest、source、command prefix、network、capability scope 与显式组合          |
| `ExecPolicyLayer`      | Host / Organization / User / Workspace rule collection                              |
| `ExecPolicySnapshot`   | validation、canonical layer ordering、semantic revision 与 deterministic evaluation |
| `ExecPolicyEvaluation` | effective effect、exact source rule 与完整 matched-rule audit                       |
| `ExecPolicyAmendment`  | expected-revision 约束下的纯 User layer upsert/remove；不做文件 I/O                 |

所有匹配规则中最严格的 effect 生效：`Deny > RequireSandbox > RequireApproval >
AllowUnsandboxed > Continue`。因此较低信任层不能用 allow 覆盖更严格的上层约束。没有匹配时只
允许 `Continue` 或 fail-closed `Deny` 两种 snapshot default；不存在隐式 default allow。

## 依赖与运行路径

```text
Config / trusted host adapters
  → ExecPolicyLayer[]
  → ExecPolicySnapshot::new
  → ExecPolicySnapshot::evaluate
  → ExecPolicyEvaluation
  → ash-action-policy::ActionPolicyEngine
  → final ExecutionDecision / exact grant
```

`ExecPolicySnapshot` 不读取配置文件。Config authority 负责来源、trust、持久化和 atomic
replacement；本 crate 只负责 typed document 的 validation、merge semantics、revision 与纯变换。

## 关键实现符号

| Symbol                         | 职责                                                                                  | 漂移信号                                  |
| ------------------------------ | ------------------------------------------------------------------------------------- | ----------------------------------------- |
| `ExecPolicySnapshot::new`      | layer validation、network name normalization、canonical ordering 与 semantic revision | config adapter 自己实现第二套 hash/merge  |
| `ExecPolicySnapshot::evaluate` | selector match、effect precedence 与完整 audit                                        | effect 直接变成 Tool authority            |
| `validate`                     | ID、rule 与 Workspace 不可扩权 invariant                                              | Workspace layer 可产生 `AllowUnsandboxed` |
| `ExecPolicySelector::matches`  | 只匹配 host-materialized typed subject                                                | 解析 summary 或 shell 字符串              |
| `ExecPolicyAmendment::apply`   | revision-bound User layer 纯变换                                                      | 读取或写入 config/storage                 |

`ash-config::compose_exec_policy` 是当前持久化/来源 adapter：User rules 位于用户 `config.toml`，
Workspace rules 位于 strict-read `.ash/config.toml` 且只能收紧。App Server 在运行时安全点把它们与
Host layer 组合，并把 semantic revision 纳入 `ActionPolicyRevision`。

## 修改约束

- selector 只能消费 host materialized 的结构化字段，不能解析 summary；
- command prefix 匹配 tokenized argv，不能对 shell string 做不可靠的 substring 判断；
- network protocol 与 DNS host 在 snapshot 构造时规范化；domain suffix 必须按 DNS label boundary 匹配；
- Workspace layer 不能通过 amendment API 扩权；
- evaluation 不能构造 action-policy grant 或直接返回 Tool execution authority；
- 新增 selector/effect 时必须同步 action-policy mapping、config schema 和 precedence 测试。

```text
cargo test -p ash-execpolicy
bazel test //ash-rs/execpolicy:execpolicy-unit-tests
```
