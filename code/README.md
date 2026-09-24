# `code`

> 命令用法与验证见 [CLI README](../cli/README.md)；终端实现与测试见 [TUI README](tui/README.md)；共享请求与通知见 [App Server API](../docs/ash-app-server-api.md)。

`code/` is the product-owned source boundary for the `ash code` terminal product.
It contains the `ash-tui` presentation shell and
[host-terminal detection](terminal-detection/README.md).
The root [`cli/`](../cli/README.md) owns the user-facing `ash` command. It launches the TUI and
provides shared App Server management commands to installations of all three clients.

The product depends on shared contracts and runtime services from `ash-rs`, but the terminal
experience itself does not belong to the shared backend. Raw mode, alternate-screen lifecycle,
keyboard input, Ratatui layout, composer state, and TUI presentation state stay here.

```text
cli → code/tui → ash-app-server-client → shared App Server crates
```

The Rust `app` product has a separate ownership boundary under `app-rs/`; its reusable GPU UI
crates, including `ash-ui-components` and `zui`, must not be copied into this product.

## Run and verify

From the repository root, `just ash` opens the terminal UI. `just check ash-tui`
and `just test ash-tui --lib` validate its Rust owner; process-level terminal
scenarios run through `just test-tui`. CLI commands, remote connections,
updates, and installers are documented in [`cli/README.md`](../cli/README.md).
