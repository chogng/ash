# `ash-terminal`

CLI 的 TUI 和 Remote 集成测试使用本 crate 解析 PTY 输出，读取终端画面和滚动历史，并应答终端查询。

## 所有权

| 能力                                                                   | 当前 owner                                        | 状态 |
| ---------------------------------------------------------------------- | ------------------------------------------------- | ---- |
| 跨 chunk ANSI/VT parser state                                          | `emulator::TerminalCore` / `vte::Parser`          | ✅   |
| rows × columns、cursor、wrap、erase 和 scroll                          | `grid::TerminalGrid`                              | ✅   |
| cell text、extended grapheme、wide-character continuation 和 SGR style | `grid::Cell` / `CellStyle`                        | ✅   |
| primary/alternate screen 与 DEC input/pointer mode state               | `screen::TerminalScreen`                          | ✅   |
| scroll region、origin mode 与 line insert/delete                       | `grid::scrolling`                                 | ✅   |
| device attributes、status 与 cursor-position reply                     | `emulator::GridPerformer` / `TerminalCore`        | ✅   |
| 主屏 cell scrollback、视口切片与 10,000 行 retention cap               | `grid::TerminalGrid`                              | ✅   |
| 主屏 wrapped-line resize reflow 与 cursor remap                        | `grid::reflow`                                    | ✅   |
| OSC 0/2 会话标题                                                       | `emulator::GridPerformer` / `TerminalCore::title` | ✅   |
| PTY spawn、write、resize、exit 与 cleanup                              | CLI 测试驱动                                      | ❌   |

CLI 测试的依赖方向如下。

```text
CLI PTY tests
├─ ash-terminal → vte
└─ portable-pty
```

## 公共契约

| Symbol                           | 调用者看到什么                                              | 不变量                                                  |
| -------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------- |
| `GridSize`                       | 非零 rows/columns                                           | `new` 把零规范化为一                                    |
| `TerminalCore::process_output`   | 增量消费任意 byte chunk                                     | parser state 跨 chunk 保留                              |
| `TerminalCore::resize`           | 调整 grid cell dimensions                                   | cursor 和保存位置始终 clamp 在 grid 内                  |
| `TerminalCore::active_screen`    | 当前 primary/alternate projection                           | `grid` 返回当前屏幕                                     |
| `TerminalCore::title`            | OSC 0/2 最近设置的有界标题                                  | control characters 被移除，最多 256 个字符              |
| `TerminalCore::modes`            | cursor key、cursor visibility、paste 与 mouse request state | mode state 来自 PTY output，不由 UI 推断                |
| `TerminalCore::take_reply_bytes` | 取出 parser 为 terminal query 生成的有序 bytes              | 取出后清空；host 必须把非空结果写回同一 PTY             |
| `TerminalGrid::lines`            | 当前 viewport rows                                          | 每行 cell 数等于 `GridSize::cols`                       |
| `TerminalGrid::scrollback_lines` | 被主屏全屏滚动顶出的有界 cell rows                          | alternate screen 和局部 scroll region 不进入历史        |
| `TerminalGrid::viewport_lines`   | 以行偏移读取一屏 live/history projection                    | 偏移自动 clamp；零偏移始终返回 live grid                |
| `TerminalLine::is_wrapped`       | 当前 physical row 是否延续到下一行                          | reflow 只连接 soft-wrapped rows，不连接 hard line break |

## 内部接口地图

| Symbol                                 | 可见性                      | 职责                                                                                | 修改影响                                                        |
| -------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `emulator::GridPerformer`              | private                     | 把 `vte::Perform` callback 投影为 grid operation 和查询应答                         | 同步检查 parser chunk、CSI/ESC 和查询应答                       |
| `screen::TerminalScreen`               | crate-private               | 拥有 primary/alternate grid、active projection 与 DEC mode transition               | 同步检查 `47/1047/1048/1049` 和 resize                          |
| `screen::TerminalModes`                | public read-only projection | 暴露 PTY 输出声明的 mode state                                                      | 新 mode 必须区分“已解析”与“已执行”                              |
| `grid::scrolling`                      | private child module        | scroll margins、origin-relative addressing、line insert/delete 与主屏历史 retention | 同步检查 full-region/partial-region、alternate screen 和 resize |
| `grid::reflow`                         | private child module        | 把 soft-wrapped logical line 重排为新列宽，并映射 history/cursor/pending-wrap       | 同步检查宽窄 resize、wide cell、alternate screen 与 style       |
| `grid::TerminalGrid::print`            | crate-private               | extended grapheme、Unicode width、wrap 和 continuation cell 写入                    | 同步检查 CJK/Emoji/组合符、wide-character 与 overwrite          |
| `TerminalGrid::{index,reverse_index}`  | crate-private               | cursor movement 与 viewport scroll                                                  | 同步检查 newline、bottom-row 和 resize                          |
| `TerminalGrid::set_graphics_rendition` | crate-private               | SGR → `CellStyle`                                                                   | 同步检查 indexed/truecolor projection                           |

测试驱动通过以下路径读取终端状态。

```text
TerminalCore::process_output(bytes)
└─ vte::Parser::advance
   └─ GridPerformer
      ├─ print / execute
      ├─ csi_dispatch
      │  ├─ TerminalScreen mode/buffer transition
      │  ├─ TerminalGrid mutation
      │  └─ terminal query → ordered reply bytes
      └─ esc_dispatch → TerminalGrid/TerminalScreen mutation

host output event
└─ TerminalCore::take_reply_bytes
   └─ host writes non-empty reply to the same PTY

host resize
└─ TerminalCore::resize
   └─ grid::reflow → retained rows + live rows + cursor remap
```

## 测试与限制

```bash
just check ash-terminal --locked
just test ash-terminal --locked
just rust-warnings ash-terminal --locked
bazel test //crates/terminal:terminal-unit-tests
```

当前测试覆盖：

- printable text、wrap、scroll 与 cursor position；
- CSI cursor addressing、erase line 与 SGR；
- ANSI sequence 跨 output chunk；
- 简中、日文、韩文的 cell width，以及组合音标、ZWJ Emoji 和 regional-indicator flag 的
  extended-grapheme cell ownership；
- wide-character continuation cell；
- primary/alternate screen entry、exit 与 cursor restore。
- DEC application cursor、cursor visibility、bracketed paste 与 mouse request state；
- scrolling margins、origin-relative cursor addressing 与 line insert/delete；
- device attributes、status、standard/private cursor-position replies 与 drain semantics；
- 主屏 full-region scrollback、历史视口、局部 scroll region 排除与 `CSI 3 J` 清理；
- 主屏 soft-wrap reflow、宽字符边界、cursor/pending-wrap 映射与 alternate-screen fixed resize；
- OSC 0/2 title、长度和 control-character filtering。

回滚缓冲区在 `TerminalCore` 生命周期内保留最多 10,000 行。扩展 ANSI 解析时，按 escape-sequence family 增加独立测试。
