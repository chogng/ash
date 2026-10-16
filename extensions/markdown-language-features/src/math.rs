//! Markdown supplies formula order and configuration; the math extension owns rendering.
use ash_utils_markdown_math::Diagnostic;
use ash_utils_markdown_math::Formula;
use ash_utils_markdown_math::FormulaResult;
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
    messages: &Value,
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
    let request = RenderRequest { formulas, macros };
    let payload = serde_json::to_value(&request)
        .map_err(|_| super::invalid("Invalid math render request"))?;
    match client.request_backend(
        ash_utils_markdown_math::CHANNEL,
        "receiveData",
        payload,
        token,
    ) {
        Ok(value) => {
            let response: RenderResponse = serde_json::from_value(value)
                .map_err(|_| super::invalid("Invalid math render response"))?;
            if response.results.len() != count {
                return Err(super::invalid(
                    "Math render result count differs from request",
                ));
            }
            Ok(Some(
                response
                    .results
                    .into_iter()
                    .zip(&request.formulas)
                    .map(|(result, formula)| match result {
                        FormulaResult::Rendered { html } => html,
                        FormulaResult::Source { diagnostic } => {
                            source_html(&formula.source, &diagnostic, messages)
                        }
                    })
                    .collect(),
            ))
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

/// Consumers own source presentation and localization; the provider returns only structured outcomes.
fn source_html(source: &str, diagnostic: &Diagnostic, messages: &Value) -> String {
    let (code, title) = match diagnostic {
        Diagnostic::InvalidFormula { message } => (
            "invalidFormula",
            format!(
                "{}\n{message}",
                messages["markdown.math.invalidFormula"]
                    .as_str()
                    .unwrap_or_default()
            ),
        ),
        Diagnostic::OutputLimit {} => (
            "outputLimit",
            messages["markdown.math.outputLimit"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
        ),
    };
    let escape = |text: &str| {
        text.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
    };
    format!(
        "<span data-math-diagnostic=\"{code}\" title=\"{}\">{}</span>",
        escape(&title),
        escape(source)
    )
}
