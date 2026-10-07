# `ash-file-identity`

`ash-file-identity` 拥有从已打开文件读取文件身份和硬链接数量的平台边界。信任决策需要在同一次验证流程内把后续读取绑定到同一文件系统对象时，调用方使用 `FileInformation::from_file`；只需取得一次路径观察时，可以使用 `FileInformation::from_path`。

公共契约只暴露 `FileInformation` 及语义明确的同一文件比较和多链接检查，不暴露平台身份的内部表示或容易混淆身份与观察状态的通用相等比较：

- Unix 通过 `MetadataExt` 读取设备号、inode 和链接数量，并把 inode 零扩展为 128 位对象标识；
- Windows 通过一个私有 FFI 边界调用 `GetFileInformationByHandleEx`，使用 `FILE_ID_INFO` 的卷序列号和 128 位文件 ID，并通过 `FILE_STANDARD_INFO` 读取链接数量；
- 操作系统错误保持为 `io::Error`；
- 不支持的平台明确失败，不退化为路径字符串比较。

crate 根模块使用 `#![deny(unsafe_code)]`，只有私有 `windows.rs` 模块重新允许必要的 Win32 FFI；在其他模块新增 `unsafe` 会被编译器拒绝。

```text
路径
└── FileInformation::from_path
    └── File::open
        └── FileInformation::from_file
            └── platform::inspect
                ├── Unix MetadataExt
                └── Windows GetFileInformationByHandleEx
```

`FileInformation::from_path` 会跟随符号链接，且结果只表示调用时的一次观察。安全敏感的调用方必须对实际读取使用的文件句柄调用 `FileInformation::from_file`，并通过 `same_file_as` 比较观察结果；`has_multiple_links` 只报告当前链接状态，不决定领域准入策略。

文件身份只用于同一次验证流程内的即时比较，不是持久化对象键。调用方不能把比较结果跨文件删除或替换、文件系统重新挂载、机器重启或进程生命周期保存和复用。

本 crate 不规范化路径、不拒绝符号链接、不决定是否允许硬链接、不监听修改，也不使用领域专用标志打开文件。这些义务仍属于调用方。把路径策略、Skill 语义或沙箱行为放进这里，意味着架构所有权已经漂移。

Skills、Extensions 与 Plugins 是当前消费者：它们各自拥有链接准入、路径 containment、读取限制和内容验证，并使用本 crate 绑定读取前后的文件系统对象。Skills 的跨 crate 所有权与信任语义见 [`../../docs/skills.md`](../../docs/skills.md)。

当前限制：只支持 Ash 使用的 Unix 与 Windows 主机系列。文件系统必须能够返回可供即时比较的对象身份和链接数量；不具备该能力时返回操作系统错误。新增平台不能退化为路径拼写或静默省略链接信息。

## 验证

```bash
cargo test --manifest-path Cargo.toml -p ash-file-identity
cargo clippy --manifest-path Cargo.toml \
  -p ash-file-identity --all-targets --no-deps -- -D warnings
```

测试默认在系统临时目录运行。要验证特定文件系统或挂载设备，先创建一个可写目录，再通过 `ASH_FILE_IDENTITY_TEST_ROOT` 指向该目录；对 NTFS、ReFS、FAT、网络共享、ext4、APFS 等目标分别执行一次相同测试。测试会实际验证当前设备的重命名、路径替换和硬链接语义；设备或系统策略不支持硬链接或符号链接时，只跳过对应的能力专属断言。

```powershell
$env:ASH_FILE_IDENTITY_TEST_ROOT = 'R:\ash-file-identity-tests'
cargo test --manifest-path Cargo.toml -p ash-file-identity -- --nocapture
```

```bash
ASH_FILE_IDENTITY_TEST_ROOT=/mnt/test-volume/ash-file-identity-tests \
  cargo test --manifest-path Cargo.toml -p ash-file-identity -- --nocapture
```
