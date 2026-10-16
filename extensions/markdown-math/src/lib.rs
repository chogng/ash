//! Formula rendering lives in this optional process, never in the shared host.
use ash_utils_markdown_math::Diagnostic;
use ash_utils_markdown_math::Display;
use ash_utils_markdown_math::FormulaResult;
use ash_utils_markdown_math::RenderRequest;
use ash_utils_markdown_math::RenderResponse;
use external_ext_sdk::CancellationToken;
use external_ext_sdk::Extension;
use external_ext_sdk::ExtensionContext;
use external_ext_sdk::ExtensionError;
use external_ext_sdk::HostErrorCode;
use katex::KatexContext;
use katex::Settings;
use katex::TrustSetting;
use katex::macros::MacroDefinition;

#[derive(Default)]
pub struct MathExtension;

impl Extension for MathExtension {
    fn id(&self) -> &str {
        "vscode.markdown-math"
    }

    fn activate(&mut self, context: &mut ExtensionContext) -> Result<(), ExtensionError> {
        context
            .data_channels
            .register(ash_utils_markdown_math::CHANNEL, render)
    }
}

fn render(
    request: RenderRequest,
    token: CancellationToken,
) -> Result<RenderResponse, ExtensionError> {
    token.check_cancelled()?;
    let bytes = request
        .formulas
        .iter()
        .map(|formula| formula.source.len())
        .sum::<usize>()
        + request
            .macros
            .iter()
            .map(|(name, value)| name.len() + value.len())
            .sum::<usize>();
    if request.formulas.len() > 4096 || request.macros.len() > 256 || bytes > 256 * 1024 {
        return Err(ExtensionError::new(
            HostErrorCode::QuotaExceeded,
            "Math render exceeds its input limit",
        ));
    }
    // Settings owns mutable macros. A fresh instance isolates documents and resets
    // definitions on rerender, while formulas within one request share TeX scope.
    let context = KatexContext::default();
    let mut settings = Settings::default();
    settings.global_group = true;
    settings.throw_on_error = true;
    settings.trust = TrustSetting::Bool(false);
    settings.max_expand = 1000;
    settings.max_size = 100.0;
    for (name, value) in request.macros {
        if !name.starts_with('\\') || name.len() > 256 || name.chars().any(char::is_control) {
            return Err(ExtensionError::new(
                HostErrorCode::InvalidRequest,
                "Invalid math macro name",
            ));
        }
        settings
            .macros
            .borrow_mut()
            .insert(name, MacroDefinition::String(value));
    }
    // Reserve a small source result for every formula before admitting rendered HTML.
    // JSON escaping and diagnostics count toward the same complete-response budget.
    let fallback = FormulaResult::Source {
        diagnostic: Diagnostic::OutputLimit {},
    };
    let mut response = RenderResponse {
        results: vec![fallback.clone(); request.formulas.len()],
    };
    let encoding_error =
        |_| ExtensionError::new(HostErrorCode::InvalidRequest, "Invalid math render result");
    let fallback_bytes = serde_json::to_vec(&fallback).map_err(encoding_error)?.len();
    let mut output_bytes = serde_json::to_vec(&response).map_err(encoding_error)?.len();
    const MAX_OUTPUT_BYTES: usize = 512 * 1024;
    if output_bytes > MAX_OUTPUT_BYTES {
        return Err(ExtensionError::new(
            HostErrorCode::QuotaExceeded,
            "Math render exceeds its output limit",
        ));
    }
    for (index, formula) in request.formulas.into_iter().enumerate() {
        token.check_cancelled()?;
        settings.display_mode = match formula.display {
            Display::Inline => false,
            Display::Block => true,
        };
        // Evaluate every formula even when its HTML will not fit: macro definitions
        // must still affect later formulas in this immutable document batch.
        let result = match katex::render_to_string(&context, &formula.source, &settings) {
            Ok(html) => FormulaResult::Rendered { html },
            Err(error) => FormulaResult::Source {
                diagnostic: Diagnostic::InvalidFormula {
                    message: error.to_string().chars().take(512).collect(),
                },
            },
        };
        token.check_cancelled()?;
        let result_bytes = serde_json::to_vec(&result).map_err(encoding_error)?.len();
        let next_bytes = output_bytes - fallback_bytes + result_bytes;
        if next_bytes <= MAX_OUTPUT_BYTES {
            response.results[index] = result;
            output_bytes = next_bytes;
        }
    }
    token.check_cancelled()?;
    Ok(response)
}
