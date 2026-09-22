use serde::Serialize;

/// Trust assigned by the host to one piece of review evidence.
///
/// Implementations should mark only direct user instructions and host-owned metadata as trusted.
/// Repository contents, tool output, and Agent-authored text remain untrusted even when they were
/// read through a trusted local adapter.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewEvidenceTrust {
    TrustedUser,
    TrustedHost,
    UntrustedContent,
}

/// Source category for bounded evidence supplied to an action reviewer.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewEvidenceKind {
    UserMessage,
    UserAnswer,
    Delegation,
    AgentMessage,
    Plan,
    PriorToolCall,
    PriorToolResult,
    PreparedAction,
    DirectoryFile,
}

/// One bounded, host-labeled observation relevant to the proposed action.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ReviewEvidence {
    kind: ReviewEvidenceKind,
    trust: ReviewEvidenceTrust,
    source: String,
    content: String,
}

impl ReviewEvidence {
    pub fn new(
        kind: ReviewEvidenceKind,
        trust: ReviewEvidenceTrust,
        source: impl Into<String>,
        content: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            trust,
            source: source.into(),
            content: content.into(),
        }
    }

    pub fn kind(&self) -> ReviewEvidenceKind {
        self.kind
    }

    pub fn trust(&self) -> ReviewEvidenceTrust {
        self.trust
    }

    pub fn source(&self) -> &str {
        &self.source
    }

    pub fn content(&self) -> &str {
        &self.content
    }
}

/// Compact user intent and evidence visible to the action reviewer.
///
/// Hosts should include only the smallest transcript slice needed to relate an action to the
/// user's request. Secrets and credentials must be removed before constructing this value.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
pub struct ReviewContext {
    user_intent: String,
    evidence: Vec<ReviewEvidence>,
    omitted_evidence: usize,
}

impl ReviewContext {
    pub fn new(
        user_intent: impl Into<String>,
        evidence: impl IntoIterator<Item = ReviewEvidence>,
    ) -> Self {
        Self {
            user_intent: user_intent.into(),
            evidence: evidence.into_iter().collect(),
            omitted_evidence: 0,
        }
    }

    pub fn user_intent(&self) -> &str {
        &self.user_intent
    }

    pub fn evidence(&self) -> &[ReviewEvidence] {
        &self.evidence
    }

    /// Records whole evidence entries omitted by request budgeting; user authorization is never
    /// shortened or omitted to make an advisory request fit.
    pub fn with_omitted_evidence(mut self, count: usize) -> Self {
        self.omitted_evidence = count;
        self
    }

    pub fn omitted_evidence(&self) -> usize {
        self.omitted_evidence
    }
}
