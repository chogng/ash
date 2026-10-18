# `ash-debug-contract`

Transport-independent runtime breakpoint and inspection values shared by
`ash-debug-manager` and `ash-app-server-protocol`. The protocol owns RPC methods,
connection/directory identities and generated codecs; this crate owns domain value
shapes. It contains no process, storage or Workbench dependencies.

Breakpoint intents distinguish source, function, data and instruction addresses.
Bindings expose pending/confirmed/removed state and typed unsupported reasons;
protocol payloads remain available to extension consumers. Inspection queries carry
explicit selection, and their results distinguish pending, completion, failure and
invalidation. Watch errors belong to each expression.

Run `just verify ash-debug-contract`. Product protocol generation recursively emits
these domain values together with its method map and runtime decoder.

Workspace definitions, edit operations and revisioned results also live here. They
exclude adapter verification, evaluation results and session-bound addresses. The
manager owns validation/edit application and persistence; Workbench decodes legacy
Memento values before submitting a one-way import through the product protocol.

Session admissions/relations, versioned live exception selection and structured
console entries/snapshots also live here. Object output carries its inspection
epoch; Rust owns their validation, lifecycle, ordering and bounded retention.
Connection, RPC and Workbench identities are bound by their respective hosts.
