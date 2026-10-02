use crate::RequestError;
use async_utils::CancellationSource;
use client::ClientError;
use client::ClientRequest;
use client::ClientResponse;
use client::OperationClient;
use client::ResolvedApiTarget;
use http_client::HttpHeader;
use std::collections::VecDeque;
use std::sync::Mutex;

struct ScriptedClient {
    responses: Mutex<VecDeque<ClientResponse>>,
    requests: Mutex<Vec<ClientRequest>>,
}

impl ScriptedClient {
    fn new(bodies: impl IntoIterator<Item = &'static str>) -> Self {
        Self {
            responses: Mutex::new(
                bodies
                    .into_iter()
                    .map(|body| ClientResponse::new(200, Vec::new(), body.as_bytes().to_vec()))
                    .collect(),
            ),
            requests: Mutex::new(Vec::new()),
        }
    }
}

impl OperationClient for ScriptedClient {
    fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
        self.requests.lock().unwrap().push(request.clone());
        self.responses
            .lock()
            .unwrap()
            .pop_front()
            .ok_or_else(|| ClientError::Transport("script exhausted".into()))
    }
}

#[test]
fn bigmodel_login_resolves_an_internal_coding_plan_credential() {
    let client = ScriptedClient::new([
        r#"{"code":200,"data":{"organizations":[{"organizationName":"默认机构","organizationId":"org","projects":[{"projectName":"默认项目","projectId":"project"}]}]}}"#,
        r#"{"code":200,"data":[]}"#,
        r#"{"code":200,"data":{"apiKey":"key-id"}}"#,
        r#"{"code":200,"data":{"secretKey":"secret"}}"#,
    ]);
    let target = ResolvedApiTarget::new(
        "https://bigmodel.cn",
        vec![HttpHeader::new("Authorization", "account-token")],
        ::client::RequestBinding::new(
            ::client::RequestPurpose::Account,
            ::client::RequestIdentity::Anonymous,
        ),
    );
    let credential =
        crate::bigmodel::issue_api_key(&client, &target, &CancellationSource::new().token())
            .unwrap();
    assert_eq!(credential, "key-id.secret");
    let requests = client.requests.lock().unwrap();
    assert_eq!(requests.len(), 4);
    assert_eq!(
        requests[0].url(),
        "https://bigmodel.cn/api/biz/customer/getCustomerInfo"
    );
    assert_eq!(
        requests[2].url(),
        "https://bigmodel.cn/api/biz/v1/organization/org/projects/project/api_keys"
    );
    assert_eq!(
        requests[3].url(),
        "https://bigmodel.cn/api/biz/v1/organization/org/projects/project/api_keys/copy/key-id"
    );
    assert!(requests.iter().all(|request| {
        request
            .headers()
            .iter()
            .any(|header| header.name() == "Authorization" && header.value() == "account-token")
    }));
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(requests[2].body()).unwrap(),
        serde_json::json!({"name":"ash-coding-plan"})
    );
}

#[test]
fn zai_login_exchanges_account_token_and_uses_business_token() {
    let client = ScriptedClient::new([
        r#"{"code":200,"data":{"access_token":"biz-token"}}"#,
        r#"{"code":200,"data":{"organizations":[{"organizationName":"默认机构","organizationId":"org","projects":[{"projectName":"默认项目","projectId":"project"}]}]}}"#,
        r#"{"code":200,"data":[{"name":"ash-coding-plan","apiKey":"key-id"}]}"#,
        r#"{"code":200,"data":{"secretKey":"secret"}}"#,
    ]);
    let credential =
        crate::zai::issue_api_key(&client, "oauth-token", &CancellationSource::new().token())
            .unwrap();
    assert_eq!(credential, "key-id.secret");
    let requests = client.requests.lock().unwrap();
    assert_eq!(requests[0].url(), "https://api.z.ai/api/auth/z/login");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(requests[0].body()).unwrap(),
        serde_json::json!({"token":"oauth-token"})
    );
    assert!(requests.iter().skip(1).all(|request| {
        request
            .headers()
            .iter()
            .any(|header| header.name() == "Authorization" && header.value() == "Bearer biz-token")
    }));
}

#[test]
fn zai_requires_a_copyable_secret() {
    let client = ScriptedClient::new([
        r#"{"code":200,"data":{"access_token":"biz-token"}}"#,
        r#"{"code":200,"data":{"organizations":[{"organizationId":"org","projects":[{"projectId":"project"}]}]}}"#,
        r#"{"code":200,"data":[{"name":"ash-coding-plan","apiKey":"key-id"}]}"#,
        r#"{"code":200,"data":{}}"#,
    ]);
    assert_eq!(
        crate::zai::issue_api_key(&client, "oauth-token", &CancellationSource::new().token()),
        Err(RequestError::InvalidResponse)
    );
}

#[test]
fn coding_plan_rejects_ambiguous_organizations_before_creating_a_key() {
    let client = ScriptedClient::new([
        r#"{"code":200,"data":{"organizations":[{"organizationName":"Team A","organizationId":"a","projects":[]},{"organizationName":"Team B","organizationId":"b","projects":[]}]}}"#,
    ]);
    let target = ResolvedApiTarget::new(
        "https://bigmodel.cn",
        Vec::new(),
        ::client::RequestBinding::new(
            ::client::RequestPurpose::Account,
            ::client::RequestIdentity::Anonymous,
        ),
    );
    assert_eq!(
        crate::bigmodel::issue_api_key(&client, &target, &CancellationSource::new().token()),
        Err(RequestError::InvalidResponse)
    );
    assert_eq!(client.requests.lock().unwrap().len(), 1);
}

#[test]
fn both_coding_plan_regions_query_their_own_quota_endpoint_with_the_request_key() {
    for (bigmodel, expected_url) in [
        (
            true,
            "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
        ),
        (false, "https://api.z.ai/api/monitor/usage/quota/limit"),
    ] {
        let client = ScriptedClient::new([
            r#"{"code":200,"data":{"limits":[{"type":"CREDIT_LIMIT","percentage":12.5,"unit":3,"number":5,"nextResetTime":1790553600000}]}}"#,
        ]);
        let target = ResolvedApiTarget::new(
            if bigmodel {
                crate::bigmodel::MONITOR_URL
            } else {
                crate::zai::BUSINESS_URL
            },
            vec![http_client::HttpHeader::new("Authorization", "coding-key")],
            ::client::RequestBinding::new(
                ::client::RequestPurpose::Account,
                ::client::RequestIdentity::connection("coding-plan", b"coding-key"),
            ),
        );
        let limits = if bigmodel {
            crate::bigmodel::read_quota(&client, &target, &CancellationSource::new().token())
        } else {
            crate::zai::read_quota(&client, &target, &CancellationSource::new().token())
        }
        .unwrap();
        assert_eq!(limits.len(), 1);
        assert_eq!(limits[0].kind, "CREDIT_LIMIT");
        assert_eq!(limits[0].percentage, Some(12.5));
        let requests = client.requests.lock().unwrap();
        assert_eq!(requests[0].url(), expected_url);
        assert!(
            requests[0].headers().iter().any(|header| {
                header.name() == "Authorization" && header.value() == "coding-key"
            })
        );
    }
}

#[test]
fn coding_plan_rejects_ambiguous_projects_before_creating_a_key() {
    let client = ScriptedClient::new([
        r#"{"code":200,"data":{"organizations":[{"organizationName":"默认机构","organizationId":"org","projects":[{"projectName":"默认项目备份","projectId":"a"},{"projectName":"Team","projectId":"b"}]}]}}"#,
    ]);
    let target = ResolvedApiTarget::new(
        "https://bigmodel.cn",
        Vec::new(),
        ::client::RequestBinding::new(
            ::client::RequestPurpose::Account,
            ::client::RequestIdentity::Anonymous,
        ),
    );
    assert_eq!(
        crate::bigmodel::issue_api_key(&client, &target, &CancellationSource::new().token()),
        Err(RequestError::InvalidResponse)
    );
    assert_eq!(client.requests.lock().unwrap().len(), 1);
}

#[test]
fn coding_plan_selects_only_the_exact_default_scope() {
    let client = ScriptedClient::new([
        r#"{"code":200,"data":{"organizations":[{"organizationName":"默认机构备份","organizationId":"wrong","projects":[]},{"organizationName":"默认机构","organizationId":"org","projects":[{"projectName":"默认项目备份","projectId":"wrong"},{"projectName":"默认项目","projectId":"project"}]}]}}"#,
        r#"{"code":200,"data":[{"name":"ash-coding-plan","apiKey":"key-id"}]}"#,
        r#"{"code":200,"data":{"secretKey":"secret"}}"#,
    ]);
    let target = ResolvedApiTarget::new(
        "https://bigmodel.cn",
        Vec::new(),
        ::client::RequestBinding::new(
            ::client::RequestPurpose::Account,
            ::client::RequestIdentity::Anonymous,
        ),
    );
    assert_eq!(
        crate::bigmodel::issue_api_key(&client, &target, &CancellationSource::new().token()),
        Ok("key-id.secret".into())
    );
    assert!(
        client.requests.lock().unwrap()[1]
            .url()
            .contains("/organization/org/projects/project/api_keys")
    );
}

#[test]
fn coding_plan_quota_checks_business_status_and_requires_typed_data() {
    let target = ResolvedApiTarget::new(
        "https://bigmodel.cn",
        Vec::new(),
        ::client::RequestBinding::new(
            ::client::RequestPurpose::Account,
            ::client::RequestIdentity::Anonymous,
        ),
    );
    let token = CancellationSource::new().token();
    for body in [
        r#"{"code":0,"data":{"limits":[]}}"#,
        r#"{"code":"200","data":{"limits":[]}}"#,
        r#"{"code":null,"data":{"limits":[]}}"#,
        r#"{"data":{"limits":[]}}"#,
    ] {
        let client = ScriptedClient::new([body]);
        assert!(
            crate::coding_plan::read_quota(&client, &target, &token)
                .unwrap()
                .is_empty()
        );
        assert_eq!(client.requests.lock().unwrap().len(), 1);
    }
    for body in [
        r#"{"code":401,"data":{"limits":[]}}"#,
        r#"{"code":"403","data":{"limits":[]}}"#,
        r#"{"code":true,"data":{"limits":[]}}"#,
        r#"{"code":200}"#,
        r#"{"code":200,"data":null}"#,
        r#"{"code":200,"data":{"limits":[{"type":5}]}}"#,
        r#"{"code":200,"data":{"limits":[{"type":"CREDIT_LIMIT","nextResetTime":"tomorrow"}]}}"#,
    ] {
        let client = ScriptedClient::new([body]);
        assert_eq!(
            crate::coding_plan::read_quota(&client, &target, &token),
            Err(RequestError::InvalidResponse)
        );
        assert_eq!(client.requests.lock().unwrap().len(), 1);
    }
}

#[test]
fn malformed_coding_plan_identity_stops_before_credential_requests() {
    let target = ResolvedApiTarget::new(
        "https://bigmodel.cn",
        Vec::new(),
        ::client::RequestBinding::new(
            ::client::RequestPurpose::Account,
            ::client::RequestIdentity::Anonymous,
        ),
    );
    let token = CancellationSource::new().token();
    for body in [
        r#"{"code":200,"data":{"organizations":[{"organizationId":17,"projects":[]}]}}"#,
        r#"{"code":200,"data":{"organizations":[{"organizationId":"","projects":[]}]}}"#,
        r#"{"code":200,"data":{"organizations":[{"organizationId":"org","projects":[{"projectId":""}]}]}}"#,
        r#"{"code":200,"data":{"organizations":[{"organizationId":"org","projects":[{"projectId":null}]}]}}"#,
    ] {
        let client = ScriptedClient::new([body]);
        assert_eq!(
            crate::bigmodel::issue_api_key(&client, &target, &token),
            Err(RequestError::InvalidResponse)
        );
        assert_eq!(client.requests.lock().unwrap().len(), 1);
    }
}
