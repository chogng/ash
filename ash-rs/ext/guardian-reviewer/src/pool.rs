use crate::AutoReviewError;
use crate::LlmActionClassifier;
use crate::ReviewModel;
use action_policy::ActionClassifier;
use action_policy::ActionReviewRequest;
use async_utils::CancellationReason;
use async_utils::CancellationSource;
use async_utils::CancellationToken;
use protocol::ClassifierAssessment;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::Duration;
use std::time::Instant;

/// Resource limits apply to queued time, retries and model execution together.
#[derive(Clone, Copy)]
pub struct ReviewLimits {
    pub concurrent: usize,
    pub timeout: Duration,
}
impl Default for ReviewLimits {
    fn default() -> Self {
        Self {
            concurrent: 4,
            timeout: Duration::from_secs(90),
        }
    }
}

/// Reuses an isolated reviewer model while bounding concurrent review tasks.
pub struct ReviewerPool<M> {
    model: Arc<M>,
    active: Arc<AtomicUsize>,
    limits: ReviewLimits,
}
impl<M: ReviewModel + 'static> ReviewerPool<M> {
    pub fn new(model: M) -> Self {
        Self {
            model: Arc::new(model),
            active: Arc::new(AtomicUsize::new(0)),
            limits: ReviewLimits::default(),
        }
    }
    pub fn with_limits(model: M, limits: ReviewLimits) -> Result<Self, AutoReviewError> {
        if !(1..=16).contains(&limits.concurrent)
            || limits.timeout.is_zero()
            || limits.timeout > Duration::from_secs(90)
        {
            return Err(AutoReviewError::InvalidRequest(
                "invalid reviewer limits".into(),
            ));
        }
        Ok(Self {
            model: Arc::new(model),
            active: Arc::new(AtomicUsize::new(0)),
            limits,
        })
    }
    /// Starts an asynchronous assessment with cancellation inherited from its caller.
    pub fn submit(
        &self,
        request: ActionReviewRequest,
        cancellation: &CancellationToken,
    ) -> Result<ReviewTask, AutoReviewError> {
        let deadline = Instant::now() + self.limits.timeout;
        loop {
            if cancellation.is_cancelled() {
                return Err(AutoReviewError::Cancelled);
            }
            if Instant::now() >= deadline {
                return Err(AutoReviewError::Model(
                    "review capacity deadline exceeded".into(),
                ));
            }
            if self
                .active
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                    (n < self.limits.concurrent).then_some(n + 1)
                })
                .is_ok()
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let permit = Permit(self.active.clone());
        let source = cancellation.child_source();
        let token = source.token();
        let timer = Deadline::start(source.clone(), deadline)?;
        let model = self.model.clone();
        let (sender, receiver) = mpsc::sync_channel(1);
        let worker = std::thread::Builder::new()
            .name("ash-guardian-review".into())
            .spawn(move || {
                let _permit = permit;
                let classifier = LlmActionClassifier::new(SharedModel(model));
                let mut result = Err(AutoReviewError::Cancelled);
                for attempt in 0..3 {
                    if token.is_cancelled() || Instant::now() >= deadline {
                        break;
                    }
                    result = classifier.classify(&request, &token);
                    if !matches!(result, Err(AutoReviewError::Transient(_))) || attempt == 2 {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                let _ = sender.send(result);
            })
            .map_err(|e| AutoReviewError::Model(e.to_string()))?;
        Ok(ReviewTask {
            receiver,
            worker: Some(worker),
            source,
            deadline,
            _timer: timer,
        })
    }
}
impl<M: ReviewModel + 'static> ActionClassifier for ReviewerPool<M> {
    type Error = AutoReviewError;
    fn classify(
        &self,
        request: &ActionReviewRequest,
        cancellation: &CancellationToken,
    ) -> Result<ClassifierAssessment, Self::Error> {
        self.submit(request.clone(), cancellation)?.wait()
    }
}
struct Permit(Arc<AtomicUsize>);
impl Drop for Permit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}
struct SharedModel<M>(Arc<M>);
impl<M: ReviewModel> ReviewModel for SharedModel<M> {
    fn complete(
        &self,
        request: &crate::ReviewModelRequest,
        token: &CancellationToken,
    ) -> Result<String, crate::ReviewModelError> {
        self.0.complete(request, token)
    }
}

/// Cancels and joins its reviewer when consumed, cancelled, timed out or dropped.
pub struct ReviewTask {
    receiver: mpsc::Receiver<Result<ClassifierAssessment, AutoReviewError>>,
    worker: Option<JoinHandle<()>>,
    source: CancellationSource,
    deadline: Instant,
    _timer: Deadline,
}
impl ReviewTask {
    pub fn wait(self) -> Result<ClassifierAssessment, AutoReviewError> {
        loop {
            if self.source.token().is_cancelled() {
                return Err(AutoReviewError::Cancelled);
            }
            if Instant::now() >= self.deadline {
                self.source
                    .cancel_with(CancellationReason::DeadlineExceeded);
                return Err(AutoReviewError::Model("review deadline exceeded".into()));
            }
            match self.receiver.recv_timeout(Duration::from_millis(5)) {
                Ok(result) => return result,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(AutoReviewError::Model("review worker stopped".into()));
                }
            }
        }
    }
}
impl Drop for ReviewTask {
    fn drop(&mut self) {
        self.source.cancel_with(CancellationReason::Shutdown);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

struct Deadline {
    stop: mpsc::Sender<()>,
    worker: Option<JoinHandle<()>>,
}
impl Deadline {
    fn start(source: CancellationSource, deadline: Instant) -> Result<Self, AutoReviewError> {
        let (stop, receiver) = mpsc::channel();
        let worker = std::thread::Builder::new()
            .name("ash-guardian-deadline".into())
            .spawn(move || {
                if matches!(
                    receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())),
                    Err(mpsc::RecvTimeoutError::Timeout)
                ) {
                    source.cancel_with(CancellationReason::DeadlineExceeded);
                }
            })
            .map_err(|e| AutoReviewError::Model(e.to_string()))?;
        Ok(Self {
            stop,
            worker: Some(worker),
        })
    }
}
impl Drop for Deadline {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[cfg(test)]
#[path = "pool_tests.rs"]
mod tests;
