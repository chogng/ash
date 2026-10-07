# Code 构建与发布

`build/code/` 负责终端产品的开发运行、发布包、归档和公开安装脚本。用户运行的 `ash`
由根目录 `cli/` 实现；TUI 由 `code/` 实现；此目录只负责构建和交付工具。

`build.py` 一次编译开发所需的 CLI、App Server、语音设备辅助程序和平台程序，读取 Cargo 报告的可执行文件路径。
`build/code/run.py` 调用共享开发发布器，将可执行文件放入 `.build/code/dev/generations/<digest>/bin/` 后启动 CLI；独立运行 `build.py` 只编译。启动器在发布锁内取得版本租约，持续持有至 CLI 退出；CLI、App Server、Code Mode 和语音辅助程序也各自持有进程租约。每次发布只保留当前版本和仍持有租约的历史版本，未变化的程序通过 `objects/` 中的硬链接共享，最后一个版本释放后回收对应对象。

正式发布按顺序组装，已有输出目录不会被覆盖：

1. 用 `build/app_server.py` 生成不含 CLI 的共享运行时包，JavaScript 运行时选择 `packaged-node`，并将 `ASH_UPDATE_PUBLIC_KEY` 写入后台组件的包元数据。
2. 用 `package.py --runtime-package ... --cli-bin ... --update-public-key ... --package-dir ...`
   加入 `ash` 命令，重算文件清单和包身份，并重新验证完整包。
3. macOS 和 Windows 使用 `build/sign.py` 签名并记录整包可执行文件；随后用
   `archive.py` 生成确定性的发布归档及 SHA-256 旁车文件。
4. `update-sign/` 的 `ash-update-sign` 对更新描述签名。

发布任务还将共享运行时包独立签名并归档为 `ash-app-server-<target>`，由
`ash-app-server-promote.yml` 单独提升 stable 指针。`ash app-server daemon update` 只安装该后台包，
不会改变 Code 的安装版本。

`package.py` 只接受未经系统签名的 release 运行时包，且要求锁定的独立 Node 程序。
CLI 和运行时共用一个 `ash-package.json`，安装、远端传输和更新验证读取同一份完整文件清单。

验证入口：`just test-python code`、`just test-python build`、`just build-code`。
