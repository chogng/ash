use super::*;

struct CancellableHttp {
    started: std::sync::mpsc::Sender<()>,
}
impl ash_http_client::HttpClient for CancellableHttp {
    fn execute(&self, _: &HttpRequest) -> std::result::Result<HttpResponse, HttpClientError> {
        panic!("GitHub must use cancellable HTTP")
    }
    fn execute_with_cancellation(
        &self,
        _: &HttpRequest,
        cancellation: &ash_async_utils::CancellationToken,
    ) -> std::result::Result<HttpResponse, HttpClientError> {
        self.started.send(()).unwrap();
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(cancellation.cancelled());
        Err(HttpClientError::Transport("private-token".into()))
    }
}

#[tokio::test(flavor = "current_thread")]
async fn cancelling_live_http_ends_reads_and_marks_dispatched_writes_uncertain() {
    for operation in [Operation::Read, Operation::Write] {
        let (started, entered) = std::sync::mpsc::channel();
        let source = ash_async_utils::CancellationSource::new();
        let client = crate::GitHub::for_account(
            Arc::new(crate::tests::Credentials),
            Arc::new(CancellableHttp { started }),
            source.token(),
        )
        .unwrap();
        let canceller = std::thread::spawn(move || {
            entered.recv_timeout(Duration::from_secs(3)).unwrap();
            source.cancel();
        });
        let repository = crate::tests::repository();
        let response = client
            .request::<Value>(
                &repository.host,
                if operation == Operation::Read {
                    HttpMethod::Get
                } else {
                    HttpMethod::Post
                },
                &repository.endpoint("issues"),
                None,
                operation,
            )
            .await
            .map(|response| response.data);
        canceller.join().unwrap();
        assert_eq!(
            response,
            Err(if operation == Operation::Read {
                Error::Cancelled
            } else {
                Error::SubmissionUncertain
            })
        );
    }
}

#[test]
fn successful_empty_delete_has_a_null_result() {
    let result: Value = decode_response(
        HttpResponse::new(204, vec![], vec![]),
        false,
        Operation::Write,
    )
    .unwrap();
    assert_eq!(result, Value::Null);
}

#[test]
fn writes_with_lost_or_invalid_responses_have_an_uncertain_outcome() {
    for response in [
        HttpResponse::new(502, vec![], b"private-token".to_vec()),
        HttpResponse::new(201, vec![], b"invalid private-token".to_vec()),
    ] {
        assert_eq!(
            decode_response::<Value>(response, false, Operation::Write),
            Err(Error::SubmissionUncertain)
        );
    }
    assert!(matches!(
        decode_response::<Value>(
            HttpResponse::new(200, vec![], b"invalid private-token".to_vec()),
            false,
            Operation::Read
        ),
        Err(Error::InvalidResponse(_))
    ));
}

#[test]
fn structured_graphql_refusals_do_not_copy_private_server_messages() {
    for (kind, expected) in [
        ("FORBIDDEN", Error::PermissionDenied),
        ("RATE_LIMITED", Error::RateLimited),
        ("NOT_FOUND", Error::NotFound),
        ("UNAUTHENTICATED", Error::AuthenticationRequired),
        (
            "STALE_DATA",
            Error::Conflict("GitHub resource changed".into()),
        ),
    ] {
        let response = HttpResponse::new(
            200,
            vec![],
            serde_json::to_vec(
                &serde_json::json!({"errors":[{"type":kind,"message":"private-token"}]}),
            )
            .unwrap(),
        );
        assert_eq!(
            decode_response::<Value>(response, true, Operation::Write),
            Err(expected)
        );
    }
}
