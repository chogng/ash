# `ash-debug-adapter`

This crate owns the backend-neutral runtime for trusted Debug Adapter Protocol (DAP) stdio processes and server/pipe connections. Cross-boundary product behavior and current system status are documented in [`docs/debugging.md`](../../docs/debugging.md); this README is the canonical implementation contract for this crate.

## Ownership

`DebugAdapterService` owns process and connection lifetimes, bounded output, DAP `Content-Length` framing, session identity, and cleanup. It requires both `LoadExecutableConfiguration` and `ExecuteProcess` capabilities for the same directory root. It does not parse `.vscode/launch.json`, own breakpoints, implement DAP client state, authorize App Server connections, or render UI.

| Symbol                                | Responsibility                                                                 | Must not own                                 |
| ------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------- |
| `DebugAdapterService`                 | Validate active directory capabilities and own at most eight adapter processes | Product configuration or connection identity |
| `DebugAdapterCommand::new`            | Bound program and arguments and reject NUL input                               | Executable discovery                         |
| `read_message` / `encode_message`     | Parse and create bounded DAP frames                                            | Request pairing or DAP semantics             |
| `DebugAdapterState`                   | Retain at most 512 messages plus bounded stderr and exit state                 | Durable history                              |
| `push_message`                        | Assign ordered sequence numbers and evict the oldest retained messages         | Consumer cursors                             |
| `refresh_process_state` / `terminate` | Observe exit and reap or kill the child                                        | Restart policy                               |

The executable call path is `DebugAdapterService::start` → `tokio::process::Command` → `spawn_message_reader` / `spawn_stderr_reader`. `connect` opens TCP or an OS named pipe (Unix socket on Unix), then uses the same framing, writer and retained-message owner. Connection attempts have a ten-second deadline; closed peers set exited with an unknown exit code. Callers send JSON through `send`; `read` returns the next bounded page and advances only past messages in that page. Adapter `seq` values may start at zero (LLDB-DAP emits zero); the retained-message cursor is assigned separately by this process owner. Request pairing belongs to the client and uses `request_seq`. A consumer that falls behind the retained prefix receives `output_gap = true` and must fail the session instead of silently skipping protocol events.

## Failure and integration semantics

Invalid commands and reads fail before mutation. Process launch, framing failure, broken pipes, and poisoned locks are explicit errors. `close` removes exactly one session, reaps any child, aborts and awaits its readers and shuts down the writer before acknowledgement; `terminate_all` is the fail-safe for trust retirement and drop. App Server connection ownership is deliberately implemented by its `debug_service::DebugAdapterService` wrapper rather than this crate.

The process environment is supplied by the caller and the runtime clears inherited variables before applying it. App Server supplies the frozen developer environment, including SDK credentials and toolchain variables, with host authentication and Electron launcher controls removed; it rejects explicit overrides of host authentication variables. An executable descriptor may override child values or remove inherited keys with null; these changes apply to a copied snapshot and never change subsequent launches. The runtime canonicalizes a supplied cwd beneath its authorized directory root. Expanding directory variables and handling DAP reverse requests remain caller obligations.

## Tests and modification impact

Run `cargo test -p ash-debug-adapter`. Framing coverage lives in `framing_tests.rs`; process/session tests should be added in sibling test files. Changes to messages or limits must be reviewed against App Server pagination and `docs/debugging.md`. Adding product configuration, UI state, connection IDs, or another process registry here would signal ownership drift.

## Current limitations

The crate supports stdio, TCP servers and OS named pipes. It does not own inline adapters, durable session recovery, restart, telemetry, or language-specific adapter discovery. Inline extension implementations belong to the TypeScript DAP session and Extension Host callback boundary.
