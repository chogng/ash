use serde::Deserialize;
use serde::Serialize;

/// Stable action category exposed to deterministic execution-policy selectors.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ExecPolicyActionKind {
    LocalProcess,
    FileSystemMutation,
    NetworkRequest,
    BrowserInteraction,
    ExternalServiceMutation,
    CredentialUse,
    SystemOperation,
}

/// One policy-facing capability claim materialized by the action authority.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ExecPolicyCapability {
    kind: String,
    scope: String,
}

impl ExecPolicyCapability {
    pub fn new(kind: impl Into<String>, scope: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            scope: scope.into(),
        }
    }

    pub fn kind(&self) -> &str {
        &self.kind
    }

    pub fn scope(&self) -> &str {
        &self.scope
    }
}

/// An already-tokenized process invocation, equivalent to the values supplied to `execvp`.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ExecPolicyCommand {
    program: String,
    arguments: Vec<String>,
}

impl ExecPolicyCommand {
    pub fn new(program: impl Into<String>, arguments: impl IntoIterator<Item = String>) -> Self {
        Self {
            program: program.into(),
            arguments: arguments.into_iter().collect(),
        }
    }

    pub fn program(&self) -> &str {
        &self.program
    }

    pub fn arguments(&self) -> &[String] {
        &self.arguments
    }

    pub(crate) fn token(&self, index: usize) -> Option<&str> {
        if index == 0 {
            Some(&self.program)
        } else {
            self.arguments.get(index - 1).map(String::as_str)
        }
    }
}

/// A normalized network destination exposed to deterministic policy matching.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ExecPolicyNetworkTarget {
    protocol: String,
    host: String,
    port: Option<u16>,
}

impl ExecPolicyNetworkTarget {
    pub fn new(protocol: impl Into<String>, host: impl Into<String>, port: Option<u16>) -> Self {
        Self {
            protocol: protocol.into().to_ascii_lowercase(),
            host: host.into().trim_end_matches('.').to_ascii_lowercase(),
            port,
        }
    }

    pub fn protocol(&self) -> &str {
        &self.protocol
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    pub fn port(&self) -> Option<u16> {
        self.port
    }
}

/// Immutable policy projection of one fully materialized action.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecPolicySubject<'a> {
    action_digest: &'a str,
    action_kind: ExecPolicyActionKind,
    source: &'a str,
    source_id: &'a str,
    capabilities: Vec<ExecPolicyCapability>,
    command: Option<&'a ExecPolicyCommand>,
    network_target: Option<&'a ExecPolicyNetworkTarget>,
}

impl<'a> ExecPolicySubject<'a> {
    /// Creates the complete immutable input used by every rule layer.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        action_digest: &'a str,
        action_kind: ExecPolicyActionKind,
        source: &'a str,
        source_id: &'a str,
        capabilities: impl IntoIterator<Item = ExecPolicyCapability>,
        command: Option<&'a ExecPolicyCommand>,
        network_target: Option<&'a ExecPolicyNetworkTarget>,
    ) -> Self {
        Self {
            action_digest,
            action_kind,
            source,
            source_id,
            capabilities: capabilities.into_iter().collect(),
            command,
            network_target,
        }
    }

    pub fn action_digest(&self) -> &str {
        self.action_digest
    }

    pub fn action_kind(&self) -> ExecPolicyActionKind {
        self.action_kind
    }

    pub fn source(&self) -> &str {
        self.source
    }

    pub fn source_id(&self) -> &str {
        self.source_id
    }

    pub fn capabilities(&self) -> &[ExecPolicyCapability] {
        &self.capabilities
    }

    pub fn command(&self) -> Option<&ExecPolicyCommand> {
        self.command
    }

    pub fn network_target(&self) -> Option<&ExecPolicyNetworkTarget> {
        self.network_target
    }
}
