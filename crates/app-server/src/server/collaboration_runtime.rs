/// Process-local collaboration authority used by the App Server JSON-RPC adapter.
///
/// The shared collaboration crate owns room validation, ordering, replay and
/// idempotency semantics so the local App Server and a durable remote host
/// cannot drift apart.
pub(crate) use ash_collaboration::InMemoryDocumentCollaborationRooms as DocumentCollaborationStore;
