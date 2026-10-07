# 复用 Codex 登录

Ash 使用用户已有的 Codex 订阅登录；没有凭据时，通过设备码登录生成 Codex 可直接识别的认证文件，安装 Codex 后无需重新迁移。

已有 Codex 管理的凭据只读使用；本机没有可发现的 Codex 安装时，由 Ash 按 Codex 的认证规则维护并刷新。模型调用和 Agent Loop 由 Ash 负责。CODEX_HOME 未设置时使用用户主目录的 `.codex`，不使用仓库内的 `.codex`。

用户限定所有本次模型验证使用 `gpt-5.6-luna`、`low`；实际请求必须明确设置这两个值，不能通过默认模型或默认思考强度推断。
