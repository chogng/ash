use crate::ExecPolicyActionKind;
use crate::ExecPolicySubject;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeSet;

/// Stable identity of one configuration layer participating in policy evaluation.
#[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(transparent)]
pub struct ExecPolicyLayerId(String);

impl ExecPolicyLayerId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Stable identity of one deterministic rule.
#[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(transparent)]
pub struct ExecPolicyRuleId(String);

impl ExecPolicyRuleId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Source and precedence category of one policy layer.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ExecPolicyLayerKind {
    Host,
    Organization,
    User,
    Directory,
}

/// One argument position in a command-prefix selector.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum ExecPolicyToken {
    Literal(String),
    OneOf(BTreeSet<String>),
}

impl ExecPolicyToken {
    pub fn literal(value: impl Into<String>) -> Self {
        Self::Literal(value.into())
    }

    pub fn one_of(values: impl IntoIterator<Item = String>) -> Self {
        Self::OneOf(values.into_iter().collect())
    }

    fn matches(&self, actual: &str) -> bool {
        match self {
            Self::Literal(expected) => expected == actual,
            Self::OneOf(expected) => expected.contains(actual),
        }
    }

    pub(crate) fn is_valid(&self) -> bool {
        match self {
            Self::Literal(value) => !value.is_empty(),
            Self::OneOf(values) => {
                !values.is_empty() && values.iter().all(|value| !value.is_empty())
            }
        }
    }
}

/// Explicit network host matching semantics.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum HostMatcher {
    Exact(String),
    DomainSuffix(String),
}

impl HostMatcher {
    pub fn exact(value: impl Into<String>) -> Self {
        Self::Exact(normalize_host(value.into()))
    }

    pub fn domain_suffix(value: impl Into<String>) -> Self {
        Self::DomainSuffix(normalize_host(value.into()))
    }

    fn matches(&self, actual: &str) -> bool {
        let actual = normalize_host(actual.to_owned());
        match self {
            Self::Exact(expected) => &actual == expected,
            Self::DomainSuffix(suffix) => {
                actual == *suffix
                    || actual
                        .strip_suffix(suffix)
                        .is_some_and(|prefix| prefix.ends_with('.'))
            }
        }
    }

    pub(crate) fn is_valid(&self) -> bool {
        match self {
            Self::Exact(value) | Self::DomainSuffix(value) => !value.is_empty(),
        }
    }

    fn canonicalize(&mut self) {
        match self {
            Self::Exact(value) | Self::DomainSuffix(value) => {
                *value = normalize_host(std::mem::take(value));
            }
        }
    }
}

fn normalize_host(value: String) -> String {
    value.trim_end_matches('.').to_ascii_lowercase()
}

/// Explicit capability-scope matching semantics.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum ScopeMatcher {
    Exact(String),
    Prefix(String),
}

impl ScopeMatcher {
    pub fn exact(value: impl Into<String>) -> Self {
        Self::Exact(value.into())
    }

    pub fn prefix(value: impl Into<String>) -> Self {
        Self::Prefix(value.into())
    }

    fn matches(&self, actual: &str) -> bool {
        match self {
            Self::Exact(expected) => expected == actual,
            Self::Prefix(prefix) => actual.starts_with(prefix),
        }
    }

    pub(crate) fn is_valid(&self) -> bool {
        match self {
            Self::Exact(value) | Self::Prefix(value) => !value.is_empty(),
        }
    }
}

/// A deterministic selector over trusted, host-materialized action fields.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExecPolicySelector {
    Any,
    ActionDigest {
        digest: String,
    },
    ActionKind {
        action_kind: ExecPolicyActionKind,
    },
    Source {
        source: Option<String>,
        source_id: Option<String>,
    },
    CommandPrefix {
        pattern: Vec<ExecPolicyToken>,
    },
    Network {
        protocol: Option<String>,
        host: HostMatcher,
        port: Option<u16>,
    },
    Capability {
        capability_kind: String,
        scope: ScopeMatcher,
    },
    All {
        selectors: Vec<ExecPolicySelector>,
    },
}

impl ExecPolicySelector {
    /// Reports whether a selector explicitly governs observed network requests.
    pub fn targets_network(&self) -> bool {
        match self {
            Self::Network { .. }
            | Self::ActionKind {
                action_kind: ExecPolicyActionKind::NetworkRequest,
            } => true,
            Self::Capability {
                capability_kind, ..
            } => capability_kind == "network",
            Self::All { selectors } => selectors.iter().any(Self::targets_network),
            _ => false,
        }
    }

    pub fn source(source: Option<String>, source_id: Option<String>) -> Self {
        Self::Source { source, source_id }
    }

    pub fn command_prefix(pattern: impl IntoIterator<Item = ExecPolicyToken>) -> Self {
        Self::CommandPrefix {
            pattern: pattern.into_iter().collect(),
        }
    }

    pub fn all(selectors: impl IntoIterator<Item = Self>) -> Self {
        Self::All {
            selectors: selectors.into_iter().collect(),
        }
    }

    pub(crate) fn matches(&self, subject: &ExecPolicySubject<'_>) -> bool {
        match self {
            Self::Any => true,
            Self::ActionDigest { digest } => digest == subject.action_digest(),
            Self::ActionKind { action_kind } => *action_kind == subject.action_kind(),
            Self::Source { source, source_id } => {
                source
                    .as_deref()
                    .is_none_or(|value| value == subject.source())
                    && source_id
                        .as_deref()
                        .is_none_or(|value| value == subject.source_id())
            }
            Self::CommandPrefix { pattern } => subject.command().is_some_and(|command| {
                pattern.iter().enumerate().all(|(index, expected)| {
                    command
                        .token(index)
                        .is_some_and(|actual| expected.matches(actual))
                })
            }),
            Self::Network {
                protocol,
                host,
                port,
            } => subject.network_target().is_some_and(|target| {
                protocol
                    .as_deref()
                    .is_none_or(|value| value.eq_ignore_ascii_case(target.protocol()))
                    && host.matches(target.host())
                    && port.is_none_or(|value| Some(value) == target.port())
            }),
            Self::Capability {
                capability_kind,
                scope,
            } => subject.capabilities().iter().any(|capability| {
                capability.kind() == capability_kind && scope.matches(capability.scope())
            }),
            Self::All { selectors } => selectors.iter().all(|selector| selector.matches(subject)),
        }
    }

    pub(crate) fn is_valid(&self) -> bool {
        match self {
            Self::Any | Self::ActionKind { .. } => true,
            Self::ActionDigest { digest } => !digest.is_empty(),
            Self::Source { source, source_id } => {
                (source.is_some() || source_id.is_some())
                    && source.as_ref().is_none_or(|value| !value.is_empty())
                    && source_id.as_ref().is_none_or(|value| !value.is_empty())
            }
            Self::CommandPrefix { pattern } => {
                !pattern.is_empty() && pattern.iter().all(ExecPolicyToken::is_valid)
            }
            Self::Network { protocol, host, .. } => {
                protocol.as_ref().is_none_or(|value| !value.is_empty()) && host.is_valid()
            }
            Self::Capability {
                capability_kind,
                scope,
            } => !capability_kind.is_empty() && scope.is_valid(),
            Self::All { selectors } => {
                !selectors.is_empty() && selectors.iter().all(Self::is_valid)
            }
        }
    }

    fn canonicalize(&mut self) {
        match self {
            Self::Network { protocol, host, .. } => {
                if let Some(protocol) = protocol {
                    protocol.make_ascii_lowercase();
                }
                host.canonicalize();
            }
            Self::All { selectors } => {
                for selector in selectors {
                    selector.canonicalize();
                }
            }
            Self::Any
            | Self::ActionDigest { .. }
            | Self::ActionKind { .. }
            | Self::Source { .. }
            | Self::CommandPrefix { .. }
            | Self::Capability { .. } => {}
        }
    }
}

/// Policy effect returned when a rule matches.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(tag = "kind", content = "reason", rename_all = "snake_case")]
pub enum ExecPolicyEffect {
    Continue,
    AllowUnsandboxed,
    RequireApproval,
    RequireSandbox,
    Deny(String),
}

impl ExecPolicyEffect {
    pub(crate) fn precedence(&self) -> u8 {
        match self {
            Self::Continue => 0,
            Self::AllowUnsandboxed => 1,
            Self::RequireApproval => 2,
            Self::RequireSandbox => 3,
            Self::Deny(_) => 4,
        }
    }

    pub(crate) fn is_valid(&self) -> bool {
        !matches!(self, Self::Deny(reason) if reason.trim().is_empty())
    }
}

/// Fail-closed behavior when no rule matches a subject.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(tag = "kind", content = "reason", rename_all = "snake_case")]
pub enum ExecPolicyDefault {
    Continue,
    Deny(String),
}

impl ExecPolicyDefault {
    pub(crate) fn is_valid(&self) -> bool {
        !matches!(self, Self::Deny(reason) if reason.trim().is_empty())
    }
}

/// One validated rule in an immutable execution-policy layer.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ExecPolicyRule {
    id: ExecPolicyRuleId,
    selector: ExecPolicySelector,
    effect: ExecPolicyEffect,
    justification: Option<String>,
}

impl ExecPolicyRule {
    pub fn new(
        id: ExecPolicyRuleId,
        selector: ExecPolicySelector,
        effect: ExecPolicyEffect,
    ) -> Self {
        Self {
            id,
            selector,
            effect,
            justification: None,
        }
    }

    pub fn with_justification(mut self, justification: impl Into<String>) -> Self {
        self.justification = Some(justification.into());
        self
    }

    pub fn id(&self) -> &ExecPolicyRuleId {
        &self.id
    }

    pub fn selector(&self) -> &ExecPolicySelector {
        &self.selector
    }

    pub fn effect(&self) -> &ExecPolicyEffect {
        &self.effect
    }

    pub fn justification(&self) -> Option<&str> {
        self.justification.as_deref()
    }

    pub(crate) fn is_valid(&self) -> bool {
        !self.id.as_str().is_empty()
            && self.selector.is_valid()
            && self.effect.is_valid()
            && self
                .justification
                .as_ref()
                .is_none_or(|value| !value.trim().is_empty())
    }

    fn canonicalize(&mut self) {
        self.selector.canonicalize();
    }
}

/// One ordered policy layer supplied by a trusted configuration adapter.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ExecPolicyLayer {
    id: ExecPolicyLayerId,
    kind: ExecPolicyLayerKind,
    rules: Vec<ExecPolicyRule>,
}

impl ExecPolicyLayer {
    pub fn new(
        id: ExecPolicyLayerId,
        kind: ExecPolicyLayerKind,
        rules: impl IntoIterator<Item = ExecPolicyRule>,
    ) -> Self {
        Self {
            id,
            kind,
            rules: rules.into_iter().collect(),
        }
    }

    pub fn id(&self) -> &ExecPolicyLayerId {
        &self.id
    }

    pub fn kind(&self) -> ExecPolicyLayerKind {
        self.kind
    }

    pub fn rules(&self) -> &[ExecPolicyRule] {
        &self.rules
    }

    pub(crate) fn rules_mut(&mut self) -> &mut Vec<ExecPolicyRule> {
        &mut self.rules
    }

    pub(crate) fn canonicalize(&mut self) {
        for rule in &mut self.rules {
            rule.canonicalize();
        }
    }
}
