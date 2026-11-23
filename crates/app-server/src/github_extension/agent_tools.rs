use std::sync::Arc;

use ash_async_utils::CancellationToken;
use ash_extension_api::CapabilityToolContribution;
use ash_extension_api::CapabilityToolContributor;
use ash_extension_api::ExtensionError;
use ash_extension_api::ExtensionRegistryBuilder;
use ash_extension_api::ExtensionToolAuthority;
use ash_tools::ToolConcurrency;
use ash_tools::ToolContent;
use ash_tools::ToolDefinition;
use ash_tools::ToolExecutionFuture;
use ash_tools::ToolExecutionOutcome;
use ash_tools::ToolExecutor;
use ash_tools::ToolExposure;
use ash_tools::ToolInputSchema;
use ash_tools::ToolInvocation;
use ash_tools::ToolLoading;
use ash_tools::ToolName;
use ash_tools::ToolOutput;
use ash_tools::ToolOutputSchema;
use ash_tools::ToolPayload;
use ash_tools::ToolSchemaMode;
use ash_tools::ToolStartFailure;
use github::GitHubCredentialProvider;
use github::GitHubProvider;
use github::GitHubRequest;
use github::GitHubResponse;
use github::Repository;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;

const HOST: &str = "github.com";
const MAX_ID: u64 = 9_007_199_254_740_991;
const CHECK_TEXT_BYTES: usize = 8_192;

pub(crate) fn install(
    builder: &mut ExtensionRegistryBuilder,
    credentials: Arc<dyn GitHubCredentialProvider>,
    provider: Arc<dyn GitHubProvider>,
) {
    builder.capability_tool_contributor(
        "github-agent-tools",
        Arc::new(GitHubTools {
            credentials,
            provider,
        }),
    );
}

struct GitHubTools {
    credentials: Arc<dyn GitHubCredentialProvider>,
    provider: Arc<dyn GitHubProvider>,
}

impl CapabilityToolContributor for GitHubTools {
    fn contribute(&self) -> Result<Vec<CapabilityToolContribution>, ExtensionError> {
        Ok([
            Operation::PullRequest,
            Operation::Checks,
            Operation::CheckDetails,
        ]
        .into_iter()
        .map(|operation| {
            CapabilityToolContribution::new(
                Arc::new(GitHubTool {
                    operation,
                    definition: operation.definition(),
                    credentials: self.credentials.clone(),
                    provider: self.provider.clone(),
                }),
                ExtensionToolAuthority::ExternalRead {
                    service: HOST.to_owned(),
                    network_scopes: vec!["https://api.github.com".to_owned()],
                    credential_reference: Some("github".to_owned()),
                },
            )
        })
        .collect())
    }
}

#[derive(Clone, Copy)]
enum Operation {
    PullRequest,
    Checks,
    CheckDetails,
}

struct GitHubTool {
    operation: Operation,
    definition: ToolDefinition,
    credentials: Arc<dyn GitHubCredentialProvider>,
    provider: Arc<dyn GitHubProvider>,
}

impl ToolExecutor for GitHubTool {
    fn definition(&self) -> ToolDefinition {
        self.definition.clone()
    }

    fn tool_set(&self) -> Option<&'static str> {
        Some("core.github")
    }

    fn category(&self) -> Option<ash_tools::ToolCategory> {
        Some(ash_tools::ToolCategory::Read)
    }

    fn exposure(&self) -> ToolExposure {
        ToolExposure::Deferred
    }

    fn concurrency(&self) -> ToolConcurrency {
        ToolConcurrency::ParallelSafe
    }

    fn execute(&self, invocation: ToolInvocation) -> ToolExecutionFuture<'_> {
        Box::pin(async move {
            let ToolPayload::FunctionArguments(arguments) = invocation.payload() else {
                return ToolExecutionOutcome::NotStarted(ToolStartFailure::new(
                    "GitHub tools require function arguments",
                ));
            };
            let arguments = match serde_json::from_value(arguments.clone()) {
                Ok(arguments) => arguments,
                Err(error) => {
                    return ToolExecutionOutcome::NotStarted(ToolStartFailure::new(
                        error.to_string(),
                    ));
                }
            };
            match self.read(arguments, invocation.context().cancellation()) {
                Ok(output) => {
                    ToolExecutionOutcome::Returned(ToolOutput::success(vec![ToolContent::Text(
                        output.to_string(),
                    )]))
                }
                Err(error) => {
                    ToolExecutionOutcome::Returned(ToolOutput::error(vec![ToolContent::Text(
                        error.to_string(),
                    )]))
                }
            }
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Arguments {
    owner: String,
    repository: String,
    account_id: Option<String>,
    number: Option<u64>,
    head_sha: Option<String>,
    page: Option<u32>,
    check_id: Option<u64>,
}

impl GitHubTool {
    fn read(
        &self,
        arguments: Arguments,
        cancellation: &CancellationToken,
    ) -> github::Result<Value> {
        let request = self.operation.request(&arguments)?;
        cancellation.check().map_err(|_| github::Error::Cancelled)?;
        self.provider.check_available()?;
        let grant = match arguments.account_id {
            Some(id) if !id.is_empty() && id.len() <= 512 => {
                self.credentials.authorization_for(&id)?
            }
            Some(_) => {
                return Err(github::Error::InvalidInput(
                    "Invalid GitHub account ID".into(),
                ));
            }
            None if matches!(self.operation, Operation::PullRequest) => {
                self.credentials.authorization()?
            }
            None => {
                return Err(github::Error::InvalidInput(
                    "Use the account_id returned by github_pr_read".into(),
                ));
            }
        };
        if grant.host != HOST {
            return Err(github::Error::InvalidInput(
                "Select a github.com account".into(),
            ));
        }
        let account = grant.account_id.clone();
        let response = self.provider.call(Some(grant), request, cancellation)?;
        cancellation.check().map_err(|_| github::Error::Cancelled)?;
        let result = match (self.operation, response) {
            (Operation::PullRequest, GitHubResponse::PullRequest(pr)) => json!({
                "account_id": account,
                "number": pr.number,
                "url": pr.html_url,
                "title": pr.title,
                "state": pr.state,
                "draft": pr.draft,
                "head_sha": pr.head.sha,
                "body": pr.body.as_deref().map(|body| bounded_text(body, 4_096)),
            }),
            (Operation::Checks, GitHubResponse::Checks(checks)) => json!({
                "account_id": account,
                "head_sha": arguments.head_sha,
                "checks": checks,
            }),
            (Operation::CheckDetails, GitHubResponse::CheckDetails(details)) => json!({
                "account_id": account,
                "head_sha": arguments.head_sha,
                "check_id": arguments.check_id,
                "title": details.title,
                "summary": bounded_text(&details.summary, CHECK_TEXT_BYTES),
                "text": bounded_text(&details.text, CHECK_TEXT_BYTES),
                "annotations": details.annotations.into_iter().map(|annotation| json!({
                    "path": annotation.path,
                    "start_line": annotation.start_line,
                    "end_line": annotation.end_line,
                    "level": annotation.annotation_level,
                    "message": bounded_text(&annotation.message, 512),
                })).collect::<Vec<_>>(),
                "next_page": details.next_page,
            }),
            _ => {
                return Err(github::Error::InvalidResponse(
                    "GitHub provider returned a different operation".into(),
                ));
            }
        };
        Ok(result)
    }
}

impl Operation {
    fn request(self, arguments: &Arguments) -> github::Result<GitHubRequest> {
        let repository = Repository::new(
            HOST.into(),
            arguments.owner.clone(),
            arguments.repository.clone(),
        )?;
        let pr_number = || positive_id(arguments.number, "pull request number");
        let head_sha = || {
            arguments
                .head_sha
                .as_deref()
                .filter(|sha| sha.len() == 40 && sha.bytes().all(|byte| byte.is_ascii_hexdigit()))
                .map(str::to_owned)
                .ok_or_else(|| {
                    github::Error::InvalidInput(
                        "Use the complete head_sha returned by github_pr_read".into(),
                    )
                })
        };
        let page = || {
            arguments
                .page
                .filter(|page| (1..=100).contains(page))
                .ok_or_else(|| {
                    github::Error::InvalidInput("Check page must be between 1 and 100".into())
                })
        };
        let request = match self {
            Self::PullRequest
                if arguments.head_sha.is_none()
                    && arguments.check_id.is_none()
                    && arguments.page.is_none() =>
            {
                GitHubRequest::PullRequest {
                    repository,
                    number: pr_number()?,
                }
            }
            Self::Checks if arguments.number.is_none() && arguments.check_id.is_none() => {
                GitHubRequest::Checks {
                    repository,
                    commit: head_sha()?,
                    page: page()?,
                }
            }
            Self::CheckDetails => GitHubRequest::CheckDetails {
                repository,
                number: pr_number()?,
                commit: head_sha()?,
                check_id: positive_id(arguments.check_id, "check run ID")?,
                page: page()?,
            },
            _ => {
                return Err(github::Error::InvalidInput(
                    "Unexpected arguments for this GitHub tool".into(),
                ));
            }
        };
        Ok(request)
    }

    fn definition(self) -> ToolDefinition {
        let (name, description, fields) = match self {
            Self::PullRequest => (
                "github_pr_read",
                "Read a github.com pull request by repository and PR number. Returns its account_id and exact head_sha for subsequent GitHub CI queries.",
                &["number"][..],
            ),
            Self::Checks => (
                "github_pr_checks",
                "List GitHub CI check runs and commit statuses for the head_sha and account_id returned by github_pr_read. Start at page 1 and use nextPage if needed.",
                &["head_sha", "page"][..],
            ),
            Self::CheckDetails => (
                "github_pr_check_details",
                "Read a CI check failure summary, output text and paged annotations using the check_id from github_pr_checks. Start at page 1. The check must belong to the current PR head.",
                &["number", "head_sha", "check_id", "page"][..],
            ),
        };
        let mut properties = json!({
            "owner": {"type":"string"},
            "repository": {"type":"string"},
            "account_id": if matches!(self, Self::PullRequest) {
                json!({"type":["string","null"],"description":"GitHub account ID, or null to use the primary github.com account."})
            } else {
                json!({"type":"string","description":"The account_id from github_pr_read."})
            },
        });
        let mut required = vec!["owner", "repository", "account_id"];
        for &field in fields {
            required.push(field);
            properties[field] = match field {
                "head_sha" => {
                    json!({"type":"string","description":"The exact 40-character PR head commit SHA."})
                }
                "page" => json!({"type":"integer","minimum":1,"maximum":100}),
                _ => json!({"type":"integer","minimum":1,"maximum":MAX_ID}),
            };
        }
        ToolDefinition::function(
            ToolName::new(name).expect("valid GitHub tool name"),
            description,
            ToolInputSchema::parse(json!({
                "type":"object", "properties":properties, "required":required, "additionalProperties":false,
            })).expect("valid GitHub tool schema"),
            ToolOutputSchema::Unspecified,
            ToolSchemaMode::Strict,
            ToolLoading::Deferred,
        ).expect("valid GitHub tool definition")
    }
}

fn positive_id(id: Option<u64>, label: &str) -> github::Result<u64> {
    id.filter(|id| (1..=MAX_ID).contains(id))
        .ok_or_else(|| github::Error::InvalidInput(format!("Invalid {label}")))
}

fn bounded_text(text: &str, max_bytes: usize) -> String {
    ash_utils_string::truncate_middle_with_marker(text, max_bytes, "\n[truncated]\n")
}

#[cfg(test)]
#[path = "agent_tools_tests.rs"]
mod tests;
