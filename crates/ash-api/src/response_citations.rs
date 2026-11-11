use ash_protocol::ResponseCitation;
use serde_json::Value;

const MAX_CITATIONS: usize = 64;

pub(crate) fn collect_web_citations(target: &mut Vec<ResponseCitation>, annotations: &Value) {
    collect(target, annotations, |entry| {
        if entry.get("type")?.as_str()? != "url_citation" {
            return None;
        }
        Some(ResponseCitation::Web {
            url: source_url(entry.get("url")?)?,
            title: entry.get("title")?.as_str()?.chars().take(512).collect(),
        })
    });
}

pub(crate) fn collect_code_citations(target: &mut Vec<ResponseCitation>, annotations: &Value) {
    collect(target, annotations, |entry| {
        let citation = entry.get("citations")?;
        let snippet = citation.get("snippet")?.as_str()?;
        let license = citation.get("license")?.as_str()?;
        if snippet.is_empty() || snippet.len() > 32768 || license.len() > 128 {
            return None;
        }
        Some(ResponseCitation::Code {
            url: source_url(citation.get("url")?)?,
            license: license.to_owned(),
            snippet: snippet.to_owned(),
        })
    });
}

fn collect(
    target: &mut Vec<ResponseCitation>,
    annotations: &Value,
    parse: impl Fn(&Value) -> Option<ResponseCitation>,
) {
    for entry in annotations.as_array().into_iter().flatten() {
        if target.len() == MAX_CITATIONS {
            break;
        }
        if let Some(citation) = parse(entry)
            && !target.contains(&citation)
        {
            target.push(citation);
        }
    }
}

fn source_url(value: &Value) -> Option<String> {
    let value = value.as_str()?;
    if value.len() > 8192 {
        return None;
    }
    let url = url::Url::parse(value).ok()?;
    if matches!(url.scheme(), "http" | "https")
        && url.has_host()
        && url.username().is_empty()
        && url.password().is_none()
    {
        Some(url.into())
    } else {
        None
    }
}
