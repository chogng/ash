# ash-screen-capture

- 负责显示器与窗口枚举，提供统一的屏幕源元数据。
- 捕获屏幕并输出带单调递增时间戳与分辨率的像素帧流。
- 封装平台录屏权限查询与状态判定。
- 提供无头 CI 与单元测试专用的确定性 Mock 帧生成源。
- 不承担 WebRTC 轨道创建、房间信令、网络推流或 UI 渲染。

Windows 使用 Windows Graphics Capture，保留系统录屏边框。来源 ID 来自当前枚举；窗口关闭后流停止，异步采集错误可通过流查询。采集线程拥有 D3D11 与帧池，支持窗口缩放，停止或丢弃流会等待线程退出。

普通测试不读取桌面像素。Windows 交互桌面上的真实采集测试会创建自己的窗口，验证连续帧、缩放、重复启动与关闭清理：

```sh
just test ash-screen-capture --lib window_frames_resize_stop_and_close_release_capture -- --ignored
```
