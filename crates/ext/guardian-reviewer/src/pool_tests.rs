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

struct RateLimitedModel {
    calls: Arc<Mutex<Vec<Instant>>>,
    retry_at: Option<Instant>,
}

impl ReviewModel for RateLimitedModel {
    fn complete(
        &self,
        _: &ReviewModelRequest,
        _: &CancellationToken,
    ) -> Result<String, ReviewModelError> {
        let mut calls = self.calls.lock().unwrap();
        calls.push(Instant::now());
        if calls.len() == 1 {
            Err(ReviewModelError::RateLimited {
                retry_at: self.retry_at,
            })
        } else {
            Ok(r#"{"recommendation":"deny","reason":"test denial"}"#.into())
        }
    }
}

#[test]
fn rate_limit_guidance_holds_back_other_reviews_of_the_same_model() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let retry_at = Instant::now() + Duration::from_millis(100);
    let pool = ReviewerPool::new(RateLimitedModel {
        calls: calls.clone(),
        retry_at: Some(retry_at),
    });
    let source = CancellationSource::new();
    let first = pool.submit(request(), &source.token()).unwrap();
    // Wait for the known rate limit, rather than guessing when the first provider call finishes.
    while *pool.cooldown.lock().unwrap() != Some(retry_at) {
        assert!(
            Instant::now() < retry_at,
            "review did not publish its cooldown"
        );
        std::thread::yield_now();
    }
    let second = pool.submit(request(), &source.token()).unwrap();
    assert!(first.wait().is_ok());
    assert!(second.wait().is_ok());
    let calls = calls.lock().unwrap();
    assert_eq!(
        calls.len(),
        3,
        "independent assessments are not cached or deduplicated"
    );
    assert!(calls[1..].iter().all(|started| *started >= retry_at));
    assert_eq!(pool.active.load(Ordering::SeqCst), 0);
}

#[test]
fn absent_rate_limit_guidance_respects_the_review_deadline_and_expired_guidance_retries() {
    for retry_at in [None, Some(Instant::now())] {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let pool = ReviewerPool::with_limits(
            RateLimitedModel {
                calls: calls.clone(),
                retry_at,
            },
            ReviewLimits {
                concurrent: 1,
                timeout: Duration::from_millis(100),
            },
        )
        .unwrap();
        let source = CancellationSource::new();
        let result = pool.submit(request(), &source.token()).unwrap().wait();
        assert_eq!(result.is_ok(), retry_at.is_some());
        assert_eq!(
            calls.lock().unwrap().len(),
            if retry_at.is_some() { 2 } else { 1 }
        );
        assert_eq!(pool.active.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn production_review_metrics_count_one_decision_after_retries_and_no_denial_error() {
    let metrics = diagnostics::Metrics::default();
    let calls = Arc::new(AtomicUsize::new(0));
    let pool = ReviewerPool::new(TransientModel(calls.clone())).with_metrics(
        metrics.clone(),
        vec![("guardian_model", "review model".into())],
    );
    pool.submit(request(), &CancellationSource::new().token())
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    let snapshot = metrics.snapshot();
    let result = snapshot
        .iter()
        .find(|s| s.name == "ash.guardian.review")
        .unwrap();
    assert_eq!(result.count, 1);
    assert_eq!(result.tags["status"], "denied");
    assert_eq!(result.tags["guardian_model"], "review_model");
    assert!(
        !snapshot
            .iter()
            .any(|s| s.name == "ash.guardian.review.error")
    );
}

#[test]
fn production_review_metrics_distinguish_deadlines_from_dropped_tasks() {
    let metrics = diagnostics::Metrics::default();
    let pool = ReviewerPool::with_limits(
        WaitingModel(Arc::new(AtomicUsize::new(0))),
        ReviewLimits {
            concurrent: 1,
            timeout: Duration::from_millis(30),
        },
    )
    .unwrap()
    .with_metrics(metrics.clone(), vec![]);
    let source = CancellationSource::new();
    assert!(matches!(
        pool.submit(request(), &source.token()).unwrap().wait(),
        Err(AutoReviewError::TimedOut)
    ));
    drop(pool.submit(request(), &source.token()).unwrap());
    let snapshot = metrics.snapshot();
    assert_eq!(
        snapshot
            .iter()
            .filter(|s| s.name == "ash.guardian.review")
            .map(|s| s.count)
            .sum::<u64>(),
        2
    );
    for error in ["timeout", "dropped"] {
        assert!(
            snapshot
                .iter()
                .any(|s| s.name == "ash.guardian.review.error" && s.tags["error_type"] == error)
        );
    }
}

#[test]
fn completed_async_review_is_measured_before_the_consumer_waits() {
    let metrics = diagnostics::Metrics::default();
    let pool = ReviewerPool::new(TransientModel(Arc::new(AtomicUsize::new(0))))
        .with_metrics(metrics.clone(), vec![]);
    let task = pool
        .submit(request(), &CancellationSource::new().token())
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    while !metrics
        .snapshot()
        .iter()
        .any(|s| s.name == "ash.guardian.review")
    {
        assert!(
            Instant::now() < deadline,
            "review was not measured on completion"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    drop(task);
    let snapshot = metrics.snapshot();
    assert_eq!(
        snapshot
            .iter()
            .filter(|s| s.name == "ash.guardian.review")
            .map(|s| s.count)
            .sum::<u64>(),
        1
    );
    assert!(
        !snapshot
            .iter()
            .any(|s| s.name == "ash.guardian.review.error")
    );
}
