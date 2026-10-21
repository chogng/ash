# Windows UAC 保存验收手册

在 Windows 实机或有交互桌面的虚拟机上，用待验收的 Ash 源码执行。目标是验证真正的 UAC 成功与取消，以及文件内容、编辑器状态和 ACL。本次按用户确认的范围，仅验收当前管理员成员账户的未提升权限进程；不新建账户，不将另一标准用户输入管理员凭据作为本次完成条件。其他账户身份不在本次结论覆盖范围内。

## 1. 准备环境

- 将待验收源码和必要的未提交修改同步到 Windows；只拉取远端分支不包含未提交文件。确认 `test/smoke/areas/editor/elevated-save.spec.ts` 和 `crates/file-system/src/elevated.rs` 都存在，并记录提交与工作树差异。
- 按 [Windows 开发环境](build.md#windows-开发环境) 安装工具，在仓库根目录打开普通的 Visual Studio Developer PowerShell；不要选择“以管理员身份运行”。
- 保持 UAC 开启，测试期间留在 Windows 交互桌面。
- 由代理协助时，每轮先发清楚“取消点否”或“批准点是”，等待操作者确认已读且准备好，再启动该轮命令；不要启动后才说明操作。
- 准备一个可以批准 UAC 的管理员账户。密码只在 Windows 系统授权窗口输入。
- 检查当前终端没有管理员权限，并记录源码版本：

```powershell
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '请关闭此终端，使用非管理员终端运行测试。'
}
git rev-parse HEAD
git status --short
```

- 安装依赖并准备 Windows 测试产物；任一步失败先停下并保存输出：

```powershell
pnpm install
if ($LASTEXITCODE -ne 0) { throw 'pnpm install 失败' }
just install
if ($LASTEXITCODE -ne 0) { throw 'just install 失败' }
pnpm run pretest:smoke:desktop
if ($LASTEXITCODE -ne 0) { throw '测试产物准备失败' }
```

## 2. UAC 取消

- 执行以下命令。测试会自动点击 Ash 的管理员重试按钮；出现真正的 Windows UAC 窗口时，点击“否”或“取消”。

```powershell
$env:ASH_TEST_SYSTEM_AUTHORIZATION = 'cancel'
try {
    pnpm run smoketest-no-compile test/smoke/areas/editor/elevated-save.spec.ts --grep 'real system authorization cancel' --output .build/desktop/playwright/elevation-windows-cancel
    if ($LASTEXITCODE -ne 0) { throw 'UAC 取消用例失败，请保留日志和测试产物。' }
} finally {
    Remove-Item Env:ASH_TEST_SYSTEM_AUTHORIZATION -ErrorAction SilentlyContinue
}
```

- 亲眼确认弹出了 Windows UAC，记录程序名称和发布者。未弹出 UAC，或提示授权能力不可用，不能认定取消交互已通过。
- 终端结果为 **1 passed**，不能是 skipped 或未匹配到用例。
- 自动断言通过：磁盘仍是原内容，编辑器保留修改并保持 dirty，文件 ACL 未变，输入焦点恢复。

取消用例同时断言错误明确属于“用户拒绝授权”，不能由通用保存失败或“系统授权不可用”代替；仍需确认实际 UAC 出现并由你取消。

## 3. UAC 成功

- 执行以下命令，在真正的 Windows UAC 窗口批准；要求密码时输入管理员账户的密码。

```powershell
$env:ASH_TEST_SYSTEM_AUTHORIZATION = 'approve'
try {
    pnpm run smoketest-no-compile test/smoke/areas/editor/elevated-save.spec.ts --grep 'real system authorization approve' --output .build/desktop/playwright/elevation-windows-approve
    if ($LASTEXITCODE -ne 0) { throw 'UAC 成功用例失败，请保留日志和测试产物。' }
} finally {
    Remove-Item Env:ASH_TEST_SYSTEM_AUTHORIZATION -ErrorAction SilentlyContinue
}
```

- 亲眼确认 UAC 出现并成功批准，终端结果为 **1 passed**。
- 自动断言通过：磁盘为修改后的完整内容，BOM 和 CRLF 保留，编辑器清除 dirty，文件 ACL 未变，输入焦点恢复。
- 本次只要求当前账户的取消和批准分别通过，不切换或创建标准用户账户。

每个用例使用独立临时工作区，并在 `finally` 恢复目录权限。用例超时后先保存输出，正常结束测试；不要直接关闭整个终端。测试等待系统授权约 180 秒，需要及时响应。

## 4. 回传结果

- 填写并回传下表及两次测试的终端输出；失败时附对应输出目录里的 `error-context.md` 和 `trace.zip`（若生成）。密码和凭据不要回传。

| 项目                                       | 记录 |
| ------------------------------------------ | ---- |
| Windows 版本、x64/ARM64                    | 待填 |
| 源码提交及未提交修改是否同步               | 待填 |
| 测试账户：当前管理员成员的普通终端         | 待填 |
| UAC：确认按钮／管理员凭据输入              | 待填 |
| 系统窗口显示的程序名称、发布者             | 待填 |
| 取消：是否实际弹窗、是否由你取消、测试结果 | 待填 |
| 成功：是否实际批准、测试结果               | 待填 |
| 字节、dirty、ACL、焦点断言                 | 待填 |
| 失败日志和产物位置                         | 待填 |

Windows 结果只覆盖 UAC；macOS 密码授权和 Linux pkexec 需要在各自系统上另行验收。

## 5. 2026-10-21 本机验收记录

范围为当前管理员成员账户的未提升权限进程。按用户决定保留功能，不创建或切换标准用户账户；跨账户凭据路径不在本次完成条件及结论覆盖范围内。

本次范围内的真实取消和批准均已通过，Windows 对应 TODO 已移除。

| 项目           | 记录                                                                                                                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 环境           | Windows 11 x64，build 22631，交互会话 2；`CHENCHEN\lanxi`，进程未提升权限                                                                                                                           |
| UAC            | `EnableLUA=1`、`PromptOnSecureDesktop=1`、`ConsentPromptBehaviorAdmin=5`                                                                                                                            |
| 源码           | `af4f3fd06d6b829fe1ab73cfdf38cd95c4af8f6d` 加本轮文件系统、验收脚本及文档修改；Node `v24.21.0`                                                                                                      |
| 运行包         | `ee4827e1bc6e447ae1ff111530b9553de6a1d82389675ff7adab417408f32b9b/bin/ash-app-server.exe`，本地开发产物未签名；实际路径及环境见 `uac-environment-final-20261021.json`                               |
| 二进制 SHA-256 | `FD8A0EAEDEFABBBAC59125AC8E05827CCE5D1C92F2778CDFFBA9777E5544BED6`                                                                                                                                  |
| 最终取消       | 用户确认看到 UAC 并点“否”；`uac-visible-cancel-20261021.log` 为 `1 passed (12.3s)`。明确拒绝提示、原始字节／BOM／CRLF、编辑器内容与 dirty、ACL、焦点全部通过                                        |
| 最终批准       | 先说明下一轮点“是”，用户回复“准备好了，下一轮点是”后才启动；真实批准后 `uac-approved-final-20261021.log` 为 `1 passed (11.7s)`。修改后的完整字节／BOM／CRLF、dirty 清除、ACL 不变及焦点恢复全部通过 |
| 回归           | `just verify ash-file-system`：72 tests／check／rust-warnings 通过；`pnpm run pretest:smoke:desktop`：后端、Desktop、2,993 个自动化文件类型检查通过；窗口可见性调整后类型检查再次通过               |
| 语言           | 经客户端 NLS 加载 zh-CN，拒绝提示为“系统授权已被拒绝。修改仍未保存。”；使用既有翻译                                                                                                                 |

所有本机日志与环境记录均位于 `.build/desktop/playwright/`。最终取消结果目录为 `elevation-windows-visible-cancel-20261021/`，最终批准结果目录为 `elevation-windows-approved-final-20261021/`；72 项回归日志为 `uac-final-verify-20261021.log`，构建日志为 `uac-final-preparation-20261021.log`。

本轮修复了三个可复现问题：

- ACL fixture 递归执行 `icacls /T` 时清除了子文件刚继承的读取权限，使保存前的修订读取失败。现在只设置父目录 ACL，并先按完整 Buffer 校验原始文件。Windows ACL 回归验证可以读取、普通写入被拒绝，且返回 `OsPermissionDenied`。
- `Start-Process` 丢弃了原生 Win32 取消异常，导致 UAC 点“否”被误报为授权不可用。改用 `.NET Process.Start` 保留原因链，识别 `ERROR_CANCELLED=1223`，继续通过既有 `ElevationDenied` 和客户端 NLS 显示拒绝提示。取消用例必须断言具体拒绝原因。
- Windows 接受的 socket 继承 listener 的非阻塞模式，辅助进程虽已写入，父进程却过早读取确认结果并返回 `WriteOutcomeUnknown`，导致编辑器保持 dirty。接受连接后显式切回阻塞模式，各阶段仍保留既有超时。独立进程往返回归修复前失败、修复后通过，日志为 `uac-exchange-regression-20261021.log` 与 `uac-exchange-regression-fixed-20261021.log`。

交互验收现在让 Ash 窗口正常显示并激活。此前未看到弹窗、等待超时、按钮与用例不一致的轮次均不计作通过；相关失败日志及 trace 保留在同一产物目录。最终两轮命令均已退出，检查时没有残留 UAC 或测试 App Server 进程。macOS／Linux 验收仍独立。
