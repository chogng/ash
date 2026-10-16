# Editor performance boundaries

Read the parts implicated by measurements; these are diagnostic leads, not a list of required architectural changes.

## Incremental syntax and client state

Trace `src/ash/workbench/services/treeSitter` through `crates/app-server/src/server/syntax_operations*` into `crates/syntax`. Compare the effective normalized edits actually applied to the document with the edits used to update cached facts. Undo, CRLF normalization, multi-edit transactions and non-BMP Unicode can expose mismatches hidden by an ASCII insertion. Preserve revision and cancellation contracts while reducing scanned or serialized data.

A local edit should not gratuitously copy every line ID, search every tab for an already-known editor index, or rebuild unchanged large facts arrays. Structural sharing still needs correct identity: a new revision must not inherit a cached cancelled promise merely because its top-level facts object was reused. Test the consumer contract, not just the producer's smaller allocation count.

Check invalidation fan-out when one activation produces a burst of backend requests. Updating navigation/completion providers through a shared batch need not change syntax providers; re-publishing an unchanged syntax group can restart analysis in every open model and exhaust a bounded request queue. Preserve unchanged provider identity and test both the no-op notification case and actual replacement/rollback.

## Language analysis and workspace work

The client TextModel owns unsaved text. A language analysis cache may retain bounded derived results; it must not become an independent editor document store. Keys need document identity and valid snapshot identity, not just a version number that can be reused after close/reopen. Account for retained indexes and strings, late results and close invalidation, rather than bounding only source bytes.

Check the actual model registry before trusting language-event tests. Ash file editors acquire models through `IFileTextModelService`; standalone/editor-support models use `IModelService`. Activation, document notifications, client document reads and diagnostic version checks must observe the same intended model population. A test that creates a model in the other registry can pass while real file editing never reaches the extension. Removal callbacks that need the final snapshot must run before the model becomes unreadable.

For document notifications, count client text reads and parses as the number of unrelated open documents grows. An initial dependency scan and an incremental event have different costs; compare them separately. If updates use a dependency index, cancelled or failed publication must leave a recoverable state. Do not silently convert a bounded index overflow into missing diagnostics. Collision-heavy inputs, such as repeated heading slugs, help distinguish linear work from repeated searches starting at the beginning.

## Extension transport and cancellation

Trace `src/ash/platform/agentHost/browser/extensionHostProtocol.ts`, the extension-host service and the matching Rust broker/SDK. Check payload normalization and copies before assuming the parser owns the pause. Measure the actual product extension process, not a similarly named Worker or a replacement implementation.

Cancellation is a lifecycle operation, not proof that a transport result has been consumed. Inspect the current broker contract: a cancelled invocation may retain a terminal result until the caller reads it. Repeated abandoned sessions can exhaust a per-client quota after a short benchmark has already looked healthy. Verify bounded cleanup, terminal consumption and disposal of timeout/abort listeners; do not change the protocol's ownership semantics to hide the symptom.

When a feature works on small startup but disappears after large-file edits, collect the provider's named Output channel, lifecycle, stderr and runtime errors after the workload. Also inspect activation metadata and the command's captured editor context. A command picker closing is not an assertion that asynchronous activation or rendering succeeded. Reproduce the failure before choosing among startup, cancellation, payload, process exit and stale-generation hypotheses.

Also read the fleet Output channel. An unrelated provider's rejected registration can prevent the whole new contribution batch from reaching the client, leaving Markdown dormant despite correct activation declarations. Trace the first registration exception before changing the language parser. Product executable fingerprints and catalog resource-package digests serve different contracts; do not assume they identify the same bytes or relax external package checks to make them match.
