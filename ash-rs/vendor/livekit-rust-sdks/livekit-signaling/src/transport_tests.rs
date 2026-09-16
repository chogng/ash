use super::*;
use livekit_net::{
    Header, HttpMethod, HttpResponse, TransportError, WsConnectResult, WsConnection,
};
use prost::Message;

#[derive(Default)]
struct Client {
    urls: std::sync::Mutex<Vec<String>>,
    reject: bool,
}

struct Connection(tokio::sync::Mutex<Option<Vec<u8>>>, tokio::sync::Notify);
#[async_trait::async_trait]
impl WsConnection for Connection {
    async fn send(&self, _: Vec<u8>) -> Result<(), TransportError> {
        Ok(())
    }
    async fn recv(&self) -> Result<Option<Vec<u8>>, TransportError> {
        if let Some(frame) = self.0.lock().await.take() {
            return Ok(Some(frame));
        }
        self.1.notified().await;
        Ok(None)
    }
    async fn close(&self) {
        self.1.notify_one();
    }
}

#[async_trait::async_trait]
impl livekit_net::WsClient for Client {
    async fn connect(
        &self,
        url: String,
        _: Vec<Header>,
        _: u64,
    ) -> Result<WsConnectResult, TransportError> {
        self.urls.lock().unwrap().push(url.clone());
        if self.reject {
            return Err(TransportError::Http { status: 503 });
        }
        let message = if url::Url::parse(&url)
            .unwrap()
            .query_pairs()
            .any(|(key, value)| key == "reconnect" && value == "1")
        {
            proto::signal_response::Message::Reconnect(proto::ReconnectResponse::default())
        } else {
            proto::signal_response::Message::Join(proto::JoinResponse {
                ping_interval: 30,
                ping_timeout: 90,
                participant: Some(proto::ParticipantInfo {
                    sid: "PA_test".into(),
                    ..Default::default()
                }),
                ..Default::default()
            })
        };
        Ok(WsConnectResult {
            connection: Arc::new(Connection(
                tokio::sync::Mutex::new(Some(
                    proto::SignalResponse { message: Some(message) }.encode_to_vec(),
                )),
                tokio::sync::Notify::new(),
            )),
        })
    }
}

#[async_trait::async_trait]
impl livekit_net::HttpClient for Client {
    async fn request(
        &self,
        _: HttpMethod,
        url: String,
        headers: Vec<Header>,
        _: Option<Vec<u8>>,
    ) -> Result<HttpResponse, TransportError> {
        assert!(headers
            .iter()
            .any(|h| h.name.eq_ignore_ascii_case("authorization") && h.value == "Bearer token"));
        let regions = url.contains("settings/regions");
        self.urls.lock().unwrap().push(url);
        Ok(HttpResponse {
            status: if regions { 200 } else { 503 },
            headers: vec![],
            body: if regions { br#"{"regions":[]}"#.to_vec() } else { vec![] },
        })
    }
}

fn options(client: Arc<Client>) -> SignalOptions {
    SignalOptions {
        transport: Some(SignalTransport { websocket: client.clone(), http: client }),
        ..Default::default()
    }
}

#[tokio::test]
async fn configured_transport_survives_reconnect() {
    let transport = Arc::new(Client::default());
    let (client, _, _) =
        SignalClient::connect("ws://localhost:7880", "token", options(transport.clone()), None)
            .await
            .unwrap();
    tokio::time::timeout(Duration::from_secs(2), client.restart()).await.unwrap().unwrap();
    client.set_reconnected().await;
    client.close().await;
    let urls = transport.urls.lock().unwrap();
    assert_eq!(urls.len(), 2);
    assert!(urls[1].contains("reconnect=1"));
}

#[tokio::test]
async fn validation_and_region_discovery_use_the_room_client_without_shared_cache() {
    for _ in 0..2 {
        let transport = Arc::new(Client { reject: true, ..Default::default() });
        assert!(SignalClient::connect(
            "wss://scope.livekit.cloud",
            "token",
            options(transport.clone()),
            None
        )
        .await
        .is_err());
        let urls = transport.urls.lock().unwrap();
        assert_eq!(urls.len(), 3, "{urls:?}");
        assert!(urls[0].starts_with("wss://"));
        assert!(urls[1].contains("/rtc/validate"));
        assert!(urls[2].contains("/settings/regions"));
    }
}
