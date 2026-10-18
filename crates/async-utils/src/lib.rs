//! Runtime-independent cooperative cancellation for asynchronous work.
//!
//! A [`CancellationSource`] owns permission to request cancellation, while a
//! [`CancellationToken`] lets code observe cancellation and create isolated child
//! cancellation domains. Use [`FutureCancellationExt::with_cancellation`] when it is safe to
//! drop a future as soon as cancellation wins. Futures that require graceful cleanup should
//! instead await [`CancellationToken::cancelled`] or call [`CancellationToken::check`].

mod future;
mod source;
mod tree;
#[cfg(feature = "wait")]
mod wait;

/// Drives a future on the current thread with an executor-owned wake signal.
/// Unlike a thread park token, that signal survives synchronous operations inside a poll.
#[cfg(feature = "wait")]
pub use async_io::block_on;

#[cfg(feature = "wait")]
pub use wait::Notify;
#[cfg(feature = "wait")]
pub use wait::WaitOutcome;
#[cfg(feature = "wait")]
pub use wait::wait_until;

pub use future::{Cancelable, FutureCancellationExt};
pub use source::{
    CancelOnDrop, CancelResult, Cancellation, CancellationId, CancellationReason,
    CancellationSource, CancellationToken, Cancelled,
};
