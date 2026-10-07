use crate::tree::{self, Node, Signal};
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

/// An opaque identity for one cancellation domain.
///
/// Cloned sources and tokens share an identity. Child sources have distinct identities, which
/// lets observers distinguish a local cancellation from one inherited from an ancestor.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct CancellationId(pub(super) u64);

impl fmt::Display for CancellationId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// Common cancellation reasons for callers that do not need an application-specific reason type.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub enum CancellationReason {
    /// A user, owner, or peer explicitly requested cancellation.
    Requested,
    /// The process or owning subsystem is shutting down.
    Shutdown,
    /// The operation exceeded a caller-managed deadline.
    DeadlineExceeded,
}

impl fmt::Display for CancellationReason {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Requested => formatter.write_str("cancellation requested"),
            Self::Shutdown => formatter.write_str("owner is shutting down"),
            Self::DeadlineExceeded => formatter.write_str("deadline exceeded"),
        }
    }
}

/// A cancellation signal and the domain where it originated.
///
/// The reason is reference counted, so observing or propagating cancellation does not require
/// `R: Clone`. Descendants inherit the same signal and therefore preserve the root cause.
pub struct Cancellation<R = CancellationReason> {
    signal: Arc<Signal<R>>,
}

impl<R> Cancellation<R> {
    /// Returns the application-defined reason.
    pub fn reason(&self) -> &R {
        &self.signal.reason
    }

    /// Returns the domain that first emitted this signal.
    pub fn origin(&self) -> CancellationId {
        self.signal.origin
    }

    /// Reports whether this signal originated from `token` rather than an ancestor.
    pub fn originated_from(&self, token: &CancellationToken<R>) -> bool {
        self.origin() == token.id()
    }
}

impl<R> Clone for Cancellation<R> {
    fn clone(&self) -> Self {
        Self {
            signal: self.signal.clone(),
        }
    }
}

impl<R: fmt::Debug> fmt::Debug for Cancellation<R> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Cancellation")
            .field("origin", &self.origin())
            .field("reason", self.reason())
            .finish()
    }
}

impl<R: fmt::Display> fmt::Display for Cancellation<R> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "operation cancelled by domain {}: {}",
            self.origin(),
            self.reason()
        )
    }
}

impl<R: fmt::Debug + fmt::Display> std::error::Error for Cancellation<R> {}

/// The result of attempting to cancel a domain.
///
/// Cancellation is idempotent. `AlreadyCancelled` contains the signal that won the race, which
/// may have originated from an ancestor or a concurrent local caller.
#[derive(Clone, Debug)]
pub enum CancelResult<R = CancellationReason> {
    /// This call installed the domain's cancellation signal.
    Cancelled(Cancellation<R>),
    /// The domain already had a cancellation signal.
    AlreadyCancelled(Cancellation<R>),
}

impl<R> CancelResult<R> {
    /// Returns the effective cancellation signal.
    pub fn cancellation(&self) -> &Cancellation<R> {
        match self {
            Self::Cancelled(cancellation) | Self::AlreadyCancelled(cancellation) => cancellation,
        }
    }
}

/// The authority that can cancel one cancellation domain.
///
/// Clone a source only when both owners should be able to cancel the same domain. Give child
/// agents a source created by [`CancellationToken::child_source`] so their cancellation remains
/// isolated from the parent and siblings.
pub struct CancellationSource<R = CancellationReason> {
    node: Arc<Node<R>>,
}

impl<R> CancellationSource<R> {
    /// Creates an active root cancellation domain with an application-defined reason type.
    ///
    /// Callers using [`CancellationReason`] can use the inference-friendly
    /// [`CancellationSource::new`] constructor instead.
    pub fn new_typed() -> Self {
        Self {
            node: Arc::new(Node::active()),
        }
    }

    /// Returns a read-only observer for this domain.
    pub fn token(&self) -> CancellationToken<R> {
        CancellationToken {
            node: self.node.clone(),
        }
    }

    /// Returns this domain's identity.
    pub fn id(&self) -> CancellationId {
        self.node.id
    }

    /// Cancels this domain and its live descendants with `reason`.
    ///
    /// The first signal observed by each domain wins. Propagation is iterative, so deeply nested
    /// agent trees do not consume the call stack. All affected waiter wakers are invoked after the
    /// reachable tree has been marked cancelled.
    pub fn cancel_with(&self, reason: R) -> CancelResult<R> {
        let signal = Arc::new(Signal {
            origin: self.id(),
            reason,
        });
        let installed = tree::cancel_tree(self.node.clone(), signal.clone());
        let cancellation = Cancellation {
            signal: tree::effective_signal(&self.node, signal),
        };
        if installed {
            CancelResult::Cancelled(cancellation)
        } else {
            CancelResult::AlreadyCancelled(cancellation)
        }
    }

    /// Creates a guard that cancels this domain with `reason` when dropped.
    pub fn cancel_on_drop_with(&self, reason: R) -> CancelOnDrop<R> {
        CancelOnDrop {
            source: Some(self.clone()),
            reason: Some(reason),
        }
    }
}

impl CancellationSource<CancellationReason> {
    /// Creates an active root cancellation domain with the standard reason type.
    pub fn new() -> Self {
        Self::new_typed()
    }

    /// Cancels this domain with [`CancellationReason::Requested`].
    pub fn cancel(&self) -> CancelResult {
        self.cancel_with(CancellationReason::Requested)
    }

    /// Creates a guard that requests cancellation when dropped.
    pub fn cancel_on_drop(&self) -> CancelOnDrop {
        self.cancel_on_drop_with(CancellationReason::Requested)
    }
}

impl<R> Clone for CancellationSource<R> {
    fn clone(&self) -> Self {
        Self {
            node: self.node.clone(),
        }
    }
}

impl<R> Default for CancellationSource<R> {
    fn default() -> Self {
        Self::new_typed()
    }
}

impl<R> fmt::Debug for CancellationSource<R> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CancellationSource")
            .field("id", &self.id())
            .field("is_cancelled", &self.token().is_cancelled())
            .finish()
    }
}

/// A cloneable, read-only observer for one cancellation domain.
///
/// Tokens can create child sources but cannot cancel their own domain. This capability split is
/// intended for structured multi-agent work: a parent keeps its source, while workers receive
/// tokens or isolated child sources.
pub struct CancellationToken<R = CancellationReason> {
    node: Arc<Node<R>>,
}

impl<R> CancellationToken<R> {
    /// Returns this domain's identity.
    pub fn id(&self) -> CancellationId {
        self.node.id
    }

    /// Creates a child cancellation domain.
    ///
    /// Parent cancellation propagates to the child. Cancelling the returned source does not
    /// affect the parent or any sibling. A child created after parent cancellation starts in the
    /// cancelled state with the parent's effective signal.
    pub fn child_source(&self) -> CancellationSource<R> {
        CancellationSource {
            node: Node::child_of(&self.node),
        }
    }

    /// Returns whether this domain has observed cancellation.
    pub fn is_cancelled(&self) -> bool {
        tree::is_cancelled(&self.node)
    }

    /// Returns the effective signal when cancelled.
    pub fn cancellation(&self) -> Option<Cancellation<R>> {
        tree::signal(&self.node).map(|signal| Cancellation { signal })
    }

    /// Provides a synchronous cancellation checkpoint.
    pub fn check(&self) -> Result<(), Cancellation<R>> {
        match self.cancellation() {
            Some(cancellation) => Err(cancellation),
            None => Ok(()),
        }
    }

    /// Returns a future that completes with the effective cancellation signal.
    pub fn cancelled(&self) -> Cancelled<R> {
        Cancelled {
            token: self.clone(),
            waiter_id: None,
        }
    }

    pub(crate) fn poll_cancelled(
        &self,
        context: &mut Context<'_>,
        waiter_id: &mut Option<u64>,
    ) -> Poll<Cancellation<R>> {
        match tree::poll_cancelled(&self.node, context, waiter_id) {
            Poll::Ready(signal) => Poll::Ready(Cancellation { signal }),
            Poll::Pending => Poll::Pending,
        }
    }

    pub(crate) fn remove_waiter(&self, waiter_id: &mut Option<u64>) {
        tree::remove_waiter(&self.node, waiter_id);
    }

    #[cfg(test)]
    pub(crate) fn waiter_count(&self) -> usize {
        tree::waiter_count(&self.node)
    }
}

impl<R> Clone for CancellationToken<R> {
    fn clone(&self) -> Self {
        Self {
            node: self.node.clone(),
        }
    }
}

impl<R> fmt::Debug for CancellationToken<R> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CancellationToken")
            .field("id", &self.id())
            .field("is_cancelled", &self.is_cancelled())
            .finish()
    }
}

/// A future that resolves when its token's domain is cancelled.
#[must_use = "futures do nothing unless polled or awaited"]
pub struct Cancelled<R = CancellationReason> {
    token: CancellationToken<R>,
    waiter_id: Option<u64>,
}

impl<R> Future for Cancelled<R> {
    type Output = Cancellation<R>;

    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.as_mut().get_mut();
        this.token.poll_cancelled(context, &mut this.waiter_id)
    }
}

impl<R> Drop for Cancelled<R> {
    fn drop(&mut self) {
        self.token.remove_waiter(&mut self.waiter_id);
    }
}

/// An RAII guard that requests cancellation when dropped.
///
/// Use this for owners whose early return, panic, or task teardown must cancel subordinate work.
/// Dropping a plain [`CancellationSource`] does not cancel its domain.
#[must_use = "dropping the guard immediately requests cancellation"]
pub struct CancelOnDrop<R = CancellationReason> {
    source: Option<CancellationSource<R>>,
    reason: Option<R>,
}

impl<R> CancelOnDrop<R> {
    /// Consumes the guard without cancelling its domain.
    pub fn disarm(mut self) {
        self.source = None;
        self.reason = None;
    }
}

impl<R> Drop for CancelOnDrop<R> {
    fn drop(&mut self) {
        if let (Some(source), Some(reason)) = (self.source.take(), self.reason.take()) {
            source.cancel_with(reason);
        }
    }
}

impl<R> fmt::Debug for CancelOnDrop<R> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CancelOnDrop")
            .field("armed", &self.source.is_some())
            .finish()
    }
}

#[cfg(test)]
#[path = "source_tests.rs"]
mod tests;
