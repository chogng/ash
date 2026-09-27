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
    let target = ResolvedApiTarget::new("https://bigmodel.cn", Vec::new());
    assert_eq!(
        crate::bigmodel::issue_api_key(&client, &target, &CancellationSource::new().token()),
        Err(RequestError::InvalidResponse)
    );
    assert_eq!(client.requests.lock().unwrap().len(), 1);
}

#[test]
fn coding_plan_rejects_ambiguous_projects_before_creating_a_key() {
    let client = ScriptedClient::new([
        r#"{"code":200,"data":{"organizations":[{"organizationName":"默认机构","organizationId":"org","projects":[{"projectName":"默认项目备份","projectId":"a"},{"projectName":"Team","projectId":"b"}]}]}}"#,
    ]);
    let target = ResolvedApiTarget::new("https://bigmodel.cn", Vec::new());
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
    let target = ResolvedApiTarget::new("https://bigmodel.cn", Vec::new());
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
