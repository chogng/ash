# Ash

Ash is an agent workspace with an Electron/Web interface and a Rust CLI/TUI, sharing one Rust App Server contract.

| Product  | Source                                        | Start              |
| -------- | --------------------------------------------- | ------------------ |
| Desktop  | [`src/`](src)                                 | `just ash-desktop` |
| Terminal | [`cli/`](cli) and [`crates/tui/`](crates/tui) | `just ash`         |

[`crates/`](crates) contains the Rust backend and terminal crates. Crate ownership and build targets keep terminal presentation separate from the shared backend. Desktop packaging selects backend executables and does not include the CLI/TUI.

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

On macOS or Linux, install Rust and Python 3.11 or newer; Python 3.12 is
recommended. Confirm that `python3` resolves to that version before running
backend preparation or Desktop smoke tests. See the [build guide](docs/build.md#macos-与-linux-开发环境)
for the macOS Homebrew path requirement.

For Electron or Browser Workbench development, install the pnpm version declared
by `package.json` using the [standalone installer](https://pnpm.io/installation/),
then install workspace dependencies from the repository root. pnpm downloads and
uses the Node version pinned in `devEngines.runtime`; `.nvmrc` pins the same
version for commands run outside pnpm:

```bash
pnpm install
```

This command works in PowerShell and Bash. The install check requires the exact
declared pnpm version.

Build definitions live in [`build/`](build), while reproducible local artifacts are collected under the ignored `.build/` root. See [`docs/build.md`](docs/build.md) for the command and output layout.

Build both products through the repository-level command:

```bash
just build
```

Use `just build-code` or `just build-desktop` to build one product host.
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

In VS Code, select `Ash (Electron)` and press F5 to run the same command. The product groups are `Ash Code (TUI)` and `Ash (Electron)`.
`Ash (Electron, Frontend Watch Only)` also runs the Rust backend but only watches frontend
and Electron host changes. `Ash Web (Chrome)` starts the independent Browser Workbench.
Stopping either its server or Chrome debug session stops both, so the next F5 can reuse the port.

Desktop starts the Code Workbench and provides a separate Agents window. Academic documents
open in the same Workbench; startup does not select a product mode.

For a Linux Electron Desktop, Web, and Rust backend environment, open the repository in the
[Dev Container](docs/build.md#dev-containerlinux-desktopweb-与后端).

### Browser Workbench

```bash
pnpm dev:web      # Browser Workbench at http://127.0.0.1:5173/, no Rust build
pnpm dev:web:full # Rust-backed UI at http://127.0.0.1:5174/
pnpm dev:web:agents # Sessions with App Server and frontend/backend watching
pnpm dev:web:agents:ui # Sessions UI at http://127.0.0.1:5173/, no Rust build
```

The full Web mode is a local development integration, not a deployable Web service.

For Sessions, select `Ash Sessions Web (Chrome)` with F5 to prepare the backend and
open its authenticated Sessions page in the browser debugger. The UI-only configuration
is `Ash Sessions Web (Chrome, UI Only)`. Both use Vite hot updates; connected Web commands
also rebuild Rust sources and switch the managed backend after successful compilation,
retaining browser authentication and unsent input. See [frontend development](docs/frontend.md#日常-web-开发).

Use `Ash Web (Chrome)` with F5 for browser development. This mode opens, edits and saves
browser-authorized local folders, restores dirty editors after reload, stores settings in IndexedDB,
and loads the built-in languages, grammars, snippets and themes. Workspace text search reads the
authorized folder directly. Process-backed terminals, tasks, debugging, Git and agent requests
require the connected mode. This separation follows VS Code's browser development entrypoint;
it does not imply full VS Code feature or Extension API compatibility.

For a trusted browser extension under development, set `ASH_WEB_EXTENSION_PATHS` to its package
directory (multiple directories use the platform path delimiter). The package's `browser` field
points to a bundled ES module exporting `activate({ register })`. Registrations use Ash Host API v1;
the module runs in a page-owned Worker. Vite watches package resources and reloads their snapshot.
For example, in PowerShell:

```powershell
$env:ASH_WEB_EXTENSION_PATHS = (Resolve-Path test/fixtures/web-extension).Path
pnpm dev:web
```

This is an explicit trusted development input, with no third-party installation or sandbox claim.
Use `pnpm test:smoke:browser:dev` to test the development entry and
`pnpm test:smoke:browser` to test the built Web artifacts.

### Stanza standalone editor

只调试 Stanza 编辑器本身时运行：

```bash
pnpm dev:stanza
```

然后打开 `http://127.0.0.1:5199/build/desktop/vite/stanza/index.html`。在 VS Code 中也可以选择
`Stanza Editor - Standalone` 配置按 F5；它会自动启动 Vite 并打开浏览器调试。页面把完整 API 暴露为
`globalThis.stanza`，可在浏览器控制台检查 `stanza.editor.getEditors()` 和
`stanza.editor.getModels()`。

## Repository map

- [`src/`](src): Electron Main, Preload, Renderer, and Browser Workbench.
- [`cli/`](cli): user-facing `ash` command and terminal launch.
- [`crates/`](crates): Rust protocols, backend domains, runtime, and terminal crates.
- [`build/`](build): build and packaging tools; generated artifacts go to `.build/`.
- [`docs/`](docs): architecture and development documentation.

## Where to read next

- [Ash user documentation](https://github.com/chogng/ash-docs)
- [Product lines and host boundaries](docs/product-lines.md)
- [System architecture](docs/architecture.md)
- [Ash Code documentation](crates/tui/README.md)
- [Electron Desktop architecture](docs/ash-desktop-architecture.md)
- [Shared Rust architecture](docs/rust-architecture.md)
- [Remote development](docs/remote-development.md)
- [Packaging](build/runtime/README.md)

Crate-level implementation details live in the `README.md` next to each crate.

## License

Ash's original code and materials are proprietary and all rights reserved. See [`LICENSE`](LICENSE).
Third-party components remain governed by their own licenses and notices, including
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
