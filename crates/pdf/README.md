# aspdf 原生引擎

`ash-pdf` 在独立 helper 中加载 PDFium；协议类型由 `ash-pdf-contract` 提供。Workbench 使用领域服务，Agent 使用已授权的文件快照。保存仍由文件服务执行版本条件写入。

- 文件上限为 64 MiB，上传和导出使用最多 192 KiB 的分块。源文件、PNG 和修改快照存放在会话私有临时目录，关闭后删除。
- 整个进程最多保留两个 PDFium helper。只读翻页复用已打开文档；空闲 helper 可被回收，忙碌 helper 不会被抢占。两个 helper 都忙碌时返回容量错误。
- 每个导入会话最多缓存两页的 PNG 和结构化信息。PNG 保存在磁盘；前端只显示当前页。浏览项目文件列表不会打开 PDFium。
- 每个连接最多导入八份文档、累计 256 MiB；服务最多保留十六个导入会话。这些是打开会话的限额，项目文件数不受此限额影响。
- 批注成功后切换到新快照、清空旧页面缓存，并关闭旧文件的 native reader。失败、取消或超时会丢弃 helper，后续从最后成功的快照恢复。
- Agent 的 `PdfOutput::Text` 返回文字和批注，跳过光栅化、PNG 编码和逐字坐标。需要视觉证据时使用 `Image`。

## 验证与压测

```sh
just verify ash-pdf
just test ash-pdf --test pdf_process --no-run --locked
python3 scripts/pdf-stress.py --generate-only
```

使用 Cargo 输出的 `pdf_process` 可执行文件路径运行原生服务压测：

```sh
python3 scripts/pdf-stress.py --binary <pdf_process路径> --output .build/aspdf-perf/result.json
python3 scripts/pdf-stress.py --binary <pdf_process路径> --scenario agent --output .build/aspdf-perf/agent.json
python3 scripts/pdf-stress.py --binary <pdf_process路径> --scenario pool --output .build/aspdf-perf/pool.json
ASPDF_STRESS=1 pnpm test:browser:integration pdfPreview.integration.spec.ts --project=chromium
```

默认语料包含 1,000 份独立文档、一份 1,000 页文档和一份包含真实 42 MiB RGB 图片流的 PDF；`--documents 10000` 可扩展独立文档数量。默认渲染尺寸为 1,600 像素。完整场景逐页验证文字、批注和 PNG SHA-256，并验证大文件批注导出后重开；不是只统计文件数。

`agent` 场景读取全部语料中的独立文档，首份作为预热；`pool` 场景切换八份已打开文档，检查最多两个 helper、关闭回收，以及大文件的 Agent 文字读取。浏览器场景连续浏览 1,000 页，采集 CDP 的堆、DOM 和事件监听数据。

原始样本、失败和参数保存在输出 JSON。原生内存采样使用 macOS/Linux 的 `ps`，报告 fixture 及其子进程的 RSS 总和，可能重复计算共享页。浏览器数据来自隔离的真实 Workbench PDF 编辑器和原生服务 fixture；这些数据不代表完整 Electron、GPU、App Server 的总内存，也不代替 Agent Window 整窗验收。
