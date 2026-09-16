# 第三方源码

- `livekit-rust-sdks/` 保存 LiveKit Rust SDK 的房间网络配置、统计接口和异常解析补丁；版本来源见该目录说明。
- `mxc/` 保存固定 Microsoft MXC 版本的依赖源码补丁及复核工具。
- `bubblewrap/` 保存 Linux 隔离工具 Bubblewrap 的完整上游源码。
- 第三方源码只提供外部实现，不拥有 Ash 的沙箱策略、平台适配或发布组合。
- 更新源码时必须同步来源元数据、许可证、Linux 构建和沙箱测试。
