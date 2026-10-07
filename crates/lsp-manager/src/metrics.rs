use crate::LanguageRequestKind;

/// Terminal outcome of one asynchronous Language Server request.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LanguageRequestMetricOutcome {
    Delivered,
    Empty,
    Failed,
    Cancelled,
    StaleDiscarded,
    Rejected,
}

/// Content-free measurement for deciding whether a revision-bound navigation cache is justified.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageRequestMetric {
    pub kind: LanguageRequestKind,
    pub server: Option<String>,
    pub server_incarnation: Option<u64>,
    pub configuration_generation: u64,
    pub service_generation: u64,
    pub cold_for_incarnation: bool,
    pub elapsed_millis: u64,
    pub result_count: usize,
    pub outcome: LanguageRequestMetricOutcome,
}

/// Receives bounded operational measurements without source paths, positions, queries, or text.
pub trait LspRequestMetricsSink: Send + Sync + 'static {
    fn record(&self, metric: LanguageRequestMetric);
}
