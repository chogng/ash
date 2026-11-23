use std::sync::Mutex;

use ash_action_policy::ExecutionDecision;
use ash_async_utils::CancellationSource;
use ash_core::ToolAuthorization;
use ash_login::LoginError;

use ash_protocol::ToolCall;
use ash_protocol::ToolCallId;
use ash_protocol::ToolExecutionOutput;
use github::GitHubAuthorization;

use super::*;

const HEAD_SHA: &str = "0123456789012345678901234567890123456789";

struct Credentials;

impl GitHubCredentialProvider for Credentials {
    fn authorization(&self) -> Result<GitHubAuthorization, LoginError> {
        Ok(GitHubAuthorization {
            host: HOST.into(),
            account_id: "active-account".into(),
            grant_id: "current-grant".into(),
        })
    }

    fn token(&self, _: &GitHubAuthorization) -> Result<ash_secrets::SecretValue, LoginError> {
        panic!("agent tools must not read credentials")
    }
}

#[derive(Default)]
struct Provider(Mutex<Vec<GitHubRequest>>);

impl GitHubProvider for Provider {
    fn call(
        &self,
        authorization: Option<GitHubAuthorization>,
        request: GitHubRequest,
        _: &CancellationToken,
    ) -> github::Result<GitHubResponse> {
        assert_eq!(authorization.unwrap().grant_id, "current-grant");
        assert!(!request.is_write());
        self.0.lock().unwrap().push(request);
        Ok(GitHubResponse::CheckDetails(github::CheckDetails {
            title: "Build failure".into(),
            summary: "failed".into(),
            text: "日志".repeat(CHECK_TEXT_BYTES),
            annotations: vec![],
            next_page: Some(2),
            actions_job: true,
        }))
    }
}

#[test]
fn github_tools_are_deferred_and_reviewed_by_the_extension_policy() {
    let mut builder = ExtensionRegistryBuilder::new();
    install(
        &mut builder,
        Arc::new(Credentials),
        Arc::new(Provider::default()),
    );
    let port = crate::extension_tools::compose_extension_tools(&builder.build())
        .unwrap()
        .unwrap();
    let combined = crate::tool_composition::combine_tool_ports(vec![port])
        .unwrap()
        .unwrap();
    let model = combined
        .tools
        .model_definitions(&Default::default())
        .unwrap();
    assert_eq!(
        model
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>(),
        ["tool_search"]
    );
    let name = ToolName::new("github_pr_read").unwrap();
    let cancellation = CancellationSource::new();
    let search = ToolCall {
        id: ToolCallId::new("find-github-read").unwrap(),
        name: ToolName::new("tool_search").unwrap(),
        arguments: json!({"query":"github_pr_read","strategy":"bm25","limit":1}),
    };
    let review = combined.tools.prepare(&search).unwrap();
    let ExecutionDecision::RunUnsandboxed { grant_id } = combined
        .policy
        .decide(&review, &cancellation.token())
        .unwrap()
    else {
        panic!("discovery requires its host grant");
    };
    let ToolExecutionOutput::Success(output) = combined
        .tools
        .execute(
            &search,
            &ToolAuthorization::UnsandboxedGrant { grant_id },
            &cancellation.token(),
        )
        .unwrap()
    else {
        panic!("GitHub PR read was not found");
    };
    let activated = combined
        .tools
        .activated_tool_names(&search, &output)
        .unwrap();
    assert_eq!(activated, vec![name.clone()]);
    let loaded = combined
        .tools
        .model_definitions(&activated.into_iter().collect())
        .unwrap();
    assert!(loaded.iter().any(|tool| tool.name == name));
    let call = ToolCall {
        id: ToolCallId::new("github-read").unwrap(),
        name,
        arguments: json!({"owner":"ash","repository":"app","account_id":null,"number":12}),
    };
    let review = combined.tools.prepare(&call).unwrap();
    assert!(matches!(
        combined
            .policy
            .decide(&review, &cancellation.token())
            .unwrap(),
        ExecutionDecision::AskUser(_)
    ));
}

#[test]
fn check_details_uses_the_exact_account_and_pr_head_and_bounds_output() {
    let provider = Arc::new(Provider::default());
    let tool = GitHubTool {
        operation: Operation::CheckDetails,
        definition: Operation::CheckDetails.definition(),
        credentials: Arc::new(Credentials),
        provider: provider.clone(),
    };
    let cancellation = CancellationSource::new();
    let args = |account: &str| {
        serde_json::from_value(json!({
            "owner":"ash","repository":"app","account_id":account,
            "number":12,"head_sha":HEAD_SHA,"check_id":34,"page":1,
        }))
        .unwrap()
    };
    assert!(matches!(
        tool.read(args("old-account"), &cancellation.token()),
        Err(github::Error::AuthenticationRequired)
    ));
    assert!(provider.0.lock().unwrap().is_empty());
    let output = tool
        .read(args("active-account"), &cancellation.token())
        .unwrap();
    assert_eq!(output["account_id"], "active-account");
    assert_eq!(output["head_sha"], HEAD_SHA);
    assert_eq!(output["next_page"], 2);
    assert!(output["text"].as_str().unwrap().len() <= CHECK_TEXT_BYTES);
    let requests = provider.0.lock().unwrap();
    assert!(matches!(
        requests.as_slice(),
        [GitHubRequest::CheckDetails {repository, number: 12, commit, check_id: 34, page: 1}]
            if repository.host == HOST && commit == HEAD_SHA
    ));
}
