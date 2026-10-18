# `ash-debug-manager`

Directory-authorized DAP client and transport lifetime owner. App Server adds the
authenticated connection binding; Workbench consumes it through its domain adapter.
The [system design](../../docs/debugging.md#已确认的目标分层) describes the full
manager target. The manager owns request dispatch, transport resources,
initialization/configuration gates, normalized capabilities (including incremental
capabilities events), session execution state and inspection-result invalidation.
Session runtime intents, DAP bindings, breakpoint events, Watch evaluation and
inspection dependency chains are owned here. The editable workspace catalogue and
its existing Memento persistence, UI selection and parent/child coordination still
live in Workbench; durable catalogue migration is not part of this completed slice.

The manager owns up to eight sessions. Each contains one `ash-debug-client` and
either an `ash-debug-adapter` process/TCP/pipe transport or client-supplied inline
IO. Inline input is rejected for process/network sessions. Both directory grants
must remain active for reads and operations; close remains available after revocation.

`request` allocates and writes through the client. `response` pumps an adapter page
and reads the paired result, independently of the panel/observation reader.
`reply` accepts only an outstanding reverse-request response and assigns its seq.
`input` feeds the bound inline implementation; outgoing inline messages are read
through the same ordered observations and forwarded by Workbench's raw session.

Each observation page retains both message directions for tracker ordering. The
log is bounded to 512 messages and the transport's four-MiB frame budget; reads
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
resume or invalidated event invalidates pending stackTrace/scopes/variables/setVariable
results without replaying them. Terminal state cannot be revived by late events.
Tests additionally cover initialization ordering, dynamic capabilities, configuration
gates, startup failure, deadlines, signed thread identities and stale inspection.

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
