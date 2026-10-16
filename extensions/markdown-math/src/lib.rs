//! Formula rendering lives in this optional process, never in the shared host.
use ash_utils_markdown_math::Display;
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
    settings.throw_on_error = false;
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
    let mut html = Vec::with_capacity(request.formulas.len());
    let mut output_bytes = 0;
    for formula in request.formulas {
        token.check_cancelled()?;
        settings.display_mode = match formula.display {
            Display::Inline => false,
            Display::Block => true,
        };
        let rendered =
            katex::render_to_string(&context, &formula.source, &settings).map_err(|_| {
                ExtensionError::new(HostErrorCode::InvalidRequest, "Invalid math formula")
            })?;
        output_bytes += rendered.len();
        // Leave room for JSON escaping and the host envelope within the SDK quota.
        if output_bytes > 512 * 1024 {
            return Err(ExtensionError::new(
                HostErrorCode::QuotaExceeded,
                "Math render exceeds its output limit",
            ));
        }
        html.push(rendered);
    }
    token.check_cancelled()?;
    Ok(RenderResponse { html })
}
