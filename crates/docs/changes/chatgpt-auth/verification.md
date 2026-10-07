# 认证维护修正验收

日期：2026-09-07。对应当前 intent.md、spec.md 与 plan.md。此次修正把凭据复用与维护分开：有可发现的 Codex 安装时只读复用，没有时由 Ash 维护。没有修改账户 RPC 格式或前端布局。

验证时 Git HEAD 为 `4655cb3ebefcd11ce98c982ad35b603b6e905fa7`。工作区包含并行任务的未提交改动，均保留。对修改/未跟踪的 `.rs`、`.toml`、`.lock`、`.ts` 文件按路径排序，计算 `路径 + NUL + 内容 + NUL` 的 SHA-256（删除文件使用 `<deleted>`）：`e53273379989dc21c7db0020bb115ef6668e23135b4aedcaa8baa622bd9e48c9`，59 个文件。该指纹标识验证候选，不表示其他任务的行为也在本次覆盖范围内。

## 已通过

| 行为            | 证据                                                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 无 Codex 时续期 | 模拟 Ash 管理模式，验证已过期和即将过期 token 更新；有 Codex 时不发送刷新请求。                                                        |
| Codex 刷新规则  | 五分钟到期窗口；未知到期时间（包括不透明 access token）下的八天 last_refresh 规则。                                                    |
| 轮换与格式      | 保留响应未返回的 token 字段、账户及其他元数据，更新 last_refresh。官方 Codex CLI 可读取刷新后的文件。                                  |
| 并发与外部更新  | 两个管理实例仅执行一次刷新；更新前后校验记录，已观察到其他写入时不覆盖。                                                               |
| 失效与重新登录  | 暂时失败不销毁仍有效凭据；expired/reused/invalidated/invalid_grant 等永久失败停止反复刷新，随后在 Ash 完成设备登录并替换同一失效记录。 |
| 登出            | 自管模式清除维护的当前账户认证；Codex 复用模式只断开 Ash，原认证保留。                                                                 |
| 401 恢复        | 普通和流式请求仅在明确 HTTP 401 且无交付事件时，重读/刷新后重试一次；不切换账户。再次拒绝后不再刷新。                                  |
| 不重放          | 有部分输出的流，以及 HTTP 已接受但以认证错误结束的空流，均不重放。                                                                     |
| 真实模型链路    | 仅 `gpt-5.6-luna` / `low`，真实流式返回 `ASH_AUTH_OK`；真实 auth.json 内容未改变。                                                     |

## 执行记录

- `just test ash-chatgpt`：20 项通过，3 项显式测试保持 ignored。覆盖路径、模式、首次创建、只读、续期、错误分类、并发、重新登录、登出、取消和关闭后的迟到结果。
- `just test ash-model-provider --lib chatgpt`：5 项通过，真实测试默认 ignored。所有模型请求固定 Luna / low，模拟刷新使用合成 token。
- `just test ash-chatgpt maintenance::tests::codex_cli_accepts_refreshed_credentials -- --ignored --exact`：通过。官方 `codex login status` 读取临时目录内的合成刷新结果，未改写该文件，不调用模型。
- `just test ash-model-provider --lib tests::live_chatgpt_luna_low_uses_the_ash_model_pipeline -- --ignored --exact`：最终通过，6.04 秒。测试强制 `ChatGptAuthManagement::Codex`，认证客户端不具备真实刷新能力，因此不会用用户的 refresh token 做刷新实验。
- 实测首次尝试在约 10 秒后失败，原断言没有保留错误类别，不能据此确定原因。补充不含服务端原文、headers 或凭据的错误分类及事件数诊断后，同一 Luna / low 测试重跑通过；没有更换模型或调整思考强度。
- 最终 `just check ash-app-server`：通过，覆盖生产后端及相关依赖。
- `git diff --check`：通过。

## 范围与限制

- 管理选择根据 PATH、常见 macOS 应用位置和 VS Code OpenAI 扩展中的可执行文件探测；不启动 Codex，也不在 auth.json 中写入 Ash 管理字段。探测并不覆盖任意自定义安装目录。
- Ash 实例之间使用文件锁。Codex 不遵守该锁，因此安装交接与提交前检查不是跨产品原子互斥；保护的是已观察到的外部修改，不能承诺消除所有跨产品竞态。
- 普通文件和直接钥匙串支持维护；加密 secrets 存储和仅进程认证仍不支持。仅钥匙串且没有凭据时的首次登录沿用明确拒绝的边界。真实系统钥匙串读写未实测。
- 刷新、重新登录和登出测试均使用临时目录与合成凭据。未刷新或删除用户真实认证。真实模型调用只使用 Luna / low。
- 本次为自查，没有独立审查。前序终端与浏览器/Electron 入口验证仍作为既有界面证据；本次未改变其布局或协议，不重复执行完整 UI 测试。
- 磁盘接近耗尽时清理了较旧的增量构建缓存，保留源文件、产物和最近缓存。未执行完整 workspace 验证。
