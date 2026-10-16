//! Markdown policy and rendering run in one optional Rust extension. Editor models,
//! syntax trees, history and persistence remain owned by the client.
mod language;
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
        "vscode.markdown-language-features"
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
            command.icon = declaration["icon"].as_str().map(str::to_owned);
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
                if rich {
                    let parsed = parser::parse_checked(&document.text, || token.check_cancelled())?;
                    let labels: serde_json::Map<String,Value> = messages.as_object().into_iter().flatten().filter_map(|(key,value)| key.strip_prefix("markdown.rich.").map(|key| (key.into(),value.clone()))).collect();
                    let bootstrap = json!({"uri":document.uri,"text":"","version":0,"readOnly":true,"messages":labels}).to_string().replace('<', "\\u003c");
                    Ok(Content {
                        editable: true,
                        html: format!("<script type=\"application/json\" id=\"ash-markdown-initial\">{bootstrap}</script>"),
                        update: Some(json!({"type":"document","uri":document.uri,"text":document.text,"version":document.version,"readOnly":document.read_only,"blocks":parsed.blocks})),
                        resources: Some(Resources { script: "media/richEditor.js".into(), style: "media/richEditor.css".into() }),
                    })
                } else {
                    let configuration = client.get_configuration("markdown", Some(document.uri.clone()), &token)?;
                    Ok(Content {
                        html: "<main id=\"markdown-preview\"></main>".into(),
                        editable: false,
                        update: Some(json!({"type":"preview","html":preview(&document.text, configuration.pointer("/preview/breaks").and_then(Value::as_bool).unwrap_or(false), &token)?})),
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
    breaks: bool,
    token: &external_ext_sdk::CancellationToken,
) -> Result<String, ExtensionError> {
    use pulldown_cmark::Event;
    use pulldown_cmark::Options;
    use pulldown_cmark::Parser;
    use pulldown_cmark::Tag;
    use pulldown_cmark::TagEnd;
    if text.len() > 16 * 1024 * 1024 {
        return Err(invalid("Markdown source exceeds its limit"));
    }
    let mut events = Vec::new();
    let mut heading: Option<(usize, String)> = None;
    let mut slugs = std::collections::BTreeSet::new();
    let mut metadata = false;
    for event in Parser::new_ext(
        text,
        Options::ENABLE_TABLES
            | Options::ENABLE_STRIKETHROUGH
            | Options::ENABLE_TASKLISTS
            | Options::ENABLE_MATH
            | Options::ENABLE_YAML_STYLE_METADATA_BLOCKS
            | Options::ENABLE_PLUSES_DELIMITED_METADATA_BLOCKS,
    ) {
        token.check_cancelled()?;
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
                    let base = language::slug(&title);
                    let mut slug = base.clone();
                    let mut count = 1;
                    while !slugs.insert(slug.clone()) {
                        slug = format!("{base}-{count}");
                        count += 1;
                    }
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
            Event::InlineMath(value) => Some(math_html(&value, false)),
            Event::DisplayMath(value) => Some(math_html(&value, true)),
            Event::SoftBreak if breaks => Some(Event::HardBreak),
            other => Some(other),
        } {
            events.push(event);
        }
    }
    let mut html = String::new();
    pulldown_cmark::html::push_html(&mut html, events.into_iter());
    token.check_cancelled()?;
    Ok(html)
}

fn math_html(value: &str, display: bool) -> pulldown_cmark::Event<'static> {
    let escaped = value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;");
    pulldown_cmark::Event::Html(
        format!("<span data-math=\"{escaped}\" data-display=\"{display}\">{escaped}</span>").into(),
    )
}
