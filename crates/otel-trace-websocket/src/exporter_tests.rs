use super::AccessToken;
use super::Exporter;
use futures::StreamExt;
use opentelemetry::Context;
use opentelemetry::KeyValue;
use opentelemetry::trace::Span;
use opentelemetry::trace::TraceContextExt;
use opentelemetry::trace::Tracer;
use opentelemetry::trace::TracerProvider;
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::trace::SdkTracerProvider;
use opentelemetry_sdk::trace::SpanExporter;
use serde_json::Value;
use std::net::SocketAddr;
use std::time::Duration;
use std::time::UNIX_EPOCH;
use tokio::net::TcpStream;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

pub(super) const TOKEN: &str = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
type Socket = WebSocketStream<TcpStream>;

pub(super) fn exporter() -> Exporter {
    Exporter::bind("127.0.0.1:0".parse().unwrap(), TOKEN.parse().unwrap()).unwrap()
}

async fn connect(address: SocketAddr) -> Socket {
    let stream = TcpStream::connect(address).await.unwrap();
    let mut request = format!("ws://{address}/").into_client_request().unwrap();
    request
        .headers_mut()
        .insert("authorization", format!("Bearer {TOKEN}").parse().unwrap());
    let (mut socket, _) = tokio_tungstenite::client_async(request, stream)
        .await
        .unwrap();
    assert_eq!(
        read(&mut socket).await,
        serde_json::json!({"type":"ready","version":2,"format":"otlp-json"})
    );
    socket
}

async fn read(socket: &mut Socket) -> Value {
    let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    serde_json::from_str(message.to_text().unwrap()).unwrap()
}

#[tokio::test]
async fn sdk_streams_parent_ids_timing_and_typed_attributes_to_all_viewers() {
    let exporter = exporter();
    let mut first = connect(exporter.local_addr()).await;
    let mut second = connect(exporter.local_addr()).await;
    let provider = SdkTracerProvider::builder()
        .with_resource(
            Resource::builder_empty()
                .with_attribute(KeyValue::new("service.name", "test"))
                .build(),
        )
        .with_simple_exporter(exporter)
        .build();
    let tracer = provider.tracer("test-scope");
    let parent = tracer.start("parent");
    let parent_id = parent.span_context().span_id().to_string();
    let trace_id = parent.span_context().trace_id().to_string();
    let context = Context::new().with_span(parent);
    let mut span = tracer
        .span_builder("child")
        .with_start_time(UNIX_EPOCH + Duration::from_nanos(1_700_000_000_000_000_100))
        .with_attributes([
            KeyValue::new("integer", i64::MAX),
            KeyValue::new("enabled", true),
        ])
        .with_status(opentelemetry::trace::Status::error("failed"))
        .start_with_context(&tracer, &context);
    span.add_event("event", vec![KeyValue::new("message", "value")]);
    span.end_with_timestamp(UNIX_EPOCH + Duration::from_nanos(1_700_000_000_000_004_300));
    provider.force_flush().unwrap();
    let frame = read(&mut first).await;
    assert_eq!(frame, read(&mut second).await);
    let resource = &frame["resourceSpans"][0];
    assert_eq!(
        resource["resource"]["attributes"][0]["value"]["stringValue"],
        "test"
    );
    assert_eq!(resource["scopeSpans"][0]["scope"]["name"], "test-scope");
    let frame = &resource["scopeSpans"][0]["spans"][0];
    assert_eq!(frame["traceId"], trace_id);
    assert_eq!(frame["parentSpanId"], parent_id);
    assert_eq!(frame["name"], "child");
    assert_eq!(frame["startTimeUnixNano"], "1700000000000000100");
    assert_eq!(frame["endTimeUnixNano"], "1700000000000004300");
    assert_eq!(
        frame["attributes"][0]["value"],
        serde_json::json!({"intValue": i64::MAX.to_string()})
    );
    assert_eq!(frame["attributes"][1]["value"]["boolValue"], true);
    assert_eq!(frame["events"][0]["name"], "event");
    assert_eq!(frame["status"]["message"], "failed");
    assert_eq!(frame["status"]["code"], 2);
}

#[tokio::test]
async fn connections_start_at_live_tail_without_replay() {
    let exporter = exporter();
    let address = exporter.local_addr();
    let provider = SdkTracerProvider::builder()
        .with_simple_exporter(exporter)
        .build();
    let tracer = provider.tracer("test");
    tracer.start("before-connect").end();
    let mut first = connect(address).await;
    tracer.start("first").end();
    assert_eq!(
        read(&mut first).await["resourceSpans"][0]["scopeSpans"][0]["spans"][0]["name"],
        "first"
    );
    drop(first);
    tracer.start("before-reconnect").end();
    let mut second = connect(address).await;
    tracer.start("second").end();
    assert_eq!(
        read(&mut second).await["resourceSpans"][0]["scopeSpans"][0]["spans"][0]["name"],
        "second"
    );
}

#[tokio::test]
async fn shutdown_closes_listener_active_connections_and_incomplete_handshakes() {
    let mut exporter = exporter();
    let address = exporter.local_addr();
    let mut viewer = connect(address).await;
    let handshake = TcpStream::connect(address).await.unwrap();
    exporter.shutdown().unwrap();
    tokio::time::timeout(Duration::from_secs(5), handshake.readable())
        .await
        .unwrap()
        .unwrap();
    let pending = handshake.try_read(&mut [0]);
    assert!(
        matches!(pending, Ok(0))
            || pending.is_err_and(|error| error.kind() == std::io::ErrorKind::ConnectionReset)
    );
    assert!(TcpStream::connect(address).await.is_err());
    let closed = tokio::time::timeout(Duration::from_secs(5), viewer.next())
        .await
        .unwrap();
    assert!(closed.is_none() || closed.unwrap().is_err());
    assert!(matches!(
        exporter.export(Vec::new()).await,
        Err(opentelemetry_sdk::error::OTelSdkError::AlreadyShutdown)
    ));
}

#[tokio::test]
async fn last_exporter_drop_stops_the_listener() {
    let first = exporter();
    let second = first.clone();
    let address = first.local_addr();
    drop(first);
    let _viewer = connect(address).await;
    drop(second);
    assert!(TcpStream::connect(address).await.is_err());
}

#[test]
fn token_debug_and_configuration_errors_do_not_disclose_the_secret() {
    let token: AccessToken = TOKEN.parse().unwrap();
    assert!(!format!("{token:?}").contains(TOKEN));
    for invalid in ["", "short-secret", &"é".repeat(32), &"z".repeat(64)] {
        assert!(
            !invalid
                .parse::<AccessToken>()
                .unwrap_err()
                .to_string()
                .contains("short-secret")
        );
    }
    assert!(Exporter::bind("0.0.0.0:0".parse().unwrap(), token).is_err());
}
