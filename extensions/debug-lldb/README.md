# LLDB debugger extension

This optional Rust program supplies `lldb` (CodeLLDB) and `lldb-dap` launch
templates, configuration resolution and adapter descriptors through the public
Rust SDK. It starts on a matching Debug request, initial configuration discovery,
or its installation commands. Editor startup and opening Rust files do not
activate it. Configuration discovery does not download a runtime.
Each invoking window has its own supervised instance, initialization language
and client configuration binding; closing it releases only that instance.
Disabling the extension retires its registrations through the existing package
admission and supervisor. No JavaScript extension host is required.

For `type: "lldb"`, the first launch prepares CodeLLDB 1.12.3 and its matching
LLDB libraries from the platform's complete release package. `runtime.json` pins
the version and SHA-256 for Windows x64, Linux x64/arm64 and macOS x64/arm64.
Downloads stream through Ash's shared HTTP transport. Each HTTPS redirect is
restricted to GitHub's asset hosts; the digest is checked before extraction.
A version/platform filesystem lock coordinates windows and processes. The
complete runtime is published with an atomic directory rename; cancelled,
unsafe or incomplete archives never become an installed runtime.

The status bar shows downloaded MiB and verification/extraction stages. Click it
to cancel; installation failures offer a retry there. Keyboard users can run
**LLDB: Install or Retry Debugger** and **LLDB: Cancel Debugger Installation**
from the command palette. Status text, tooltips and accessible names use the
initiating window's language. Installation details are retained in the LLDB
Output channel. Closing a window or disabling the extension cancels and joins
its work; cancelling one launch preserves preparation needed by another launch.

The default runtime directory is `<user cache>/ash/debug-adapters/codelldb` on
the execution environment. `debug.lldb.runtimeDirectory` chooses another absolute
cache directory. Complete cache hits work offline, including from a read-only
prefilled directory. New processes check installed file sizes and the adapter
and LLDB library digests; damaged installations are rebuilt from the verified
cached archive when available. Older versions are retained for active adapters.

Set `debug.lldb.codeLldbPath` to use an existing CodeLLDB executable instead of
managed installation; `debug.lldb.codeLldbArgs` supplies its extra arguments.
For `type: "lldb-dap"`, install LLVM's adapter separately and configure
`debug.lldb.adapterPath` and `debug.lldb.adapterArgs`. The two configuration
dialects keep separate registrations. Paths and settings belong to the execution
environment, including Remote; no remote launch falls back to local execution.

The initial templates target a conventional Rust debug build; edit `program`
for another artifact or a C/C++ executable. Remove `sourceLanguages: ["rust"]`
for a non-Rust target. Launch/attach properties pass through to the selected
adapter; CodeLLDB's `sourceLanguages` also configures adapter startup settings.

On Windows, the executable descriptor uses this provider's internal
`--stdio-adapter` mode. It starts CodeLLDB with `--connect` on an ephemeral
loopback port, forwards framed DAP messages, and publishes process stdout and
stderr as standard DAP output events. This keeps inherited debuggee output off
the protocol stream, including Rust tests using `terminal: "console"`. The
shared process handle owns the adapter and its descendants; closing the input
or terminating the bridge releases the tree. Transport flags (`--connect`,
`--port`, `--multi-session`) are reserved by the bridge. Other platforms and
`lldb-dap` retain their existing executable transport.

Rust sessions also install a bounded aggregate-summary wrapper in
`preRunCommands`, after CodeLLDB loads the toolchain formatters. It detects
self-referential CodeView fields and large DWARF graphs, and bounds traversal to 8 levels, 64 aggregates
and 8 fields per summary,
preserving ordinary summaries and user commands across resolution and restart.

```json
{
  "version": "0.2.0",
  "configurations": [{
    "type": "lldb",
    "request": "launch",
    "name": "Debug program",
    "program": "${workspaceFolder}/target/debug/example",
    "args": [],
    "cwd": "${workspaceFolder}",
    "sourceLanguages": ["rust"]
  }]
}
```

The extension returns a descriptor, never a running adapter or a DAP session.
Workbench Debug retains sessions, breakpoints, stack inspection and the REPL;
the shared Rust process service authorizes, starts and reaps the adapter. The
extension has no workspace-read or backend RPC grants. Its product-authorized
filesystem access owns the runtime cache; shared HTTP implements network
transport. Cancelling
a callback, revoking execution authority and crashing the provider use the same
Host RPC fences and supervisor as other Rust extensions.
The bundled process uses the existing `AuthorizedProduct` launcher; brokered
grants and OS isolation of third-party programs are separate boundaries.

Product packaging includes `ash-debug-lldb` as an optional executable alongside
the package metadata. Hosts without that executable omit this provider; no
LLDB implementation is linked into App Server. Current TUI products do not
consume the editor Debug contract and need not activate this extension.

## Development and offline preparation

The extension executable exposes the same installer for a developer or offline
image builder. Build it with
`./scripts/.venv/Scripts/python.exe -B scripts/cargo.py build -p ash-debug-lldb --profile dev-small`, then
run the resulting executable with an absolute cache directory:

```powershell
.build/cargo/dev-small/ash-debug-lldb.exe --prepare-runtime C:/path/to/codelldb-cache
```

It emits progress on stderr and a JSON executable path on stdout. This uses the
same pinned manifest, verification, extraction and installation marker as normal
debugging. A verified `codelldb-<platform>.vsix` can be prefilled under
`<cache>/1.12.3/` to avoid a download. For offline distribution, prepare and copy
the complete cache to the execution environment and set
`debug.lldb.runtimeDirectory` to that location. Do not distribute an isolated
adapter executable or DLL. The default Ash package includes the lightweight
Rust provider and metadata, and acquires the runtime only when needed.

Validate with `just verify ash-debug-lldb`. Installer tests cover integrity,
atomic publication, offline reuse/repair, cancellation, traversal and concurrent
windows. `tests/host.rs` starts the real Rust
program and covers all configuration phases, per-client descriptor settings,
Chinese messages, malformed requests, concurrency, cancellation, capability
denial, crash recovery, localized status values, installation retry and shutdown.
Windows `tests/adapter.rs` exercises output isolation, unchanged protocol
messages, input EOF and forced bridge termination against a real child process.

LLDB configuration reference: <https://lldb.llvm.org/use/lldbdap.html>.
CodeLLDB configuration reference: <https://github.com/vadimcn/codelldb/blob/master/MANUAL.md>.
