use super::start_plan;
use crate::RequestError;
use crate::test_support::Transport;
use async_utils::CancellationSource;
use client::ResolvedApiTarget;
use http_client::HttpHeader;

#[test]
fn start_plan_policy_honors_the_servers_explicit_skip_flag() {
    for (enabled, skip, expected) in [
        (true, true, true),
        (true, false, false),
        (false, false, true),
    ] {
        let transport = Transport::response(
            200,
            &format!(
                r#"{{"code":0,"data":{{"configs":{{"captcha":{{"enabled":{enabled},"skip_model_request":{skip}}}}}}}}}"#
            ),
        );
        let target = ResolvedApiTarget::new(
            start_plan::SERVICE_URL,
            vec![HttpHeader::new("Authorization", "Bearer jwt")],
            ::client::RequestBinding::new(
                ::client::RequestPurpose::Account,
                ::client::RequestIdentity::Anonymous,
            ),
        );
        assert_eq!(
            start_plan::model_request_allowed(
                &transport,
                &target,
                &CancellationSource::new().token()
            ),
            Ok(expected)
        );
        let request = transport.requests.lock().unwrap();
        assert_eq!(request[0].url(), "https://zcode.z.ai/api/v1/client/configs");
        assert_eq!(request[0].headers()[0].value(), "Bearer jwt");
    }
}

#[test]
fn start_plan_rejects_business_errors_without_exposing_response_text() {
    let transport = Transport::response(
        200,
        r#"{"code":3001,"msg":"private detail","data":{"configs":{"captcha":{"enabled":true,"skip_model_request":true}}}}"#,
    );
    let target = ResolvedApiTarget::new(
        start_plan::SERVICE_URL,
        vec![],
        ::client::RequestBinding::new(
            ::client::RequestPurpose::Account,
            ::client::RequestIdentity::Anonymous,
        ),
    );
    assert_eq!(
        start_plan::model_request_allowed(&transport, &target, &CancellationSource::new().token()),
        Err(RequestError::InvalidResponse)
    );
}
