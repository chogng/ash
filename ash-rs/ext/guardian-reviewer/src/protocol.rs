use action_policy::{
    ActionPolicyRevision, ActionProvenance, ActionReviewPhase, ActionReviewRequest, Capability,
    CapabilityKind, CapabilitySet, ClassifierRecommendation, ResolvedAction, ReviewContext,
    RiskLevel, SandboxCompatibility, UserAuthorization,
};
use serde::{Deserialize, Serialize};

const SYSTEM_PROMPT: &str = include_str!("../prompt.md");

const RESPONSE_SCHEMA_JSON: &str = r#"{
  "oneOf": [
    {
      "type": "object",
      "required": [
        "recommendation",
        "capabilities",
        "risk",
        "user_authorization",
        "reason"
      ],
      "properties": {
        "recommendation": { "const": "approve" },
        "capabilities": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["kind", "scope"],
            "properties": {
              "kind": {
                "enum": [
                  "file_read",
                  "file_write",
                  "process_spawn",
                  "network",
                  "credential_use",
                  "external_mutation",
                  "system_configuration",
                  "user_interface"
                ]
              },
              "scope": { "type": "string" }
            },
            "additionalProperties": false
          },
          "minItems": 1
        },
        "risk": { "enum": ["low", "medium", "high", "critical"] },
        "user_authorization": {
          "enum": ["explicit", "implicit", "absent", "ambiguous"]
        },
        "reason": { "type": "string" }
      },
      "additionalProperties": false
    },
    {
      "type": "object",
      "required": [
        "recommendation",
        "maximum_capabilities",
        "reason"
      ],
      "properties": {
        "recommendation": { "const": "revise_action" },
        "maximum_capabilities": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["kind", "scope"],
            "properties": {
              "kind": {
                "enum": [
                  "file_read",
                  "file_write",
                  "process_spawn",
                  "network",
                  "credential_use",
                  "external_mutation",
                  "system_configuration",
                  "user_interface"
                ]
              },
              "scope": { "type": "string" }
            },
            "additionalProperties": false
          }
        },
        "reason": { "type": "string" }
      },
      "additionalProperties": false
    },
    {
      "type": "object",
      "required": ["recommendation", "reason"],
      "properties": {
        "recommendation": { "const": "ask_user" },
        "reason": { "type": "string" }
      },
      "additionalProperties": false
    },
    {
      "type": "object",
      "required": ["recommendation", "reason"],
      "properties": {
        "recommendation": { "const": "deny" },
        "reason": { "type": "string" }
      },
      "additionalProperties": false
    }
  ]
}"#;

/// Immutable prompt and response contract used to derive assessment identity.
pub(crate) struct ReviewProtocol {
    revision: &'static str,
    system_prompt: &'static str,
    response_schema_json: &'static str,
}

impl ReviewProtocol {
    pub(crate) fn revision(&self) -> &'static str {
        self.revision
    }

    pub(crate) fn system_prompt(&self) -> &'static str {
        self.system_prompt
    }

    pub(crate) fn response_schema_json(&self) -> &'static str {
        self.response_schema_json
    }
}

pub(crate) const CURRENT_REVIEW_PROTOCOL: ReviewProtocol = ReviewProtocol {
    revision: "review-protocol-5",
    system_prompt: SYSTEM_PROMPT,
    response_schema_json: RESPONSE_SCHEMA_JSON,
};

pub(crate) fn input_with_context(
    request: &ActionReviewRequest,
    context: &ReviewContext,
) -> serde_json::Result<String> {
    let mut input = ModelInput::from(request);
    input.context = context;
    serde_json::to_string(&input)
}

pub(crate) fn parse_recommendation(response: &str) -> serde_json::Result<ClassifierRecommendation> {
    serde_json::from_str::<ModelRecommendation>(response).map(Into::into)
}

pub(crate) fn response_json_bytes(
    recommendation: &ClassifierRecommendation,
) -> serde_json::Result<Vec<u8>> {
    serde_json::to_vec(recommendation)
}

#[derive(Serialize)]
struct ModelInput<'a> {
    action: &'a ResolvedAction,
    provenance: &'a ActionProvenance,
    sandbox: ModelSandboxCompatibility<'a>,
    phase: &'a ActionReviewPhase,
    policy_revision: &'a ActionPolicyRevision,
    context: &'a ReviewContext,
}

impl<'a> From<&'a ActionReviewRequest> for ModelInput<'a> {
    fn from(request: &'a ActionReviewRequest) -> Self {
        let sandbox = match request.sandbox() {
            SandboxCompatibility::Supported(policy) => ModelSandboxCompatibility::Supported {
                filesystem: match policy.file_system() {
                    sandboxing::FileSystemAccess::ReadOnly => "read_only",
                    sandboxing::FileSystemAccess::DirectoryWrite => "dir_write",
                    sandboxing::FileSystemAccess::FullAccess => "full_access",
                },
                network: match policy.network() {
                    sandboxing::NetworkAccess::Denied => "denied",
                    sandboxing::NetworkAccess::Allowed => "allowed",
                    sandboxing::NetworkAccess::Managed => "managed_proxy",
                },
            },
            SandboxCompatibility::Unsupported { reason } => {
                ModelSandboxCompatibility::Unsupported { reason }
            }
            SandboxCompatibility::NotApplicable { reason } => {
                ModelSandboxCompatibility::NotApplicable { reason }
            }
        };
        Self {
            action: request.action(),
            provenance: request.provenance(),
            sandbox,
            phase: request.phase(),
            policy_revision: request.action_policy_revision(),
            context: request.context(),
        }
    }
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum ModelSandboxCompatibility<'a> {
    Supported {
        filesystem: &'static str,
        network: &'static str,
    },
    Unsupported {
        reason: &'a str,
    },
    NotApplicable {
        reason: &'a str,
    },
}

#[derive(Deserialize)]
#[serde(tag = "recommendation", rename_all = "snake_case", deny_unknown_fields)]
enum ModelRecommendation {
    Approve {
        capabilities: Vec<ModelCapability>,
        risk: RiskLevel,
        user_authorization: UserAuthorization,
        reason: String,
    },
    ReviseAction {
        maximum_capabilities: Vec<ModelCapability>,
        reason: String,
    },
    AskUser {
        reason: String,
    },
    Deny {
        reason: String,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ModelCapability {
    kind: CapabilityKind,
    scope: String,
}

impl From<ModelCapability> for Capability {
    fn from(value: ModelCapability) -> Self {
        Self::new(value.kind, value.scope)
    }
}

impl From<ModelRecommendation> for ClassifierRecommendation {
    fn from(value: ModelRecommendation) -> Self {
        match value {
            ModelRecommendation::Approve {
                capabilities,
                risk,
                user_authorization,
                reason,
            } => Self::Approve {
                capabilities: CapabilitySet::new(capabilities.into_iter().map(Into::into)),
                risk,
                user_authorization,
                reason,
            },
            ModelRecommendation::ReviseAction {
                maximum_capabilities,
                reason,
            } => Self::ReviseAction {
                maximum_capabilities: CapabilitySet::new(
                    maximum_capabilities.into_iter().map(Into::into),
                ),
                reason,
            },
            ModelRecommendation::AskUser { reason } => Self::AskUser { reason },
            ModelRecommendation::Deny { reason } => Self::Deny { reason },
        }
    }
}
