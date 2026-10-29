# `ash-debug-manager`

Directory-authorized DAP client and transport lifetime owner. App Server adds the
authenticated connection binding; Workbench consumes it through its domain adapter.
The [system design](../../docs/debugging.md#目标分层) describes the full
manager target. The manager owns request dispatch, transport resources,
initialization/configuration gates, normalized capabilities (including incremental
capabilities events), session execution state and inspection-result invalidation.
Session runtime intents, DAP bindings, breakpoint events, Watch evaluation and
inspection dependency chains are owned here. `DebugWorkspaceStore` also owns
workspace breakpoint/Watch definitions and their profile-local SQLite persistence.
`DebugSessions` owns connection-scoped admissions before descriptor resolution,
parent/child revocation across directory managers, noDebug inheritance, lifecycle
targets and console grouping. It closes descendant runtime resources without a
renderer round trip. Workbench releases editor/extension callbacks from the
returned identities. UI selection and editor objects remain in Workbench.

Live exception selection uses versioned serialized application; a rejected edit
does not end an active session. Omitted initial filters use defaults, while an
explicit empty selection stays empty. Desired and acknowledged preferences are
separate; noDebug sends empty filters without erasing the stored preference.
Generic requests cannot bypass this owner.

The registry owns bounded structured output (512 entries / 128,000 bytes per
console; 20 retained ended consoles), normalization, grouping, clear, and REPL
input/result/error ordering. Object references retain their original inspection
epoch. Output and the graph are connection-owned, never workspace-persistent.

The manager owns up to sixteen sessions. Each contains one `ash-debug-client` and
either an `ash-debug-adapter` process/TCP/pipe transport or client-supplied inline
IO. Inline input is rejected for process/network sessions. Both directory grants
must remain active for reads and operations; close remains available after revocation.

`request` allocates and writes through the client. `response` pumps an adapter page
and reads the paired result, independently of the panel/observation reader.
`reply` accepts only an outstanding reverse-request response and assigns its seq.
`input` feeds the bound inline implementation; outgoing inline messages are read
through the same ordered observations and forwarded by Workbench's raw session.

Each observation page retains both message directions for tracker ordering. The
log is bounded to 8,192 messages and the transport's four-MiB frame budget; reads
advance only through the returned page and report an evicted prefix as a gap.
Stderr is retained separately up to 64 KiB, including when response polling reads
the transport first. Protocol failures settle pending requests. EOF drains all
transport pages before publishing exit. No failure automatically relaunches or
replays an operation. `close` removes the session and awaits the existing transport
runtime's cleanup; manager destruction releases all remaining transports.

Run `just verify ash-debug-manager`. Tests exercise a real TCP peer, inline input,
response pairing without a view reader, socket close acknowledgement, invalid
input, pagination, bounded observations and authorization revocation.

`initialize` starts a one-shot state machine and returns without awaiting DAP. A
read/response/input advances initialize → launch/attach → initialized → configuring.
This permits reverse host requests and delayed launch responses without a blocking
RPC. `configure` submits the client's exception-filter selection, applies negotiated
defaults/support, sends setExceptionBreakpoints and optionally configurationDone,
then waits for launch completion. noDebug suppresses exception filters; unknown
filter selections are rejected before the configuration phase advances. Reads expose a monotonic snapshot revision and
execution revision; UI selection is deliberately absent from the backend model.

Execution events beat delayed continue/step/restart responses using the captured
execution revision. Failed requests never synthesize a running state. A new stop,
resume or invalidated event invalidates pending stackTrace/scopes/variables/setVariable/completions
results without replaying them. Terminal state cannot be revived by late events.
A DAP `exited` event alone does not end the debug session. On `terminated`,
the manager queues one `disconnect` acknowledgement before exposing the ended
snapshot, unless the client already requested disconnect. This releases adapter
children before their multiplexing parent completes shutdown; the acknowledgement
does not terminate borrowed attach targets.

Tests additionally cover initialization ordering, dynamic capabilities, configuration
gates, startup failure, deadlines, signed thread identities and stale inspection.

Completion and cancel capabilities are normalized with bounded trigger characters;
omitted triggers use the DAP default `.` and an explicit empty list stays empty.
The request identity returned by this owner is its DAP sequence, so an advisory
cancel can target it without a frontend sequence allocator or pairing table.
Cancel has its own identity; either response can arrive first and is consumed once.

`set_breakpoints` accepts a complete runtime intent and monotonic edit version.
`breakpoints.rs` serializes per-source/family DAP replacements, clears retired
sources, rejects generic request bypasses and ignores older edits. A delayed reply
can bind only an unchanged current intent. Unsupported conditions never become
unconditional breakpoints; data/instruction addresses apply only to their session
or admitted persistent adapter type. Adapter new/changed/removed events update the
same bindings. Pending states and snapshot revisions let the facade publish only
confirmed changes. Generic `setBreakpoints` and related family requests are rejected.

`inspection.rs` owns stack (threads → selected stack), frame (scopes → variables),
child-variable and Watch jobs. Every start requires the caller's inspection revision;
an old pause is refused before sending DAP. Continuations and completed results
are invalidated when execution or invalidated events advance the epoch. Selection
is explicit on each query, and single-expression/scope failures preserve peers.
Jobs are bounded (16 retained jobs, 128 Watch expressions, 30-second deadlines,
shared two-MiB retained result budget); terminal results are consumed once. Pending
requests of a retired job are drained, never replayed. Closing the session drops
all jobs and releases its client/transport. No separate cancellation RPC is exposed.

Runtime intent input is bounded to 512 points and one MiB; binding snapshots share
a two-MiB bound. The one outstanding replacement is independent of view reads and
trackers. [Domain values](../debug-contract/README.md) contain no transport owners.

`workspace.rs` applies identity-based edits to the `debug_workspaces` table in the
profile database. Workspace ID is independent of directory, Project and live session
identity. Transactions compare the complete document revision before applying edits;
conflicts return the current snapshot without overwriting either client's intent.
Definitions contain source/function points, explicitly persistent data points,
ordered Watch expressions and per-adapter exception selections. Runtime verification,
session IDs, nonpersistent data points and instruction addresses are excluded.

The Workbench legacy decoder imports its existing v1/v2 Memento before normal
resolution. Import and a digest receipt commit atomically into an absent or equal
target. A differing target returns a conflict; an acknowledged digest allows cleanup
to resume after a crash without replaying old definitions over newer edits. App
Server opens this store once per profile, separately from connection-owned DAP
resources. Connection close never deletes workspace definitions. Tests cover reopen,
independent SQLite connections, atomic rejection, equal/conflicting imports and
interrupted cleanup after later edits.
