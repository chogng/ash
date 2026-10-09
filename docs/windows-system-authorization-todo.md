# Windows UAC 实测 TODO

在 Windows 实机或有交互桌面的虚拟机上，用本次修复后的 Ash 源码执行。目标是验证真正的 UAC 成功与取消，以及文件内容、编辑器状态和 ACL。当前 Windows UAC 实测仍未完成。

## 1. 准备环境

- [ ] 同步 Mac 上的当前 Ash 工作区，包含尚未提交的新文件；只拉取远端分支不能保证包含本次修复。确认 `test/smoke/areas/editor/elevated-save.spec.ts` 和 `crates/file-system/src/elevated.rs` 都存在。
- [ ] 按 [Windows 开发环境](build.md#windows-开发环境) 安装工具，在仓库根目录打开普通的 Visual Studio Developer PowerShell；不要选择“以管理员身份运行”。
- [ ] 保持 UAC 开启，测试期间留在 Windows 交互桌面。
- [ ] 准备一个可以批准 UAC 的管理员账户。密码只在 Windows 系统授权窗口输入。
- [ ] 检查当前终端没有管理员权限，并记录源码版本：

```powershell
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '请关闭此终端，使用非管理员终端运行测试。'
}
git rev-parse HEAD
git status --short
```

- [ ] 安装依赖并准备 Windows 测试产物；任一步失败先停下并保存输出：

```powershell
pnpm install
if ($LASTEXITCODE -ne 0) { throw 'pnpm install 失败' }
just install
if ($LASTEXITCODE -ne 0) { throw 'just install 失败' }
pnpm run pretest:smoke:desktop
if ($LASTEXITCODE -ne 0) { throw '测试产物准备失败' }
```

## 2. UAC 取消

- [ ] 执行以下命令。测试会自动点击 Ash 的管理员重试按钮；出现真正的 Windows UAC 窗口时，点击“否”或“取消”。

```powershell
$env:ASH_TEST_SYSTEM_AUTHORIZATION = 'cancel'
try {
    pnpm run smoketest-no-compile test/smoke/areas/editor/elevated-save.spec.ts --grep 'real system authorization cancel' --output .build/desktop/playwright/elevation-windows-cancel
    if ($LASTEXITCODE -ne 0) { throw 'UAC 取消用例失败，请保留日志和测试产物。' }
} finally {
    Remove-Item Env:ASH_TEST_SYSTEM_AUTHORIZATION -ErrorAction SilentlyContinue
}
```

- [ ] 亲眼确认弹出了 Windows UAC，记录程序名称和发布者。未弹出 UAC，或提示授权能力不可用，不能认定取消交互已通过。
- [ ] 终端结果为 **1 passed**，不能是 skipped 或未匹配到用例。
- [ ] 自动断言通过：磁盘仍是原内容，编辑器保留修改并保持 dirty，文件 ACL 未变，输入焦点恢复。

当前取消用例验证失败后保留内容和状态，但没有断言错误一定属于“用户拒绝授权”；需同时记录实际 UAC 出现并由你取消。仅看到通用保存失败不能代替这项记录。

## 3. UAC 成功

- [ ] 执行以下命令，在真正的 Windows UAC 窗口批准；要求密码时输入管理员账户的密码。

```powershell
$env:ASH_TEST_SYSTEM_AUTHORIZATION = 'approve'
try {
    pnpm run smoketest-no-compile test/smoke/areas/editor/elevated-save.spec.ts --grep 'real system authorization approve' --output .build/desktop/playwright/elevation-windows-approve
    if ($LASTEXITCODE -ne 0) { throw 'UAC 成功用例失败，请保留日志和测试产物。' }
} finally {
    Remove-Item Env:ASH_TEST_SYSTEM_AUTHORIZATION -ErrorAction SilentlyContinue
}
```

- [ ] 亲眼确认 UAC 出现并成功批准，终端结果为 **1 passed**。
- [ ] 自动断言通过：磁盘为修改后的完整内容，BOM 和 CRLF 保留，编辑器清除 dirty，文件 ACL 未变，输入焦点恢复。
- [ ] 如果先用管理员账户的普通终端测试，再换标准用户账户重复第 1–3 节，验证输入另一个管理员账户凭据的路径。两种账户场景分别记录结果。

每个用例使用独立临时工作区，并在 `finally` 恢复目录权限。用例超时后先保存输出，正常结束测试；不要直接关闭整个终端。测试等待系统授权约 180 秒，需要及时响应。

## 4. 回传结果

- [ ] 填写并回传下表及两次测试的终端输出；失败时附对应输出目录里的 `error-context.md` 和 `trace.zip`（若生成）。密码和凭据不要回传。

| 项目                                       | 记录 |
| ------------------------------------------ | ---- |
| Windows 版本、x64/ARM64                    | 待填 |
| 源码提交及未提交修改是否同步               | 待填 |
| 测试账户：管理员成员的普通终端／标准用户   | 待填 |
| UAC：确认按钮／管理员凭据输入              | 待填 |
| 系统窗口显示的程序名称、发布者             | 待填 |
| 取消：是否实际弹窗、是否由你取消、测试结果 | 待填 |
| 成功：是否实际批准、测试结果               | 待填 |
| 字节、dirty、ACL、焦点断言                 | 待填 |
| 失败日志和产物位置                         | 待填 |

Windows 结果只覆盖 UAC；macOS 密码授权和 Linux pkexec 需要在各自系统上另行验收。
