# 行为与兼容性

- AC-1：按 Codex 的 CODEX_HOME、auth.json 结构、file/keyring/auto 存储配置读取已有 ChatGPT 凭据，每次模型请求重新读取。不接受 API key 代替订阅。
- AC-2：认证存储缺失，或 Ash 管理的凭据永久失效且用户再次登录时，启动设备登录。成功后以 Codex 的 auth_mode、OPENAI_API_KEY、tokens、last_refresh 结构创建 auth.json；首次创建不覆盖已存在文件；重新登录仅替换授权开始时的同一失效记录，不覆盖并发修改。文件权限为 0600。
- AC-3：检测到 Codex 时只读复用；没有可发现的 Codex 安装时由 Ash 维护。按 Codex 的五分钟到期窗口或未知到期时间下的八天规则刷新，保留响应省略的 token 字段并写回 last_refresh。永久失败转为需要重新登录，暂时失败不销毁凭据。
- AC-4：复用模式断开只记录 Ash profile 的停用状态，不影响 Codex 登录；自管模式登出清除所维护的当前账户认证。重新连接仍有效的已有凭据立即完成，无需浏览器。
- AC-5：账户刷新能观察 Codex 外部更新和退出；失败、取消及并发登录不会留下错误完成状态或覆盖外部文件。
- AC-6：离线验证兼容结构、缺失、过期、损坏、并发创建、取消、断开重连和 token 不泄漏。真实请求只用 Luna / low，验证读取前后原始认证文件内容一致。

兼容参照：`../codex` 提交 `d3ee328ee6af47ba540a489bb590cb96acbdd8ba` 的 login/src/auth/storage.rs、login/src/auth/manager.rs、login/src/token_data.rs、login/src/device_code_auth.rs、login/src/server.rs、utils/home-dir/src/lib.rs。保留 Ash 的请求来源标识，不冒充 Codex。

已创建的模型实例同样必须在普通请求和流式请求之前重新读取凭据；不能将 token 缓存在模型实例中。测试需在复用同一模型实例的情况下验证外部凭据更新、Ash 断开以及文件删除。

共享协议新增立即连接成功结果，由 login 控制层发布完成通知。浏览器账户适配器只在有授权挑战时打开浏览器；TUI 刷新账户。凭据只由 ash-chatgpt 持有，传输层和前端只接收账户摘要。

不支持的加密凭据存储必须明确报告，禁止误读其他存储或写入一个 Codex 不会使用的文件；这项边界应在验收中单独记录。

## 认证维护修正

用户确认：无 Codex 时由 Ash 维护 auth，包括刷新；以后检测到 Codex 时切换为只读复用。管理选择不依赖文件是否存在，也不向 auth.json 添加 Ash 字段。

- AC-7：多个 Ash 实例对同一 Codex home 的刷新和重新登录使用进程间锁。锁后重读，提交前校验原记录和存储位置，观察到其他写入时不覆盖；检测到 Codex 后不再启动新的刷新。
- AC-8：模型收到明确 HTTP 401 且尚未交付事件时，先重读再按管理模式刷新，最多重试一次。流式请求已交付任何事件时不能重放。永久失效后，用户可在 Ash 发起新的设备登录，成功前保留旧记录，成功后受校验地替换。
- AC-9：测试固定模拟管理模式，不依赖开发机安装状态。真实 Luna / low 测试强制只读，真实 refresh token 不用于刷新测试。

安装发现覆盖 PATH、常见 macOS 应用位置和 VS Code OpenAI 扩展中的 Codex 可执行文件。发现可执行文件后保守地让 Codex 管理；不启动该程序。Codex 不使用 Ash 的文件锁，跨产品交接仍需通过重读和提交前比对保护已观察到的修改，不能声称已获得两个产品之间的原子锁。
