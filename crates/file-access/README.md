# `ash-file-access`

- `Dir` 表达环境、目录路径和实际对象身份，不授予权限；环境文件驱动负责打开与校验物理目录。
- `Grant` 绑定主体、目录、权限、来源和撤销租约；`Access` 拒绝其他主体，按完整目录身份索引。
- `Access::authorize` 只裁决目标目录；贡献由业务所有者持有效授权加载。
- `Authorization::execute` 校验主体、目录和动作，并持有租约直到操作完成。撤销等待已开始操作结束，之后拒绝旧凭证。
- `Authorization` 可复制和重复校验，不是一次性凭证。长期契约见 [环境与目录访问](../../docs/environment-access.md)。
