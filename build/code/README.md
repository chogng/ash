# Code 构建与发布

`build/code/` 负责终端产品的开发可执行文件、发布包和归档。用户运行的 `ash`
由根目录 `cli/` 实现；TUI 由 `code/` 实现；此目录只负责构建和交付。

`build.py` 一次编译开发所需的 CLI、App Server 和平台程序，读取 Cargo 报告的可执行文件路径。
`build.py` 将它们放入 `.build/code/dev/<digest>/`；`scripts/code/run.py` 启动 CLI。

正式发布按顺序组装，已有输出目录不会被覆盖：

1. 用 `build/runtime/build.py` 生成不含 CLI 的共享运行时包，JavaScript 运行时选择 `packaged-node`。
2. 用 `package.py --runtime-package ... --cli-bin ... --update-public-key ... --package-dir ...`
   加入 `ash` 命令，重算文件清单和包身份，并重新验证完整包。
3. macOS 和 Windows 使用 `build/runtime/sign.py` 签名并记录整包可执行文件；随后用
   `archive.py` 生成确定性的发布归档及 SHA-256 旁车文件。
4. `update-sign/` 的 `ash-update-sign` 对更新描述签名。

`package.py` 只接受未经系统签名的 release 运行时包，且要求锁定的独立 Node 程序。
CLI 和运行时共用一个 `ash-package.json`，安装、远端传输和更新验证读取同一份完整文件清单。

验证入口：`just test-python code`、`just test-python build`、`just build-code`。
