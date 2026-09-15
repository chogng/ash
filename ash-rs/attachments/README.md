# ash-attachments

- 负责会话中图片和音频的接收、校验、持久引用及模型请求前的读取。
- `Attachments` 统一接收本地字节、分块上传结果和工具附件；远程 URL 导入仅支持图片。
- 图片由 `ash-utils-image` 校验和规范化；音频由 `ash-utils-audio` 检查容器、大小和时长。
- `AttachmentStore` 按 SHA-256 保存不可变字节。会话只保存 `ImageAttachmentRef` 或 `AudioAttachmentRef`，内容在事件写入前落盘。
- `FileAttachmentStore` 沿用 `attachments/sha256` 布局，拒绝符号链接，使用同目录临时文件、同步写入和不覆盖发布；读取限制字节数并重新核对摘要。
- 读取引用时重新验证媒体类型、大小以及图片尺寸或音频时长，拒绝伪造元数据和损坏文件。
- 模型调用只把请求副本中的引用转换为 data URL。图片按模型限制缩放；音频保留已验证的原始编码，存储对象不变。
- `MemoryAttachmentStore` 服务测试和显式临时会话；产品使用文件存储。
- `SafeRemoteImageFetcher` 校验真实 DNS 结果及每次重定向，拒绝私有网络、地址凭据和 HTTPS 降级。
- 尚未实现孤立对象回收；删除前必须确认所有持久会话均不再引用对象。
