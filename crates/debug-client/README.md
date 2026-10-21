# `ash-debug-client`

Transport-independent request ownership for one DAP session. `ash-debug-manager`
supplies ordered input and writes the returned messages through the selected
transport. The client has no App Server, editor, filesystem or process dependency.

`DebugClient::request` registers the waiter before returning its outgoing message.
One outgoing sequence space serves requests and reverse-request replies. Adapter
`seq` values may start at zero; responses pair by `request_seq` and must match the
original command. Adapter errors and response objects retain omitted fields and
explicit JSON null. `response` consumes a completed or failed result once.

Deadlines use a monotonic clock and are checked when accepting or reading a
response. Late responses cannot replace a timeout. There are at most 128 retained
requests/results and 128 outstanding reverse requests. `close` fails all waiting
requests and rejects further input or requests; it never replays an operation.

Launch/configurationDone orchestration, capability normalization, breakpoint
semantics and execution state belong to `ash-debug-manager`, as described in
[the system design](../../docs/debugging.md#目标分层).
Run `just verify ash-debug-client` for protocol and resource-boundary tests.
