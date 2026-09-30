# `ash-remote-server`

`ash-remote-server` runs on the target host and connects SSH stdio to that user's shared profile
App Server. It does not initiate SSH and has no desktop or TUI presentation responsibilities.

## Invocation

The normal connection command is:

```bash
ASH_WORKSPACE_ROOT=/absolute/remote/dir \
ash-remote-server connect
```

An execution connection uses `ash-remote-server execution-connect ENVIRONMENT` with the same
absolute `ASH_WORKSPACE_ROOT`. The host-authenticated channel carries the versioned
[`exec-server-protocol`](../exec-server-protocol/README.md), rather than Agent RPC. Its profile
host retains file authority and command resources across connector exits; active commands keep
the managed host alive. The environment ID cannot be rebound to another canonical directory.
This endpoint does not create Agent history. After history ownership transfers, the managed
process starts only execution services: it does not open the old Agent, queue or automation
runtime, and it refuses Agent RPC connections. Before transfer it retains its existing profile
services. Desktop's default Remote Agent routing has not yet switched to the local Agent.

The direct `app-server --listen stdio://` command remains available for diagnostics and
compatibility, but it is process-scoped and cannot preserve a PTY after its stdio process exits.
It cannot reopen an Agent writer for a transferred profile.

## History ownership transfer

The product host can use these internal operations with its selected profile and exact runtime:

1. Local `ash-app-server history-identity` returns the persistent receiver identity.
2. Remote `ash-remote-server history-export RECEIVER` durably freezes history, stops the profile
   backend, and writes a bounded binary archive to stdout. Export failure leaves the source frozen;
   the same receiver can retry. The source copy remains readable and cannot transfer to a different receiver.
3. Local `ash-app-server history-import HOST` stops the local backend, reads the archive from
   stdin, and writes a JSON import receipt only after the complete SQLite transaction commits.
4. Local `ash-app-server history-bind SESSION_ID /absolute/remote/root` explicitly binds imported
   history with an unknown directory. Existing bindings cannot silently move to another directory.

The archive preserves original event bytes and identities, retained prefix closure, referenced
attachments and change-set state. It excludes configuration and credentials. The receiver identity,
frame bounds, content digests, relational references, catalogs and history sequences are validated;
identity conflicts roll back the complete import. SSH host/root bindings are separate durable state.
An export command's directory never supplies missing historical directories. Unbound histories
remain readable, but new Turns and interaction continuations cannot execute until binding.

These operations are implemented and tested across real connector/backend processes with an SSH
substitute. Desktop connection acquisition does not yet invoke them automatically, and existing
user profiles are not migrated just by running or building the product.

`ASH_WORKSPACE_ROOT` must be absolute. [`ash-utils-home-dir`](../utils/home-dir/README.md) resolves `ASH_HOME`
on the remote machine, defaulting to that user's `~/.ash`. An invalid override fails startup.
The retired `ASH_PROFILE_ROOT` variable must be renamed. If a former platform-specific
`remote-server` data directory exists, startup requires an explicit `ASH_HOME` selection before
opening a different data root; see the linked migration instructions.

The canonical runtime package includes this binary. The connection layer selects its exact
immutable path and invokes `connect`. The connector selects the package's sibling independent
`ash-app-server` executable, or the absolute executable selected by `ASH_APP_SERVER_PATH`.
It no longer starts itself as a daemon.

## Execution path

```text
Remote connection host
  -> ssh … ash-remote-server connect
  -> ash-app-server-daemon connect_selected
  -> private profile endpoint / guarded daemon start
  -> stdio proxy
  -> independent ash-app-server --managed
  -> ash_app_server::open_app_server
  -> AppServer::serve_jsonl for each connection
```

One profile has one backend process, with separate protocol connections and directory grants.
Empty connections and different directories share that process. The endpoint is keyed by profile;
the selected runtime's backend content identity controls generation replacement. Selecting a
different executable replaces the profile process and interrupts its connections and terminals.
Rebuilding an executable at the same path is detected by its content identity.
[`ash-app-server-daemon`](../app-server-daemon/README.md) owns guarded startup, process identity,
package leases, endpoint security, and health checks. The daemon remains alive while clients,
PTYs, execution commands, queue work, or automation require it, and otherwise exits after a bounded idle period
(`ASH_LOCAL_APP_SERVER_IDLE_TIMEOUT_MILLIS` in targeted tests).
A reconnectable terminal is detached for 30 seconds when its
connection closes, accepts only its 256-bit bearer token, and rotates that token after a successful
attach.

`RemoteServerOptions` owns the remote profile, optional Directory root, and optional manifest path.
Without a Directory root, the same SSH host can serve an empty Workbench without granting access
to the previously opened folder. Closing one connection does not replace another connection's
directory authority.
The executable selects and discovers its packaged product-services
manifest through `ash-app-server` and retains a package lease for its lifetime. Manifest discovery, runtime download,
activation, rollback, SSH retry, and tunnel policy stay outside this crate.

## Failure semantics

Unsupported command arguments, a relative `ASH_WORKSPACE_ROOT`, an unsafe runtime
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
cover direct stdio plus the shared backend process boundary. They prove that a reconnectable PTY
survives the first connector process and can be closed by the replacement connection. They also
verify one PID across two directories and an empty connection, authority isolation, conditional
write conflict, and closing one connection while another remains usable. App Server
integration tests separately prove wrong-token rejection and old-token replay rejection after
rotation.

`tests/execution.rs` drives the execution endpoint through an OpenSSH test substitute and real
connector/backend processes. It verifies command survival beyond the disconnected host's idle
deadline, file revision conflicts, root confinement, cancellation, and a local Agent Turn that
requires approval before SSH file mutation and persists its history only in the local test profile.
It also transfers historical IDs across SSH and process boundaries, rolls back a truncated import,
retries the same archive, explicitly binds an unknown directory, rejects the old Agent entrypoint,
and restarts the frozen remote profile with functioning execution services and unchanged history.
