# `ash-remote-server`

`ash-remote-server` is the headless runtime installed or selected on a target host. It owns a
per-user, per-Directory broker that keeps one shared App Server alive across replacement SSH stdio
connections. It does not initiate SSH and has no desktop or TUI presentation responsibilities.

## Invocation

The normal connection command is:

```bash
ASH_WORKSPACE_ROOT=/absolute/remote/dir \
ash-remote-server connect
```

The direct `app-server --listen stdio://` command remains available for diagnostics and
compatibility, but it is process-scoped and cannot preserve a PTY after its stdio process exits.

`ASH_WORKSPACE_ROOT` must be absolute. [`ash-utils-home-dir`](../utils/home-dir/README.md) resolves `ASH_HOME`
on the remote machine, defaulting to that user's `~/.ash`. An invalid override fails startup.
The retired `ASH_PROFILE_ROOT` variable must be renamed. If a former platform-specific
`remote-server` data directory exists, startup requires an explicit `ASH_HOME` selection before
opening a different data root; see the linked migration instructions.

The canonical runtime package includes this binary. The connection layer selects its exact
immutable path and invokes `connect`; the broker re-enters the same binary with `daemon`.

## Execution path

```text
Remote connection host
  -> ssh … ash-remote-server connect
  -> private Unix socket lookup / guarded daemon start
  -> stdio proxy
  -> shared RemoteServerOptions + AppServer daemon
  -> ash_app_server::open_app_server
  -> AppServer::serve_jsonl for each connection
```

The endpoint identity hashes the canonical profile root, canonical Directory root, canonical
runtime executable generation (path plus Unix file identity and timestamps), selected
product-services manifest identity, and App Server schema. Rebuilding a development executable at
the same path therefore starts a new broker generation instead of reconnecting to an older daemon;
runtime or product configuration generations cannot accidentally reuse an older daemon merely
because their schemas match. Its directory is real, owned by the
effective user, and mode `0700`; the socket and log are private. A guarded start lock prevents
duplicate daemon creation. The daemon remains alive while clients or PTYs exist and otherwise
exits after a bounded idle period. A reconnectable terminal is detached for 30 seconds when its
connection closes, accepts only its 256-bit bearer token, and rotates that token after a successful
attach.

`RemoteServerOptions` owns the remote profile and Directory roots plus an optional manifest path
selected by the executable host. The executable discovers its packaged product-services
manifest through `ash-app-server` and retains a package lease for its lifetime. Manifest discovery, runtime download,
activation, rollback, SSH retry, and tunnel policy stay outside this crate.

## Failure semantics

Unsupported command arguments, a missing or relative `ASH_WORKSPACE_ROOT`, an unsafe runtime
directory, a conflicting endpoint, or daemon startup timeout return `RemoteServerError` before a
connection is exposed. Per-connection protocol failures are written only to the private daemon
log. SSH credentials cannot be exposed because SSH is not present in this process.

## Extension direction

Add persistent session identity, host-restart restoration, capability reporting, and logical
tunnel endpoints for non-SSH transports or Remote service discovery as explicit protocol work.
Basic local `ssh -L` forwarding does not traverse this daemon: keep its listener, credentials, and
SSH spawning in `ash-remote-connections`, its shared lifecycle supervision in `ash-remote-host`,
and UI/product composition in the product host.

## Verification

```bash
just test ash-remote-server
```

The integration tests start the binary and connect through `AppServerSession::start_stdio` to
cover direct stdio plus the real broker process boundary. They prove that a reconnectable PTY
survives the first connector process and can be closed by the replacement connection. App Server
integration tests separately prove wrong-token rejection and old-token replay rejection after
rotation.
