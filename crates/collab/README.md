# ash-collab

`ash-collab` owns the backend-neutral authority for ordered Document Engine
structured-document rooms and persistent human collaboration spaces. It does not own
HTTP listeners, App Server JSON-RPC, Workbench state, Agent sessions, or document-schema semantics.

`ChannelStore` owns the SQLite channel tree and space-scoped human membership.
Owners manage members and channels, editors manage channels, and viewers read.
Subchannels inherit space membership. Every write checks role and revision in
one immediate transaction; deleting a channel removes its descendants. The last
owner cannot be removed or demoted. Reads recheck the credential digest, including
after another host revokes a member. Space/member snapshots never contain tokens.

Channel resources bind a stable notes room and call to each channel. Scoped grants
are derived from the member credential and resource identity; only their hashes
are stored. Notes authorization reads current channel membership in the room's
transaction, rather than copying an independent document ACL. Owners/editors can
submit and viewers can read; even a space owner cannot issue standalone document
invitations for channel notes. Deleted channel bindings remain inaccessible so an
old grant cannot recreate a resource. `ash-call` consumes the same membership
queries for its transaction and media permission reconciliation.

`ChannelClient` implements the outbound channel protocol. `ChannelAccount` saves
one current account in the configured `SecretStore`, shared by local windows;
it does not persist a second channel catalog. Credentials are restored on restart,
explicitly exportable as a private sign-in key, and forgotten on disconnect.
Normal reads are bounded requests; the UI owns polling while a panel or channel
notes editor is active. Connection
loss does not replay mutations. Creating a space saves its generated owner key
before the request so an uncertain response can be reconciled by a later read.

Shared room data and roles are defined in
[`ash-collab-contract`](../collab-contract/src/lib.rs).
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

`just test ash-collab` covers room creation, envelope rejection,
ordered replay, exact retries, SQLite recovery, memberships, credential
rotation/revocation, audit order, and presence replay. App Server adapter
coverage is in `crates/app-server/src/server_tests.rs`.
