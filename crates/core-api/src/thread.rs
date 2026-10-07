use crate::CoreError;
use ash_protocol::ThreadUpdateEnvelope;

/// Holds a process-local or inter-process write lock for a Thread.
///
/// Implementations release their underlying lease when the guard is dropped and must never let
/// two live guards represent concurrent writers for the same Thread.
pub trait LeaseGuard: Send {}

/// Arbitrates exclusive write access to one durable aggregate identity.
///
/// Implementations must scope leases by both the concrete ID type and value, reject competing
/// writers, and return a guard that holds the lease for the complete mutation.
pub trait WriterLease<Id>: Send + Sync {
    fn acquire(&self, id: &Id) -> Result<Box<dyn LeaseGuard>, CoreError>;
}

/// Publishes a Core-produced Thread update to an outer subscription transport.
///
/// Implementations must treat transient updates as best-effort and must not block durable Core
/// commits on a slow client connection. Durable updates can always be replayed from the store.
pub trait ThreadUpdateSink: Send + Sync {
    fn publish(&self, update: ThreadUpdateEnvelope);
}
