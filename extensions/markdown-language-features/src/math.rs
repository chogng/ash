//! Markdown supplies formula order and configuration; the math extension owns rendering.
use ash_utils_markdown_math::Formula;
use ash_utils_markdown_math::RenderRequest;
use ash_utils_markdown_math::RenderResponse;
use external_ext_sdk::CancellationToken;
use external_ext_sdk::ExtensionError;
use external_ext_sdk::HostErrorCode;
use external_ext_sdk::client::Client;
use serde_json::Value;

pub(crate) fn enabled(configuration: &Value) -> bool {
    configuration
        .pointer("/math/enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

pub(crate) fn render(
    client: &Client,
    formulas: Vec<Formula>,
    configuration: &Value,
    token: &CancellationToken,
) -> Result<Option<Vec<String>>, ExtensionError> {
    if formulas.is_empty() {
        return Ok(Some(Vec::new()));
    }
    let count = formulas.len();
    let macros = configuration
        .pointer("/math/macros")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| super::invalid("Invalid math macro configuration"))?
        .unwrap_or_default();
    let request = serde_json::to_value(RenderRequest { formulas, macros })
        .map_err(|_| super::invalid("Invalid math render request"))?;
    match client.request_backend(
        ash_utils_markdown_math::CHANNEL,
        "receiveData",
        request,
        token,
    ) {
        Ok(value) => {
            let response: RenderResponse = serde_json::from_value(value)
                .map_err(|_| super::invalid("Invalid math render response"))?;
            if response.html.len() != count {
                return Err(super::invalid(
                    "Math render result count differs from request",
                ));
            }
            Ok(Some(response.html))
        }
        // An unavailable optional provider leaves visible formula source. Never
        // start a second implementation, or convert cancellation into a fallback.
        Err(error)
            if matches!(
                error.code,
                HostErrorCode::Cancelled | HostErrorCode::DeadlineExceeded
            ) =>
        {
            Err(error)
        }
        Err(_) => Ok(None),
    }
}
