# ash-collaboration

`ash-collaboration` owns the backend-neutral authority for ordered Document Engine
structured-document rooms. It does not own HTTP, App Server JSON-RPC,
Workbench state, sessions, users, or document-schema semantics.

Shared room data and roles are defined in
[`ash-collaboration-contract`](../collaboration-contract/src/lib.rs).
The protocol depends directly on that contract; this crate uses and re-exports
the same types while owning room authority and storage.

`InMemoryDocumentCollaborationRooms` is composed by the App Server for clients
in one process. `SqliteDocumentCollaborationRooms` is composed by the remote
host and persists room snapshots and ordered submissions across restarts. Both
implement the same `open`, `submit`, `replay`, and ephemeral presence operations.
SQLite additionally owns remote-only room members, scoped credentials, audit
events, and cross-process presence leases.

## Contract

- `open` creates an unpredictable `document-` room ID or joins an existing room
  only when its schema compatibility ID matches.
- `submit` validates bounded JSON-object envelopes, assigns a monotonic
  JavaScript-safe version, and returns `Accepted`, bounded rebase history, or
  a canonical resync snapshot.
- A repeated `(roomId, clientId, sequence)` is accepted only when its base
  version, transaction, and resulting document are identical. The original
  accepted update is returned; a changed reuse is rejected.
- `replay` returns at most the newest 512 ordered updates. A client older than
  that window receives the current snapshot instead.
- `open_as`, `submit_as`, and `replay_as` require an active room member;
  owners may list active members, create/revoke/rotate scoped member
  credentials, and list audit events. Owners cannot revoke their own active
  credential. Editors and owners submit; viewers only read and publish
  presence.
- `update_presence_as` / `replay_presence_as` are intentionally separate from
  document history. Presence selections are bounded, structurally validated,
  and expire after 60 seconds unless the client refreshes them.

SQLite keeps submitted-operation rows after they leave the 512-update replay
window so an old sequence can never be reused. Retention/compaction therefore
needs an explicit future protocol for expiring client identities; deleting
those rows without such a contract would break idempotency.

The crate validates the versioned JSON envelope, bounded generic node/mark/
selection structure, and the known core Document Engine transaction kinds, not each
profile's full document schema.
`RemoteDocumentCollaborationService` decodes every server value through the
active Document Engine schema before it can reach a `DocumentModel`. A Rust schema
authority belongs here only once the schema is independently represented in
the backend rather than copied from the browser.

## Tests

`cargo test -p ash-collaboration` covers room creation, envelope rejection,
ordered replay, exact retries, SQLite recovery, memberships, credential
rotation/revocation, audit order, and presence replay. App Server adapter
coverage is in `ash-rs/app-server/src/server_tests.rs`.
