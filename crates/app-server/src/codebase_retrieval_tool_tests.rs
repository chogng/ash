use super::*;
use ash_action_policy::GrantId;
use ash_codebase::Codebase;
use ash_codebase::CodebaseLimits;
use ash_file_access::Dir;
use ash_file_access::Grant;
use ash_file_access::GrantSource;
use ash_file_access::Permission;
use ash_file_access::Permissions;
use ash_protocol::ToolCallId;
use std::fs;

#[test]
fn explicit_search_code_tool_requires_its_exact_read_only_grant_and_returns_local_hits() {
    let directory = tempfile::tempdir().unwrap();
    fs::create_dir(directory.path().join(".git")).unwrap();
    fs::write(
        directory.path().join("retrieval.rs"),
        "pub fn explicit_agent_retrieval() -> bool { true }\n",
    )
    .unwrap();
    let root = Dir::open_local(directory.path()).unwrap();
    let authorization = Grant::for_environment(
        root.clone(),
        GrantSource::HostConfiguration,
        Permissions::new([Permission::SearchFiles]),
    )
    .authorize(Permission::SearchFiles)
    .unwrap();
    let index = Arc::new(Codebase::open_memory(root, CodebaseLimits::default()).unwrap());
    index.rebuild().unwrap();
    let tool = CodebaseRetrievalTool::new(
        authorization,
        ash_codebase::CodebaseRetrievalService::local(index),
        None,
        None,
        None,
    );
    let call = ToolCall {
        id: ToolCallId::new("search-code-test").unwrap(),
        name: ToolName::new(CODE_RETRIEVAL_TOOL_NAME).unwrap(),
        arguments: json!({
            "query": "explicit_agent_retrieval",
            "max_results": 10
        }),
    };

    assert!(matches!(
        tool.execute(
            &call,
            &ToolAuthorization::UnsandboxedGrant {
                grant_id: GrantId::new("wrong-grant")
            },
            &ash_async_utils::CancellationSource::new().token(),
        ),
        Err(CoreError::Policy(_))
    ));

    let ToolExecutionOutput::Success(output) = tool
        .execute(
            &call,
            &ToolAuthorization::UnsandboxedGrant {
                grant_id: GrantId::new("codebase-read"),
            },
            &ash_async_utils::CancellationSource::new().token(),
        )
        .unwrap()
    else {
        panic!("search_code must return a successful result");
    };
    let output: serde_json::Value = serde_json::from_str(&output).unwrap();
    assert_eq!(output["hits"][0]["path"], "retrieval.rs");
    assert!(
        output["hits"][0]["content"]
            .as_str()
            .unwrap()
            .contains("explicit_agent_retrieval")
    );
}

#[test]
fn search_code_filters_profile_denials_and_rejects_revoked_search_grants() {
    let temp = tempfile::tempdir().unwrap();
    fs::write(
        temp.path().join("public.rs"),
        "pub fn matching_public() {}\n",
    )
    .unwrap();
    fs::write(
        temp.path().join("private.rs"),
        "pub fn matching_private() {}\n",
    )
    .unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let grant = Grant::for_environment(
        dir.clone(),
        GrantSource::ExplicitUser,
        Permissions::new([Permission::SearchFiles]),
    )
    .with_path_policy(
        ash_file_access::PathAccessPolicy::new(
            ash_file_access::PathAccess::ReadOnly,
            vec![ash_file_access::PathAccessRule {
                pattern: "private.rs".into(),
                access: ash_file_access::PathAccess::Denied,
            }],
        )
        .unwrap(),
    );
    let index = Arc::new(Codebase::open_memory(dir, CodebaseLimits::default()).unwrap());
    index.rebuild().unwrap();
    let tool = CodebaseRetrievalTool::new(
        grant.authorize(Permission::SearchFiles).unwrap(),
        ash_codebase::CodebaseRetrievalService::local(index),
        None,
        None,
        None,
    );
    let call = ToolCall {
        id: ToolCallId::new("profile-search").unwrap(),
        name: ToolName::new(CODE_RETRIEVAL_TOOL_NAME).unwrap(),
        arguments: json!({"query":"matching", "max_results":10}),
    };
    let authorization = ToolAuthorization::UnsandboxedGrant {
        grant_id: GrantId::new("codebase-read"),
    };
    let token = ash_async_utils::CancellationSource::new().token();
    let ToolExecutionOutput::Success(output) = tool.execute(&call, &authorization, &token).unwrap()
    else {
        panic!("successful retrieval expected");
    };
    assert!(output.contains("matching_public"));
    assert!(!output.contains("matching_private"));
    grant.revoke();
    assert!(tool.execute(&call, &authorization, &token).is_err());
}
