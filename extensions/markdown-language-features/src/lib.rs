//! Markdown documents and language features run in this optional Rust extension;
//! formulas use the independent math capability. Models and history belong to the client.
mod language;
mod math;
mod parser;

use external_ext_sdk::Command;
use external_ext_sdk::Extension;
use external_ext_sdk::ExtensionContext;
use external_ext_sdk::ExtensionError;
use external_ext_sdk::HostErrorCode;
use external_ext_sdk::editors::Content;
use external_ext_sdk::editors::Resources;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;

#[derive(Default)]
pub struct MarkdownExtension;

pub(crate) fn invalid(message: &str) -> ExtensionError {
    ExtensionError::new(HostErrorCode::InvalidRequest, message)
}

impl Extension for MarkdownExtension {
    fn id(&self) -> &str {
        "ash.markdown-language-features"
    }

    fn activate(&mut self, context: &mut ExtensionContext) -> Result<(), ExtensionError> {
        let chinese = context
            .initialization()
            .and_then(|facts| facts.language.as_deref())
            == Some("zh-CN");
        let messages: Value = serde_json::from_str(if chinese {
            include_str!("../package.nls.zh-CN.json")
        } else {
            include_str!("../package.nls.json")
        })
        .map_err(|_| invalid("Invalid Markdown messages"))?;
        let manifest: Value = serde_json::from_str(include_str!("../package.json"))
            .map_err(|_| invalid("Invalid Markdown manifest"))?;
        for declaration in manifest["contributes"]["commands"]
            .as_array()
            .ok_or_else(|| invalid("Missing Markdown commands"))?
        {
            let id = declaration["command"]
                .as_str()
                .ok_or_else(|| invalid("Invalid Markdown command"))?
                .to_owned();
            let title = declaration["title"]
                .as_str()
                .unwrap_or("")
                .trim_matches('%');
            let mut command = Command::new(id.clone(), messages[title].as_str().unwrap_or(title));
            // VS Code manifests spell theme icons as `$(id)`; SDK command
            // registrations carry the bare product icon ID consumed by the host.
            command.icon = declaration["icon"]
                .as_str()
                .and_then(|icon| {
                    icon.strip_prefix("$(")
                        .and_then(|icon| icon.strip_suffix(')'))
                })
                .map(str::to_owned);
            if let Some(menus) = manifest["contributes"]["menus"].as_object() {
                for (menu, entries) in menus {
                    for entry in entries
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|entry| entry["command"] == id)
                    {
                        command.menus.push(external_ext_sdk::CommandMenu {
                            menu: menu.clone(),
                            when: entry["when"].as_str().map(str::to_owned),
                            group: entry["group"].as_str().map(str::to_owned),
                            alt: entry["alt"].as_str().map(str::to_owned),
                        });
                    }
                }
            }
            let client = context.client.clone();
            context.commands.register_command(command, move |call, token| {
                let Some(editor) = call.active_editor else { return Ok(Value::Null); };
                let view = if id.ends_with("AsSource") || id == "markdown.showSource" {
                    "default"
                } else if id.contains("RichEditor") {
                    "vscode.markdown.editor"
                } else {
                    "vscode.markdown.preview.editor"
                };
                if id.contains("reopenAs") {
                    client.execute_command("reopenActiveEditorWith", vec![json!(view), json!({"groupId":editor["groupId"],"editorIndex":editor["editorIndex"]})], &token)
                } else {
                    client.execute_command("_workbench.openWith", vec![editor["resource"].clone(), json!(view), json!([if id.ends_with("ToSide") { -2 } else { -1 }]), editor["groupId"].clone()], &token)
                }
            })?;
        }
        let messages = Arc::new(messages);
        for editor in manifest["contributes"]["customEditors"]
            .as_array()
            .ok_or_else(|| invalid("Missing Markdown editors"))?
        {
            let view = editor["viewType"]
                .as_str()
                .ok_or_else(|| invalid("Invalid Markdown editor"))?
                .to_owned();
            let title = editor["displayName"]
                .as_str()
                .unwrap_or("")
                .trim_matches('%');
            let selectors = editor["selector"]
                .as_array()
                .ok_or_else(|| invalid("Missing Markdown selectors"))?
                .iter()
                .map(|selector| {
                    selector["filenamePattern"]
                        .as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| invalid("Invalid Markdown selector"))
                })
                .collect::<Result<Vec<_>, _>>()?;
            let messages = Arc::clone(&messages);
            let client = context.client.clone();
            let rich = view == "vscode.markdown.editor";
            context.editors.register_custom_text_editor(view, messages[title].as_str().unwrap_or(title).to_owned(), selectors, "option".into(), move |document, token| {
                token.check_cancelled()?;
                let configuration = client.get_configuration("markdown", Some(document.uri.clone()), &token)?;
                if rich {
                    let mut parsed = parser::parse_checked(&document.text, math::enabled(&configuration), || token.check_cancelled())?;
                    parsed.render_math(&client, &configuration, &messages, &token)?;
                    let labels: serde_json::Map<String,Value> = messages.as_object().into_iter().flatten().filter_map(|(key,value)| key.strip_prefix("markdown.rich.").map(|key| (key.into(),value.clone()))).collect();
                    let bootstrap = json!({"uri":document.uri,"text":"","version":0,"readOnly":true,"messages":labels}).to_string().replace('<', "\\u003c");
                    Ok(Content {
                        editable: true,
                        html: format!("<script type=\"application/json\" id=\"ash-markdown-initial\">{bootstrap}</script>"),
                        update: Some(json!({"type":"document","uri":document.uri,"text":document.text,"version":document.version,"readOnly":document.read_only,"blocks":parsed.blocks})),
                        resources: Some(Resources { script: "media/richEditor.js".into(), style: "media/richEditor.css".into() }),
                    })
                } else {
                    Ok(Content {
                        html: "<main id=\"markdown-preview\"></main>".into(),
                        editable: false,
                        update: Some(json!({"type":"preview","html":preview(&document.text, &configuration, &messages, &client, &token)?})),
                        resources: Some(Resources { script: "media/preview.js".into(), style: "media/preview.css".into() }),
                    })
                }
            })?;
        }
        language::register(context, chinese)
    }
}

fn preview(
    text: &str,
    configuration: &Value,
    messages: &Value,
    client: &external_ext_sdk::client::Client,
    token: &external_ext_sdk::CancellationToken,
) -> Result<String, ExtensionError> {
    use pulldown_cmark::Event;
    use pulldown_cmark::Tag;
    use pulldown_cmark::TagEnd;
    if text.len() > 16 * 1024 * 1024 {
        return Err(invalid("Markdown source exceeds its limit"));
    }
    let mut events = Vec::new();
    let mut heading: Option<(usize, String)> = None;
    let mut slugs = language::HeadingIds::default();
    let mut metadata = false;
    let math_enabled = math::enabled(configuration);
    let breaks = configuration
        .pointer("/preview/breaks")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut fence: Option<String> = None;
    let source = parser::MathSource::new(text, math_enabled, &|| token.check_cancelled())?;
    for (event, range) in source.events(parser::markdown_options()) {
        token.check_cancelled()?;
        if let Some(source) = &mut fence {
            match event {
                Event::End(TagEnd::CodeBlock) => {
                    events.push(Event::DisplayMath(
                        fence.take().unwrap().trim().to_owned().into(),
                    ));
                }
                Event::Text(value) => source.push_str(&value),
                _ => {}
            }
            continue;
        }
        if matches!(&event, Event::Start(Tag::CodeBlock(pulldown_cmark::CodeBlockKind::Fenced(info))) if math_enabled && info.split_whitespace().next() == Some("math") && parser::complete_math_fence(text, &range))
        {
            fence = Some(String::new());
            continue;
        }
        match &event {
            Event::Start(Tag::MetadataBlock(_)) => {
                metadata = true;
                continue;
            }
            Event::End(TagEnd::MetadataBlock(_)) => {
                metadata = false;
                continue;
            }
            _ if metadata => continue,
            Event::Start(Tag::Heading { .. }) => heading = Some((events.len(), String::new())),
            Event::Text(text) | Event::Code(text) | Event::InlineMath(text) => {
                if let Some((_, title)) = &mut heading {
                    title.push_str(text);
                }
            }
            Event::End(TagEnd::Heading(_)) => {
                if let Some((index, title)) = heading.take() {
                    let slug = slugs.insert(&title);
                    if let Event::Start(Tag::Heading { id, attrs, .. }) = &mut events[index] {
                        *id = Some(slug.into());
                        attrs.push(("tabindex".into(), Some("-1".into())));
                    }
                }
            }
            _ => {}
        }
        if let Some(event) = match event {
            Event::Html(_) | Event::InlineHtml(_) => None,
            Event::SoftBreak if breaks => Some(Event::HardBreak),
            other => Some(other),
        } {
            events.push(event);
        }
    }
    let mut html = String::new();
    let formulas = events
        .iter()
        .filter_map(|event| match event {
            Event::InlineMath(source) => Some(ash_utils_markdown_math::Formula {
                source: source.to_string(),
                display: ash_utils_markdown_math::Display::Inline,
            }),
            Event::DisplayMath(source) => Some(ash_utils_markdown_math::Formula {
                source: source.to_string(),
                display: ash_utils_markdown_math::Display::Block,
            }),
            _ => None,
        })
        .collect();
    let mut rendered = math::render(client, formulas, configuration, messages, token)?
        .unwrap_or_default()
        .into_iter();
    pulldown_cmark::html::push_html(
        &mut html,
        events.into_iter().map(|event| match event {
            Event::InlineMath(value) => rendered
                .next()
                .map(|html| rendered_math_html(&html, false))
                .unwrap_or_else(|| math_html(&value, false)),
            Event::DisplayMath(value) => rendered
                .next()
                .map(|html| rendered_math_html(&html, true))
                .unwrap_or_else(|| math_html(&value, true)),
            other => other,
        }),
    );
    token.check_cancelled()?;
    Ok(html)
}

fn rendered_math_html(html: &str, display: bool) -> pulldown_cmark::Event<'static> {
    let display = if display { "block" } else { "inline" };
    pulldown_cmark::Event::Html(
        format!("<span class=\"ash-markdown-math\" data-math-display=\"{display}\">{html}</span>")
            .into(),
    )
}

fn math_html(value: &str, display: bool) -> pulldown_cmark::Event<'static> {
    let escaped = value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;");
    pulldown_cmark::Event::Html(
        format!("<span class=\"ash-markdown-math\" data-math=\"{escaped}\" data-display=\"{display}\" data-math-display=\"{}\">{escaped}</span>", if display { "block" } else { "inline" }).into(),
    )
}
