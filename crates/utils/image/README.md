# ash-utils-image

`ash-utils-image` 在不可信图片 bytes 对模型可见之前，负责供应商无关的校验和转换。跨 crate 的
安全边界与 Tool output policy 以 [`docs/tools/tools.md`](../../../docs/tools/tools.md) 为准；本 README 是
crate 实现契约的权威说明。

## 所有权

本 crate 拥有受支持格式识别、Base64 data URL 解析与生成、真实图片解码、编码与解码资源限制、
尺寸/像素/frame 校验、缩放与 patch budget 计算、ICC/EXIF 处理、静态转码以及进程内有界缓存。
它不读取文件、不抓取远程 URL、不选择模型 capability、不持久化附件、不决定产品 limits、不发送
telemetry，也不决定处理失败的图片如何出现在对话中。

`ash-core` 提供 `PromptImagePolicy`，在 durable user/tool 图片内容记录前调用处理，并把失败映射
为产品语义。产品 host 可以使用 `detect_image_format` 和 `data_url_from_bytes` 投影本地附件，但
这些检查不是权威校验。Provider adapter 只消费已经准备好的图片 URL 并编码 wire 差异。

## 公共契约

- `load_for_prompt_bytes` 在解码模型可见 frame 前校验编码大小、格式、尺寸、像素、解码 bytes 和
  frame 数，然后应用 `PromptImageMode`、metadata 与 animation policy，返回 `EncodedImage`。
- `load_data_url_for_prompt` 只接受受支持的 Base64 图片 data URL，核对声明 MIME 与实际文件签名，
  再委托 `load_for_prompt_bytes`。
- `PromptImageDetailLimits` 保存 Auto、Low、High、Original 的尺寸与 patch 限制，供模型调用方和
  Core 共用；调用方选择对应等级并传入 `PromptImageResizeLimits`。默认限制与原有图片准备行为
  一致，不代表某个型号的能力，也不替代产品上传额度。
- `PromptImagePolicy` 让安全、缩放、metadata 和 animation 选择在调用点保持显式。`Original` 只
  关闭面向模型的主动缩放，不能绕过任何安全限制。
- `EncodedImage` 同时报告源尺寸、准备后尺寸和源 frame 数；其 bytes 不可变且可共享，cache hit
  不会复制大 buffer。
- `detect_image_format` 只识别文件签名，不构成完整校验；只有 `load_for_prompt_bytes` 成功才能证明
  图片可以在当前 policy 下安全解码。

输入支持 PNG、JPEG、GIF 和 WebP。`ImageAnimationPolicy` 明确决定拒绝动画或只取第一帧；转换
后的 GIF 输出为 PNG。只有不需要缩放、动画降帧或 metadata 清理时，PNG/JPEG/WebP 才按原 bytes
透传。

## 内部执行路径

```text
load_data_url_for_prompt
  → Base64/MIME validation
  → load_for_prompt_bytes
      → validate_policy
      → frame_count
      → validate_decoded_shape
      → DynamicImage::from_decoder
      → output_dimensions
      → encode_image (only when transformation is required)
      → IMAGE_CACHE
```

`frame_count` 在接受输入前限制 animation 工作量；`validate_decoded_shape` 拥有尺寸、像素与解码
内存不变量；`output_dimensions_for_limits` 拥有 32-pixel patch grid 计算；`encode_image` 和
`apply_metadata` 是唯一转码路径。若这些 symbol 开始检查模型 capability、抓取远程资源、读取
filesystem 或保存 durable 数据，即表示实现所有权已经漂移。

Cache key 对源 bytes 和完整 `PromptImagePolicy` 计算 hash。`ash-utils-cache` 拥有通用 LRU 与锁；本 crate 通过 `cache_image` 拥有 32 条和 64 MiB 编码 byte 的双重约束。缓存只是一项优化，不能改变校验结果或失败行为。

## 失败与限制

`ImageProcessingError` 区分 malformed data URL、MIME 不匹配、不支持格式、无效 policy、编码大小、
尺寸、像素、解码 bytes、frame 数、animation policy、解码失败与编码失败。错误内容绝不包含图片
bytes 或完整 data URL。

crate 的默认输入上限只是绝对 sanity guard，不是产品上传额度。调用者必须提供实际接受的 byte、
尺寸、像素、解码内存和 frame limits。修改 patch size、支持格式、metadata 行为、cache identity
或错误分类会影响 Core durability、provider request 和附件客户端，必须同步更新 integration test
与文档。

## 测试

运行 `just test ash-utils-image`。单元测试覆盖源 bytes 透传、缩放、patch budget、`Original`
安全语义、data URL 校验、资源限制、animation policy、metadata 保留/清理和输出编码。Bazel target
为 `//crates/utils/image:image-unit-tests`。
