# 浏览器上传文件访问：跨平台验证 TODO

## Windows 实机

- [ ] 检出包含本次浏览器上传修复的提交，记录 `git rev-parse HEAD`、Windows 版本与 CPU 架构。
- [ ] 按 [Windows 开发环境](build.md#windows-开发环境) 准备依赖，在包含 MSVC 和 Windows SDK 的 Developer PowerShell 中进入仓库根目录。
- [ ] 执行以下验证，记录完整结果；失败时保留命令输出：

```powershell
just verify ash-app-server --lib --filter browser_upload
if ($LASTEXITCODE -ne 0) { throw '浏览器上传验证失败' }
just verify ash-file-system --lib
if ($LASTEXITCODE -ne 0) { throw '文件系统验证失败' }
```

- [ ] 确认上传测试包含 `browser_upload_denies_hard_link_replacement_before_snapshot`，文件系统测试包含 `read_snapshot_link_information_belongs_to_the_opened_file`，且均通过。
- [ ] 将提交 SHA、测试结果和日志位置写回本文，再勾选完成。符号链接替换的竞态用例仅在 Unix 编译，Windows 结果不覆盖该用例。

macOS 上已通过两包的 check、test 和 rust-warnings：上传测试 6 项、文件系统测试 77 项；共享本地策略回归另有 1 项通过。文件系统的 Windows 测试目标交叉编译已通过；App Server 的 Windows 交叉编译因缺少 SDK 头文件（`assert.h`、`windows.h`）中止，不能记为通过。

## Linux 补验

- [ ] 在具备 Linux C 编译工具链的环境执行 `just verify ash-app-server --lib --filter browser_upload`，确认符号链接叶节点、父目录替换和硬链接替换的竞态测试通过，并记录提交 SHA 与结果。

文件系统的 Linux 测试目标交叉编译已通过；App Server 的 Linux 交叉编译因缺少 `x86_64-linux-gnu-gcc`，在 `sha2-asm` 构建阶段中止。
