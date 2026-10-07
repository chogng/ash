use crate::NetworkProtocol;
use crate::NetworkRequest;
use crate::server::Context;
use crate::server::HANDSHAKE_TIMEOUT;
use bytes::Bytes;
use http_body_util::BodyExt;
use http_body_util::Full;
use http_body_util::combinators::UnsyncBoxBody;
use hyper::Method;
use hyper::Request;
use hyper::Response;
use hyper::StatusCode;
use hyper::body::Incoming;
use hyper::header::HeaderMap;
use hyper::header::HeaderName;
use hyper::header::HeaderValue;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use hyper_util::rt::TokioTimer;
use std::convert::Infallible;
use std::io;
use std::sync::Arc;
use tokio::net::TcpStream;
use tokio::sync::OwnedSemaphorePermit;

type Error = Box<dyn std::error::Error + Send + Sync>;
type Body = UnsyncBoxBody<Bytes, Error>;

pub(crate) async fn serve(
    stream: TcpStream,
    context: Arc<Context>,
    permit: Arc<OwnedSemaphorePermit>,
) {
    let cancellation = context.cancellation.clone();
    let service = service_fn(move |request| {
        let context = Arc::clone(&context);
        let permit = Arc::clone(&permit);
        async move { Ok::<_, Infallible>(forward(request, context, permit).await) }
    });
    let mut builder = hyper::server::conn::http1::Builder::new();
    builder
        .timer(TokioTimer::new())
        .header_read_timeout(HANDSHAKE_TIMEOUT)
        .max_buf_size(32 * 1024);
    let connection = builder
        .serve_connection(TokioIo::new(stream), service)
        .with_upgrades();
    tokio::select! {
        _ = cancellation.cancelled() => {},
        _ = connection => {},
    }
}

async fn forward(
    mut request: Request<Incoming>,
    context: Arc<Context>,
    permit: Arc<OwnedSemaphorePermit>,
) -> Response<Body> {
    let target = match target(&request) {
        Ok(target) => target,
        Err(_) => return error_response(StatusCode::BAD_REQUEST, "invalid proxy request"),
    };
    let authority = target.authority();
    let upstream = match context.connect(target).await {
        Ok(upstream) => upstream,
        Err(error) => {
            return error_response(
                if error.kind() == io::ErrorKind::PermissionDenied {
                    StatusCode::FORBIDDEN
                } else {
                    StatusCode::BAD_GATEWAY
                },
                &error.to_string(),
            );
        }
    };
    if request.method() == Method::CONNECT {
        tokio::spawn(async move {
            let _permit = permit;
            if let Ok(upgraded) = hyper::upgrade::on(request).await {
                crate::server::tunnel(TokioIo::new(upgraded), upstream, context).await;
            }
        });
        return Response::new(full(""));
    }
    let (mut sender, connection) =
        match hyper::client::conn::http1::handshake(TokioIo::new(upstream)).await {
            Ok(connection) => connection,
            Err(_) => return error_response(StatusCode::BAD_GATEWAY, "upstream handshake failed"),
        };
    let cancellation = context.cancellation.clone();
    tokio::spawn(async move {
        let _permit = permit;
        tokio::select! {
            _ = cancellation.cancelled() => {},
            _ = connection => {},
        }
    });
    let path = request
        .uri()
        .path_and_query()
        .map(|path| path.as_str())
        .unwrap_or("/");
    *request.uri_mut() = path.parse().expect("validated HTTP path");
    strip_hop_headers(request.headers_mut());
    request.headers_mut().insert(
        hyper::header::HOST,
        HeaderValue::from_str(&authority).expect("validated authority"),
    );
    // One upstream connection per request keeps authority and redirect checks at the proxy.
    request
        .headers_mut()
        .insert(hyper::header::CONNECTION, HeaderValue::from_static("close"));
    match sender.send_request(request).await {
        Ok(mut response) => {
            strip_hop_headers(response.headers_mut());
            response.map(|body| {
                body.map_err(|error| -> Error { Box::new(error) })
                    .boxed_unsync()
            })
        }
        Err(_) => error_response(StatusCode::BAD_GATEWAY, "upstream request failed"),
    }
}

fn target(request: &Request<Incoming>) -> io::Result<NetworkRequest> {
    let uri = request.uri();
    if request.method() == Method::CONNECT {
        if uri.scheme().is_some()
            || request
                .headers()
                .contains_key(hyper::header::TRANSFER_ENCODING)
            || request
                .headers()
                .get(hyper::header::CONTENT_LENGTH)
                .is_some_and(|value| value != "0")
        {
            return Err(invalid());
        }
        let authority = uri.authority().ok_or_else(invalid)?;
        if authority.as_str().contains('@') {
            return Err(invalid());
        }
        return NetworkRequest::new(
            NetworkProtocol::HttpsConnect,
            authority.host(),
            authority.port_u16().ok_or_else(invalid)?,
        );
    }
    if uri.scheme_str() != Some("http") || request.headers().contains_key(hyper::header::UPGRADE) {
        return Err(invalid());
    }
    let authority = uri.authority().ok_or_else(invalid)?;
    if authority.as_str().contains('@')
        || (authority.port().is_some() && authority.port_u16().is_none())
    {
        return Err(invalid());
    }
    NetworkRequest::new(
        NetworkProtocol::Http,
        authority.host(),
        authority.port_u16().unwrap_or(80),
    )
    .map(|target| target.with_method(request.method().as_str()))
}

fn strip_hop_headers(headers: &mut HeaderMap) {
    let named = headers
        .get_all(hyper::header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .filter_map(|name| HeaderName::from_bytes(name.trim().as_bytes()).ok())
        .collect::<Vec<_>>();
    for name in named {
        headers.remove(name);
    }
    for name in [
        "connection",
        "proxy-connection",
        "proxy-authorization",
        "proxy-authenticate",
        "keep-alive",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    ] {
        headers.remove(name);
    }
}

fn full(value: &str) -> Body {
    Full::new(Bytes::copy_from_slice(value.as_bytes()))
        .map_err(|never| match never {})
        .boxed_unsync()
}

fn error_response(status: StatusCode, message: &str) -> Response<Body> {
    let mut response = Response::new(full(message));
    *response.status_mut() = status;
    response.headers_mut().insert(
        "x-proxy-error",
        HeaderValue::from_static(if status == StatusCode::FORBIDDEN {
            "blocked-by-policy"
        } else {
            "proxy-request-failed"
        }),
    );
    response
}

fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "invalid proxy authority")
}
