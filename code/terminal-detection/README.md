# `ash-terminal-detection`

1. Lives in `code/terminal-detection` and owns Ash Code's process-local host-terminal detection.
2. Identifies the terminal program, multiplexer and color fidelity from process environment.
3. Resolves background appearance from an OSC-reported color and `COLORFGBG`, retaining the evidence source.
4. Leaves terminal input and queries, child-terminal emulation, PTY management and theme selection to their owners.

| Symbol | Responsibility |
| --- | --- |
| `detect_host_terminal` | Cached process-wide terminal, multiplexer and color-level detection |
| `HostTerminal` | Structured program, version, TERM and multiplexer metadata |
| `TerminalKind` | Stable known-terminal category used by product adapters |
| `ColorLevel` | TrueColor, ANSI-256, ANSI-16 or monochrome fidelity |
| `resolve_background` | OSC 11 RGB → `COLORFGBG` → conservative Dark resolution |

The TUI owns exclusive terminal-response probe windows because those reads must be coordinated with
its crossterm event stream. [`ash-terminal`](../../app-rs/terminal/README.md) separately owns child-terminal emulation, while
[`ash-utils-pty`](../../ash-rs/utils/pty/README.md) owns process and PTY plumbing.

```text
ash-tui
├─ ash-terminal-detection  # environment identity
├─ terminal/terminal_probe  # OSC query while TUI exclusively owns stdin
└─ theme                    # TUI-owned palettes, preference, and terminal colors
```

Detection favors `TERM_PROGRAM`, then terminal-specific variables, then `TERM`; tmux and Zellij
program markers identify the multiplexer and do not hide the underlying terminal or overwrite its
version. Ghostty is recognized through its program name, resources directory, or `xterm-ghostty`.
Detection never starts helper processes. TUI startup failures include these same terminal facts
and retain the original I/O error and terminal-mode cleanup.

```bash
just check ash-terminal-detection --locked
just test ash-terminal-detection --locked
just rust-warnings ash-terminal-detection --locked
bazel test //code/terminal-detection:terminal-detection-unit-tests
```
