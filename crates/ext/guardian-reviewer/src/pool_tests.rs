use super::*;
use crate::ReviewModelError;
use crate::ReviewModelRequest;
use action_policy::ResolvedAction;
use action_policy::SandboxCompatibility;
use protocol::ActionDigest;
use protocol::ActionKind;
use protocol::ActionPolicyRevision;
use protocol::ActionProvenance;
use protocol::ActionSource;
use protocol::CapabilitySet;
use std::sync::atomic::AtomicUsize;
fn request() -> ActionReviewRequest {
    ActionReviewRequest::new(
        ResolvedAction::new(
            ActionDigest::from_canonical_bytes(b"review"),
            ActionKind::SystemOperation,
            "test",
            CapabilitySet::new([]),
        ),
        ActionProvenance::new(ActionSource::BuiltInTool, "test"),
        SandboxCompatibility::NotApplicable {
            reason: "test".into(),
        },
        ActionPolicyRevision::new("policy"),
    )
}
struct TransientModel(Arc<AtomicUsize>);
impl ReviewModel for TransientModel {
    fn complete(
        &self,
        _: &ReviewModelRequest,
        _: &CancellationToken,
    ) -> Result<String, ReviewModelError> {
        if self.0.fetch_add(1, Ordering::SeqCst) == 0 {
            Err(ReviewModelError::Transient("retry".into()))
        } else {
            Ok(r#"{"recommendation":"deny","reason":"test denial"}"#.into())
        }
    }
}
struct WaitingModel(Arc<AtomicUsize>);
impl ReviewModel for WaitingModel {
    fn complete(
        &self,
        _: &ReviewModelRequest,
        token: &CancellationToken,
    ) -> Result<String, ReviewModelError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        while !token.is_cancelled() {
            std::thread::sleep(Duration::from_millis(1));
        }
        self.0.fetch_sub(1, Ordering::SeqCst);
        Err(ReviewModelError::Invocation("cancelled".into()))
    }
}
#[test]
fn asynchronous_reviews_retry_only_transient_failures_and_keep_request_identity() {
    let calls = Arc::new(AtomicUsize::new(0));
    let pool = ReviewerPool::new(TransientModel(calls.clone()));
    let cancellation = CancellationSource::new();
    let request = request();
    let assessment = pool
        .submit(request.clone(), &cancellation.token())
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(assessment.action_digest(), request.action().digest());
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}
#[test]
fn review_deadline_cancels_the_provider_and_releases_capacity_without_waiting_for_a_consumer() {
    let running = Arc::new(AtomicUsize::new(0));
    let pool = ReviewerPool::with_limits(
        WaitingModel(running.clone()),
        ReviewLimits {
            concurrent: 1,
            timeout: Duration::from_millis(30),
        },
    )
    .unwrap();
    let source = CancellationSource::new();
    let task = pool.submit(request(), &source.token()).unwrap();
    std::thread::sleep(Duration::from_millis(60));
    assert!(task.wait().is_err());
    assert_eq!(running.load(Ordering::SeqCst), 0);
    assert_eq!(pool.active.load(Ordering::SeqCst), 0);
    let task = pool.submit(request(), &source.token()).unwrap();
    drop(task);
    assert_eq!(pool.active.load(Ordering::SeqCst), 0);
}
