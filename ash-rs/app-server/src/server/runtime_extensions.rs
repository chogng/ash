use ash_extension_api::ThreadContext;
use ash_extension_api::ThreadLifecycle;
use std::sync::Arc;

pub(super) struct ExecutionActivity {
    inhibitor: sleep_inhibitor::SleepInhibitor,
    unavailable: std::sync::atomic::AtomicBool,
}

impl ExecutionActivity {
    pub(super) fn shared() -> Arc<Self> {
        static ACTIVITY: std::sync::OnceLock<Arc<ExecutionActivity>> = std::sync::OnceLock::new();
        Arc::clone(ACTIVITY.get_or_init(|| {
            Arc::new(Self {
                inhibitor: sleep_inhibitor::SleepInhibitor::new("Ash is executing an agent task"),
                unavailable: std::sync::atomic::AtomicBool::new(false),
            })
        }))
    }
}

impl core_api::TurnExecutionActivity for ExecutionActivity {
    fn enter(&self) -> Option<Box<dyn Send>> {
        use std::sync::atomic::Ordering;
        match self.inhibitor.acquire() {
            Ok(lease) => {
                self.unavailable.store(false, Ordering::Relaxed);
                Some(Box::new(lease))
            }
            Err(error) => {
                if !self.unavailable.swap(true, Ordering::Relaxed) {
                    log::warn!("Cannot prevent idle sleep during agent execution: {error}");
                }
                None
            }
        }
    }
}

pub(super) struct UsageObserver {
    pub analytics: Arc<analytics::Analytics>,
    pub config: Arc<ash_config::ConfigStore>,
}
impl ash_extension_api::LifecycleObserver for UsageObserver {
    fn thread_changed(&self, _: ThreadContext<'_>, event: &ThreadLifecycle) {
        if matches!(event, ThreadLifecycle::TurnStarted(_)) {
            self.analytics.record(analytics::UsageEvent::TurnStarted);
        }
    }
    fn config_changed(&self, _: u64) {
        match self.config.read_snapshot() {
            Ok(snapshot) => self
                .analytics
                .set_enabled(features::Feature::Analytics.enabled(&snapshot.values.features)),
            Err(error) => log::error!("cannot apply analytics preference: {error}"),
        }
    }
}
