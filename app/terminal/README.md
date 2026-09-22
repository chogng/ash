# `ash-terminal`

> 外部 AI CLI、Terminal Pane 和产品接线由
> [`app/TERMINAL.md`](../TERMINAL.md) 统一说明。本 README 只拥有
> terminal model 的当前实现契约、内部接口和修改路径；PTY process plumbing 见
> [`ash-utils-pty`](../../ash-rs/utils/pty/README.md)。

1. 在 App 进程内将 PTY 输出解析为终端网格，维护光标、屏幕、样式和滚动历史。
2. 根据终端模式编码按键、粘贴与鼠标输入，并维护有界命令输出 BlockList。
3. 由终端宿主直接调用；PTY 进程、窗口、GPU、Session 持久化与 Agent 状态各归所属能力。

CLI 的 PTY 集成测试也使用本 crate 解析输出；这项测试依赖不改变 App 对终端模型的归属。

## 所有权

| 能力 | 当前 owner | 状态 |
| --- | --- | --- |
| 跨 chunk ANSI/VT parser state | `emulator::TerminalCore` / `vte::Parser` | ✅ |
| rows × columns、cursor、wrap、erase 和 scroll | `grid::TerminalGrid` | ✅ |
| cell text、extended grapheme、wide-character continuation 和 SGR style | `grid::Cell` / `CellStyle` | ✅ |
| command/output block 顺序、状态和 retention cap | `block_list::BlockList` | ✅ |
| primary/alternate screen 与 DEC input/pointer mode state | `screen::TerminalScreen` | ✅ |
| scroll region、origin mode 与 line insert/delete | `grid::scrolling` | ✅ |
| mode-aware keyboard 与 bracketed-paste byte encoding | `input` + `TerminalCore` | ✅ |
| 1000/1002/1003 tracking 与 legacy/1006 mouse encoding | `mouse` + `TerminalCore` | ✅ |
| device attributes、status 与 cursor-position reply | `emulator::GridPerformer` / `TerminalCore` | ✅ |
| 主屏 cell scrollback、视口切片与 10,000 行 retention cap | `grid::TerminalGrid` | ✅ |
| 主屏 wrapped-line resize reflow 与 cursor remap | `grid::reflow` | ✅ |
| OSC 0/2 会话标题 | `emulator::GridPerformer` / `TerminalCore::title` | ✅ |
| PTY spawn、write、resize、exit 与 cleanup | `ash-utils-pty` + product host | ❌ |
| shell command boundary、PTY echo filtering 与 OSC 133 `D` completion | host submit + `block_list::PendingEcho` + `emulator::GridPerformer` | ✅ |
| 完整 DEC private modes 与更多 query family | 尚无完整 owner | 尚未完成 |
| window pointer event → terminal cell mapping / PTY write | product host | integration obligation |
| 跨进程重启的 Block/scrollback 持久化 | 尚无 owner | 尚未完成 |

依赖方向：

```text
app
├─ ash-terminal → vte
└─ ash-utils-pty
```

`ash-terminal` 不得反向依赖 `app`、`ash-ui`、`ash-wgpu` 或 PTY backend。Renderer
从 public projection 读取 state；不能把 UI `Color`、`Rect` 或 process handles 放进 model。

## 公共契约

| Symbol | 调用者看到什么 | 不变量 |
| --- | --- | --- |
| `GridSize` | 非零 rows/columns | `new` 把零规范化为一 |
| `TerminalCore::process_output` | 增量消费任意 byte chunk | parser state 跨 chunk 保留 |
| `TerminalCore::resize` | 调整 grid cell dimensions | cursor 和保存位置始终 clamp 在 grid 内 |
| `TerminalCore::active_screen` | 当前 primary/alternate projection | Renderer 只读取 active grid |
| `TerminalCore::title` | OSC 0/2 最近设置的有界标题 | control characters 被移除，最多 256 个字符 |
| `TerminalCore::modes` | cursor key、cursor visibility、paste 与 mouse request state | mode state 来自 PTY output，不由 UI 推断 |
| `TerminalCore::encode_key` | 把 logical key 与 modifier 编码为 PTY input | application cursor mode 改变 cursor-key sequence |
| `TerminalCore::encode_paste` | 编码 literal 或 bracketed paste | 只在 `?2004h` 后添加 paste delimiters |
| `TerminalCore::encode_mouse` | 根据 tracking/encoding mode 过滤并编码一个 cell-addressed mouse event | disabled/不匹配的 motion 返回空 bytes |
| `TerminalCore::take_reply_bytes` | 取出 parser 为 terminal query 生成的有序 bytes | 取出后清空；host 必须把非空结果写回同一 PTY |
| `TerminalCore::start_command` | 建立新的 running Block | 前一个 running Block 转为 completed |
| `BlockList::complete_command` | 完成当前 running Block | 先无损 flush 尚未判定的 echo，再转为 completed |
| `TerminalCore::mark_process_exited` | 记录 process exit | 回到 primary screen、重置 modes，active Block 转为 `Exited(code)` |
| `TerminalGrid::lines` | 当前 viewport rows | 每行 cell 数等于 `GridSize::cols` |
| `TerminalGrid::scrollback_lines` | 被主屏全屏滚动顶出的有界 cell rows | alternate screen 和局部 scroll region 不进入历史 |
| `TerminalGrid::viewport_lines` | 以行偏移读取一屏 live/history projection | 偏移自动 clamp；零偏移始终返回 live grid |
| `TerminalLine::is_wrapped` | 当前 physical row 是否延续到下一行 | reflow 只连接 soft-wrapped rows，不连接 hard line break |
| `BlockList::preamble` | 首次 command 前的 printable output | retention cap 为 256 KiB |
| `BlockList::blocks` | ordered command/output history | 每个 Block output cap 为 1 MiB |

`TerminalCore::process_output` 同时推进 active screen grid 和 printable Block output。后者移除
ANSI control sequence，只保留 primary screen 上的 printable characters、tab 和 line feed；
alternate-screen frame 不进入 Block retention。carriage-return progress display 的权威状态仍在
grid，不应从 Block text 反推。

## 内部接口地图

| Symbol | 可见性 | 职责 | 修改影响 |
| --- | --- | --- | --- |
| `emulator::GridPerformer` | private | 把 `vte::Perform` callback 投影为 grid operation 与 printable text | 同步检查 parser chunk、CSI/ESC 和 Block tests |
| `screen::TerminalScreen` | crate-private | 拥有 primary/alternate grid、active projection 与 DEC mode transition | 同步检查 `47/1047/1048/1049`、resize、exit 和 renderer projection |
| `screen::TerminalModes` | public read-only projection | 暴露 input/pointer 所需的 mode state | 新 mode 必须区分“已解析”与“已执行” |
| `input::encode_key` | crate-private | logical key + mode → PTY bytes | 同步检查 normal/application cursor 与 modifiers |
| `mouse::encode_mouse` | crate-private | tracking filter + legacy/SGR protocol encoding | 坐标输入为零基 cell；wire coordinate 为一基 |
| `grid::scrolling` | private child module | scroll margins、origin-relative addressing、line insert/delete 与主屏历史 retention | 同步检查 full-region/partial-region、alternate screen 和 resize |
| `grid::reflow` | private child module | 把 soft-wrapped logical line 重排为新列宽，并映射 history/cursor/pending-wrap | 同步检查宽窄 resize、wide cell、alternate screen 与 style |
| `grid::TerminalGrid::print` | crate-private | extended grapheme、Unicode width、wrap 和 continuation cell 写入 | 同步检查 CJK/Emoji/组合符、wide-character 与 overwrite |
| `TerminalGrid::{index,reverse_index}` | crate-private | cursor movement 与 viewport scroll | 同步检查 newline、bottom-row 和 resize |
| `TerminalGrid::set_graphics_rendition` | crate-private | SGR → `CellStyle` | 同步检查 indexed/truecolor projection |
| `block_list::truncate_front` | private | 在 UTF-8 boundary 前删旧 output | 同步检查 retention 与 truncation marker |
| `block_list::PendingEcho` | private | 跨 output chunk 精确过滤 host 已建立 Block 的 PTY command echo | 不匹配或退出时必须无损回放 buffered output |

真实调用关系：

```text
TerminalCore::process_output(bytes)
├─ vte::Parser::advance
│  └─ GridPerformer
│     ├─ print / execute
│     ├─ csi_dispatch
│     │  ├─ TerminalScreen mode/buffer transition
│     │  ├─ TerminalGrid mutation
│     │  └─ terminal query → ordered reply bytes
│     └─ esc_dispatch → TerminalGrid/TerminalScreen mutation
└─ BlockList::append_printable_output

host output event
└─ TerminalCore::take_reply_bytes
   └─ host writes non-empty reply to the same PTY

host key event
└─ TerminalCore::encode_key
   └─ input::encode_key → PTY bytes

host pointer event
└─ viewport point → TerminalMousePosition
   └─ TerminalCore::encode_mouse → optional PTY bytes

host primary-screen wheel
└─ presentation-owned line offset
   └─ TerminalGrid::viewport_lines → retained/live cell projection

host submit
└─ TerminalCore::start_command
   └─ BlockList::start_command → PendingEcho

shell OSC 133 D
└─ GridPerformer command-finished signal
   └─ BlockList::complete_command

host resize
└─ TerminalCore::resize
   └─ grid::reflow → retained rows + live rows + cursor remap
```

绕过 `TerminalCore::process_output` 直接修改 grid、从渲染文本重建 terminal state、让 BlockList
拥有 PTY handle，或让 UI layout 决定 parser semantics，都意味着 ownership 已经漂移。

## 测试与限制

```bash
just check ash-terminal --locked
just test ash-terminal --locked
just rust-warnings ash-terminal --locked
bazel test //app/terminal:terminal-unit-tests
```

当前测试覆盖：

- printable text、wrap、scroll 与 cursor position；
- CSI cursor addressing、erase line 与 SGR；
- ANSI sequence 跨 output chunk；
- 简中、日文、韩文的 cell width，以及组合音标、ZWJ Emoji 和 regional-indicator flag 的
  extended-grapheme cell ownership；
- wide-character continuation cell；
- primary/alternate screen entry、exit、cursor restore 与 process-exit fallback；
- DEC application cursor、cursor visibility、bracketed paste 与 mouse request state；
- scrolling margins、origin-relative cursor addressing 与 line insert/delete；
- device attributes、status、standard/private cursor-position replies 与 drain semantics；
- cursor/function/control/Alt key 与 bracketed-paste encoding；
- 1000/1002/1003 motion filtering、legacy/SGR press/release/wheel encoding 与 coordinate clamp；
- 主屏 full-region scrollback、历史视口、局部 scroll region 排除与 `CSI 3 J` 清理；
- 主屏 soft-wrap reflow、宽字符边界、cursor/pending-wrap 映射与 alternate-screen fixed resize；
- OSC 0/2 title、长度/control-character filtering；
- PTY command echo 的跨 chunk 去重与 mismatch 无损回放；
- OSC 133 `D` 的 Block completion；
- alternate-screen output 不污染 Block retention；
- preamble、Block transition、exit status 和 printable output projection。

当前 parser 是可运行的最小核心，不是完整 xterm 兼容层。备用屏幕和 mode-aware key encoding
已经具备，滚动区域、常见 terminal query、主屏 reflow 和 OSC title 也形成了闭环；尚未实现完整
DEC mode/query family、1005/1015 等其他鼠标编码、OSC 52 clipboard、OSC 133 `A/B/C`、
cwd/exit-status retention、prompt boundary discovery、跨进程重启的历史持久化和 cell 级无障碍
支持。当前回滚缓冲区只在活动
`TerminalCore` 生命周期内保留最多 10,000 个 cell rows；BlockList 继续独立保留命令级 printable
output，不能用其中一方重建另一方。`TerminalCore::encode_mouse` 不拥有窗口坐标、pressed button
lifecycle 或 PTY handle；host 必须只为真实 terminal viewport 构造事件并写回非空结果。扩展时
优先按 escape-sequence family 增加独立测试，不在 renderer 中补偿 model 缺失。
