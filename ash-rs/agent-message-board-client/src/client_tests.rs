use super::*;
use async_utils::CancellationSource;
use protocol::TurnId;
use serde_json::json;

#[test]
fn credentials_and_endpoints_reject_invalid_boundaries_and_redact_secrets() {
    for token in [
        "short",
        "                              32",
        "abcdefghijklmnopqrstuvwxyz012345\n",
    ] {
        assert!(AccessToken::new(token.into()).is_err());
    }
    let credential = AccessToken::new("confidential-board-host-credential-32".into()).unwrap();
    assert!(!format!("{credential:?}").contains("confidential"));
    let http = Arc::new(
        http_client::ReqwestHttpClient::with_network(
            http_client::OutboundNetworkSnapshot::new(http_client::HttpClientConfig::default())
                .unwrap(),
        )
        .unwrap(),
    );
    for endpoint in [
        "bad",
        "file:///tmp/board",
        "https://u:p@board.test",
        "https://board.test/?x=1",
        "https://board.test/#x",
    ] {
        assert!(RemoteMessageBoard::new(http.clone(), endpoint, credential.clone()).is_err());
    }
    let client =
        RemoteMessageBoard::new(http, "https://board.test/prefix/", credential.clone()).unwrap();
    let request = client.request("/members", &credential, &json!({})).unwrap();
    assert_eq!(
        request.url(),
        "https://board.test/prefix/v1/agent-message-board/members"
    );
    assert!(request.rejects_redirects());
}
#[test]
fn split_sse_frames_bind_recipient_turn_and_unicode_and_bound_memory() {
    let watch = NotificationWatch {
        scope: Scope {
            session: SessionId::new("s").unwrap(),
            root: ThreadId::new("r").unwrap(),
        },
        caller: ThreadId::new("r").unwrap(),
        turn_id: TurnId::new("current").unwrap(),
        after: 0,
    };
    let valid = BoardNotification {
        scope: watch.scope.clone(),
        recipient: watch.caller.clone(),
        turn_id: watch.turn_id.clone(),
        post: json!({"id":1,"topic":1,"channel":"work","author":"sender","created_at":1,"preview":"🦀 evidence","total_chars":10,"replies":0}),
    };
    let stale = BoardNotification {
        turn_id: TurnId::new("previous").unwrap(),
        ..valid.clone()
    };
    let foreign = BoardNotification {
        recipient: ThreadId::new("outside").unwrap(),
        ..valid.clone()
    };
    let mut received = Vec::new();
    {
        let mut callback = |notice| {
            received.push(notice);
            Ok(())
        };
        let mut sink = NoticeSink {
            watch: &watch,
            receive: &mut callback,
            frame: Vec::new(),
            ready: false,
            previous_cr: false,
        };
        let stream = format!(
            "event: ready\r\ndata: {{}}\r\n\r\n: heartbeat\r\r{}{}{}",
            format!(
                "event: notification\ndata: {}\n\n",
                serde_json::to_string(&stale).unwrap()
            ),
            format!(
                "event: notification\ndata: {}\n\n",
                serde_json::to_string(&foreign).unwrap()
            ),
            format!(
                "event: notification\ndata: {}\n\n",
                serde_json::to_string(&valid).unwrap()
            )
        );
        for byte in stream.as_bytes() {
            sink.emit(&[*byte]).unwrap();
        }
        assert!(sink.ready);
        assert!(sink.emit(&vec![b'x'; 16 * 1024 + 1]).is_err());
    }
    assert_eq!(received.len(), 1);
    assert_eq!(received[0].post["preview"], "🦀 evidence");
    let mut callback = |_| Ok(());
    let mut invalid = NoticeSink {
        watch: &watch,
        receive: &mut callback,
        frame: Vec::new(),
        ready: false,
        previous_cr: false,
    };
    assert!(invalid.emit(b"event: notification\ndata: {}\n\n").is_err());
    let mut utf8 = NoticeSink {
        watch: &watch,
        receive: &mut callback,
        frame: Vec::new(),
        ready: false,
        previous_cr: false,
    };
    assert!(utf8.emit(b"data: \xff\n\n").is_err());
}
#[test]
fn remote_failures_and_cancelled_calls_do_not_read_a_local_board() {
    struct Broken;
    impl HttpClient for Broken {
        fn execute(&self, _: &HttpRequest) -> std::result::Result<HttpResponse, HttpClientError> {
            Err(HttpClientError::Transport("service unavailable".into()))
        }
    }
    let client = RemoteMessageBoard::new(
        Arc::new(Broken),
        "https://board.test",
        AccessToken::new("confidential-board-host-credential-32".into()).unwrap(),
    )
    .unwrap();
    let scope = Scope {
        session: SessionId::new("s").unwrap(),
        root: ThreadId::new("r").unwrap(),
    };
    let source = CancellationSource::new();
    assert!(
        client
            .register_members(&scope, &[scope.root.clone()], &source.token())
            .unwrap_err()
            .to_string()
            .contains("service unavailable")
    );
    source.cancel();
    assert!(
        client
            .register_members(&scope, &[scope.root.clone()], &source.token())
            .is_err()
    );
}
