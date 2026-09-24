# Ash

Ash is a Rust-first agent workspace with three product lines sharing one App Server contract:

| Product | Description | Source | Start |
| --- | --- | --- | --- |
| `ash code` | Terminal UI | [`code`](code) | `just ash` |
| `ash` | Electron Desktop | [`app-ts`](app-ts) | `just ash-desktop` |
| `app` | Rust Desktop terminal | [`app-rs`](app-rs) | `just app` |

`ash-rs` contains the shared Rust backend. The product-neutral backend executable is
`ash-app-server`, owned by [`ash-app-server`](ash-rs/app-server/README.md). Electron's `code` and
`academic` builds are internal variants, not additional product lines; see
[`docs/product-lines.md`](docs/product-lines.md) and [`docs/workbench-modes.md`](docs/workbench-modes.md).

## Quick start

The commands below build and run Ash from source through Just. Tool requirements
and initialization are described in [the build guide](docs/build.md#构建入口).

On Windows, prepare the tools listed in the
[Windows requirements](docs/build.md#windows-开发环境).
Test maintenance tools such as `cargo-insta` are installed separately when needed.

After installation, open Visual Studio Developer PowerShell for the target
architecture. Use that shell for the product commands
below so MSVC and Windows SDK environment variables reach the build processes.
See [Windows environment responsibilities](docs/build.md#windows-开发环境).

On macOS or Linux, install Rust. Cargo supplies the input classifier's
build-time Protocol Buffers compiler; no system `protoc` installation is
required.

For Electron or Browser Workbench development, first install the Node version in
`.nvmrc`. From the repository root, install the pnpm version declared by
`package.json`, then install workspace dependencies:

```bash
npm install -g "$(node -p 'require("./package.json").packageManager')"
pnpm install
```

These commands work in PowerShell and Bash. The install check requires the exact
declared pnpm version.

Build definitions live in [`build/`](build), while reproducible local artifacts are collected under the ignored `.build/` root. See [`docs/build.md`](docs/build.md) for the command and output layout.

Build all three product lines through the repository-level command:

```bash
just build
```

Use `just build-code`, `just build-desktop`, or `just build-app` to build one product host.
`just build-rust` remains the explicit full Rust workspace build.

`pnpm build` builds only the Electron and Browser workspace.

### `ash code`

```bash
just ash
just ash ask "explain this repository"
just ash exec "summarize the current changes"
```

### `ash` Electron Desktop

```bash
just ash-desktop
```

In VS Code, select `Ash Desktop (Electron)` and press F5 to run the same command. The three
product groups are `Ash Code (TUI)`, `Ash Desktop (Electron)`, and `App (Rust Desktop)`.

The Desktop command is shared by both Workbench build modes. The default mode is `code`; build
matrix checks can set `ASH_WORKBENCH_MODE=academic` without changing the command name.

### Browser Workbench

```bash
pnpm dev:web       # disconnected UI at http://127.0.0.1:5173/
pnpm dev:web:full # Rust-backed UI at http://127.0.0.1:5174/
```

The full Web mode is a local development integration, not a deployable Web service.

### Stanza standalone editor

只调试 Stanza 编辑器本身时运行：

```bash
pnpm dev:stanza
```

然后打开 `http://127.0.0.1:5199/build/app_ts/vite/stanza/index.html`。在 VS Code 中也可以选择
`Stanza Editor - Standalone` 配置按 F5；它会自动启动 Vite 并打开浏览器调试。页面把完整 API 暴露为
`globalThis.stanza`，可在浏览器控制台检查 `stanza.editor.getEditors()` 和
`stanza.editor.getModels()`。

### `app`

```bash
just app
```

## Repository map

- [`ash-rs`](ash-rs): shared protocol, App Server, domain, storage, execution, and runtime crates.
- [`cli`](cli): user-facing `ash` command, including shared management and terminal launch.
- [`code`](code): terminal presentation and terminal-specific capabilities.
- [`app-ts`](app-ts): Electron Main, Preload, Renderer, and Browser Workbench.
- [`build`](build): checked-in build orchestration; generated artifacts go to `.build/`.
- [`app-rs`](app-rs): Rust window, terminal, renderer, and product UI.
- [`docs`](docs): architecture and system documentation; start with [`docs/README.md`](docs/README.md).

## Where to read next

- [Ash user documentation](https://github.com/chogng/ash-docs)
- [Product lines and host boundaries](docs/product-lines.md)
- [System architecture](docs/architecture.md)
- [Ash Code documentation](code/README.md)
- [Electron Desktop architecture](docs/ash-desktop-architecture.md)
- [Shared Rust architecture](docs/ash-rs-architecture.md)
- [Remote development](docs/remote-development.md)
- [Packaging](build/ash_rs/README.md)
- [`app` release graph](app-rs/docs/app-release-graph.md)

Crate-level implementation details live in the `README.md` next to each crate.

## License

Ash's original code and materials are proprietary and all rights reserved. See [`LICENSE`](LICENSE).
Third-party components remain governed by their own licenses and notices, including
[`app-ts/THIRD_PARTY_NOTICES.md`](app-ts/THIRD_PARTY_NOTICES.md).
