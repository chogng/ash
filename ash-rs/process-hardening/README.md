# Process hardening

- 隔离进程防护的系统调用、unsafe 代码和平台依赖；由可执行入口在读取密钥、创建运行时之前调用 `initialize()`。
- 系统防护失败时，由入口终止启动。
- `register_exit_cleanup` 注册正常进程退出时的 OS 资源清理，用于仍被后台引用持有的子进程；回调必须不 panic，不能依赖线程局部状态。强杀和 abort 不执行这些回调。

## 构建策略

| 行为 | 开发构建（启用 `debug_assertions`） | 发布构建（关闭 `debug_assertions`） |
| --- | --- | --- |
| Unix core dump 限制 | 保留调用前设置 | 软、硬限制均置零 |
| Linux / Android 调试附加 | 保留系统默认策略 | 设置 `PR_SET_DUMPABLE=0` |
| macOS 调试附加 | 保留系统默认策略 | 使用 `PT_DENY_ATTACH` |
| `LD_*` / `DYLD_*` | 保留工具链环境 | 构造阶段全部清理 |
| Windows DLL 搜索与崩溃弹窗 | 限制搜索目录、关闭弹窗 | 相同 |

- 自定义构建配置按 `debug_assertions` 决定策略；发布产物必须关闭该选项。
- 发布版清理包含 `LD_LIBRARY_PATH`，不能依赖继承的加载器变量运行工具链；开发构建保留这些变量。
- Windows 的 DLL 搜索策略依据 [SetDefaultDllDirectories](https://learn.microsoft.com/en-us/windows/win32/api/libloaderapi/nf-libloaderapi-setdefaultdlldirectories)，不承诺禁止调试或系统级转储。

## 安全边界

- 清理环境只能影响后续环境继承，不能撤销动态加载器在构造函数之前已加载的库；发行包的加载路径、签名和启动环境需由打包与启动方保证。
- 发布版 core 硬限制会被子进程继承，普通子进程不能自行提高；这会影响从 Ash 启动的工具生成 core dump。
- Linux 调试附加限制依据 [PR_SET_DUMPABLE](https://man7.org/linux/man-pages/man2/pr_set_dumpable.2const.html)，不承诺阻止具备调试能力的特权进程。
- 本 crate 不管理命令的文件、网络或执行权限；这些权限继续由执行服务与沙箱负责。

## 验证

- `just test ash-process-hardening` 与 `just test ash-process-hardening --release` 分别验证两种构建策略。
- 独立子进程检查加载器环境、无关环境保留、Unix core 限制和真实 shell 的环境继承。
- Linux 测试实际父进程调试附加；运行账户不能拥有绕过限制的权限，测试环境需允许开发构建的父子调试。
- macOS 测试已被跟踪的进程：开发构建正常运行，发布构建执行拒绝调试时以 `ENOTSUP` 退出。
- Windows 测试崩溃弹窗设置、拒绝从当前目录隐式加载 DLL，以及仍可通过绝对路径加载同一 DLL。
- 各平台运行测试才能验证系统行为；跨平台编译只验证对应代码能够编译。
