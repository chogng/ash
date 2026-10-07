use otel_trace_websocket::AccessToken;
use otel_trace_websocket::Exporter;
use std::ffi::OsString;

pub(crate) fn from_environment() -> Result<Option<Exporter>, String> {
    let exporter = configured(
        std::env::var_os("ASH_TRACE_WEBSOCKET_ADDR"),
        std::env::var_os("ASH_TRACE_WEBSOCKET_TOKEN"),
    )?;
    if let Some(exporter) = &exporter {
        eprintln!("Ash trace WebSocket: ws://{}/", exporter.local_addr());
    }
    Ok(exporter)
}

fn configured(
    address: Option<OsString>,
    token: Option<OsString>,
) -> Result<Option<Exporter>, String> {
    let (address, token) = match (address, token) {
        (None, None) => return Ok(None),
        (Some(address), Some(token)) => (address, token),
        _ => {
            return Err(
                "ASH_TRACE_WEBSOCKET_ADDR and ASH_TRACE_WEBSOCKET_TOKEN must be set together"
                    .into(),
            );
        }
    };
    let address = address
        .to_str()
        .and_then(|text| text.parse().ok())
        .ok_or("ASH_TRACE_WEBSOCKET_ADDR must be a numeric loopback IP:port")?;
    let token: AccessToken = token
        .to_str()
        .ok_or("trace token must be hexadecimal")?
        .parse()
        .map_err(|error: std::io::Error| error.to_string())?;
    Exporter::bind(address, token)
        .map(Some)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
#[path = "trace_tests.rs"]
mod tests;
