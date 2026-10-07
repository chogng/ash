use super::*;
use crate::AccessToken;
use agent_message_board::BoardNotification;
use agent_message_board::Scope;
use http_client::HttpBodySink;
use http_client::HttpClient;
use http_client::HttpClientError;
use http_client::HttpRequest;
use http_client::HttpResponse;
use protocol::SessionId;
use protocol::ThreadId;
use protocol::TurnId;
use std::sync::mpsc;

struct Host(Scope);
impl NotificationHost for Host {
    fn members(&self, _: &ThreadId) -> agent_message_board::Result<(Scope, Vec<ThreadId>)> {
        Ok((self.0.clone(), vec![self.0.root.clone()]))
    }
    fn accept(&self, _: BoardNotification) -> agent_message_board::Result<bool> {
        Ok(true)
    }
}
struct Transport {
    opened: mpsc::Sender<NotificationWatch>,
    closed: mpsc::Sender<TurnId>,
}
impl HttpClient for Transport {
    fn execute(&self, _: &HttpRequest) -> Result<HttpResponse, HttpClientError> {
        Ok(HttpResponse::new(
            200,
            vec![],
            b"\"registered-board-tree-credential-32\"".to_vec(),
        ))
    }
    fn execute_streaming_with_cancellation(
        &self,
        request: &HttpRequest,
        token: &async_utils::CancellationToken,
        sink: &mut dyn HttpBodySink,
    ) -> Result<HttpResponse, HttpClientError> {
        let watch: NotificationWatch = serde_json::from_slice(request.body()).unwrap();
        sink.emit(b"event: ready\ndata: {}\n\n")?;
        self.opened.send(watch.clone()).unwrap();
        while !token.is_cancelled() {
            std::thread::sleep(Duration::from_millis(10));
        }
        self.closed.send(watch.turn_id).unwrap();
        Err(HttpClientError::Transport("cancelled".into()))
    }
}
#[test]
fn committed_turn_lifecycle_cancels_receivers_before_the_next_turn() {
    let scope = Scope {
        session: SessionId::new("s").unwrap(),
        root: ThreadId::new("r").unwrap(),
    };
    let (opened, opening) = mpsc::channel();
    let (closed, closing) = mpsc::channel();
    let board = Arc::new(
        RemoteMessageBoard::new(
            Arc::new(Transport { opened, closed }),
            "https://boards.test",
            AccessToken::new("host-administrator-credential-32-bytes".into()).unwrap(),
        )
        .unwrap(),
    );
    let mut builder = ExtensionRegistryBuilder::new();
    install_notifications(&mut builder, Arc::new(Host(scope.clone())), board);
    let registry = builder.build();
    let current = TurnId::new("current").unwrap();
    let context = ThreadContext {
        session_id: &scope.session,
        thread_id: &scope.root,
        sequence: 1,
    };
    registry.thread_changed(context, &ThreadLifecycle::TurnStarted(current.clone()));
    assert_eq!(
        opening
            .recv_timeout(Duration::from_secs(3))
            .unwrap()
            .turn_id,
        current
    );
    registry.thread_changed(context, &ThreadLifecycle::TurnCompleted(current.clone()));
    assert_eq!(
        closing.recv_timeout(Duration::from_secs(3)).unwrap(),
        current
    );
    let next = TurnId::new("next").unwrap();
    registry.thread_changed(context, &ThreadLifecycle::TurnStarted(next.clone()));
    assert_eq!(
        opening
            .recv_timeout(Duration::from_secs(3))
            .unwrap()
            .turn_id,
        next
    );
    registry.thread_changed(context, &ThreadLifecycle::TurnInterrupted(next.clone()));
    assert_eq!(closing.recv_timeout(Duration::from_secs(3)).unwrap(), next);
    // Registry shutdown retires every remaining Turn-owned receiver as well.
    registry.thread_changed(context, &ThreadLifecycle::TurnStarted(next.clone()));
    assert_eq!(
        opening
            .recv_timeout(Duration::from_secs(3))
            .unwrap()
            .turn_id,
        next
    );
    drop(registry);
    assert_eq!(closing.recv_timeout(Duration::from_secs(3)).unwrap(), next);
}
