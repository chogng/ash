use external_ext_sdk::CancellationToken;
use external_ext_sdk::ExtensionContext;
use external_ext_sdk::ExtensionError;
use mermaid_svg::Theme;
use serde::Deserialize;
use serde::Serialize;

const CHANNEL: &str = "markdown.mermaid.render.v1";
const MAX_SOURCE_BYTES: usize = 8 * 1024;
const MAX_OUTPUT_BYTES: usize = 128 * 1024;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ColorScheme {
    Light,
    Dark,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    source: String,
    theme: ColorScheme,
}

#[derive(Serialize)]
struct Response {
    svg: Option<String>,
}

pub(super) fn register(context: &mut ExtensionContext) -> Result<(), ExtensionError> {
    context.data_channels.register(CHANNEL, render)
}

fn render(request: Request, token: CancellationToken) -> Result<Response, ExtensionError> {
    token.check_cancelled()?;
    let svg = render_svg(&request.source, request.theme);
    token.check_cancelled()?;
    Ok(Response { svg })
}

fn render_svg(source: &str, scheme: ColorScheme) -> Option<String> {
    // Bound work before parsing. Do not allow thousands of inline statements to
    // bypass the line limit; large diagrams can still be read as source.
    if source.len() > MAX_SOURCE_BYTES
        || source.lines().count() > 128
        || source.bytes().filter(|&byte| byte == b';').count() > 128
    {
        return None;
    }
    let diagram = mermaid_svg::parse(source).ok()?;
    // The product owns the palette. Source front matter cannot override it.
    let mut theme = match scheme {
        ColorScheme::Light => Theme::default_theme(),
        ColorScheme::Dark => Theme::dark(),
    };
    theme.responsive = false;
    let svg = mermaid_svg::render_diagram_with(&diagram, &theme).ok()?;
    (svg.len() <= MAX_OUTPUT_BYTES).then_some(svg)
}

#[cfg(test)]
#[path = "mermaid_tests.rs"]
mod tests;
