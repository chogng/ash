# ash-attachment-store

- 负责不可变附件字节的保存、读取和 SHA-256 摘要校验。
- `AttachmentStore` 定义存储接口，单个对象最多 16 MiB。
- `FileAttachmentStore` 使用 `attachments/sha256/<前两位>/<摘要>` 布局，兼容已有附件。
- 文件写入使用同目录临时文件、同步写入和不覆盖发布；重复内容复用已有对象。
- Unix 在发布后同步目录；Windows 同步文件内容，不打开目录做同步。
- 文件读取拒绝符号链接，限制字节数并重新核对摘要。
- `MemoryAttachmentStore` 服务测试和显式临时会话。
- 隔离文件存储依赖；图片、音频校验及远程导入由 [`ash-attachments`](../attachments/README.md) 负责。
- 尚未实现孤立对象回收；删除前必须确认所有持久会话均不再引用对象。
