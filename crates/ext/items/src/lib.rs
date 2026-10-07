//! Bounded text display items owned by agent extensions, independent of tool execution.
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ExtensionItemStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionItem {
    #[schemars(length(min = 1, max = 128))]
    pub extension: String,
    #[schemars(length(min = 1, max = 128))]
    pub id: String,
    #[schemars(length(min = 1, max = 512))]
    pub title: String,
    #[schemars(length(max = 131072))]
    pub body: String,
    pub status: ExtensionItemStatus,
    pub content: ExtensionItemContent,
}

impl ExtensionItem {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.extension.is_empty()
            || self.extension.len() > 128
            || self.id.is_empty()
            || self.id.len() > 128
            || self.title.is_empty()
            || self.title.len() > 512
            || self.body.len() > 131072
        {
            return Err("extension item exceeds its text bounds");
        }
        self.content.validate()?;
        Ok(())
    }
}

/// Structured results retain a readable title and body for all clients.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ExtensionItemContent {
    Text,
    WebSearch {
        queries: Vec<String>,
        sources: Vec<SearchSource>,
    },
    Image {
        mime_type: String,
        saved_path: String,
    },
    Sleep {
        duration_ms: u32,
    },
}
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchSource {
    pub title: String,
    pub url: String,
}
impl ExtensionItemContent {
    fn validate(&self) -> Result<(), &'static str> {
        match self {
            Self::Text => {}
            Self::WebSearch { queries, sources } => {
                if queries.is_empty()
                    || queries.len() > 4
                    || queries.iter().any(|q| q.is_empty() || q.len() > 2048)
                    || sources.len() > 100
                    || sources.iter().any(|s| {
                        s.title.len() > 4096
                            || s.url.len() > 8192
                            || !(s.url.starts_with("https://") || s.url.starts_with("http://"))
                    })
                {
                    return Err("search item exceeds its bounds");
                }
            }
            Self::Image {
                mime_type,
                saved_path,
            } => {
                if !matches!(
                    mime_type.as_str(),
                    "image/png" | "image/jpeg" | "image/webp"
                ) || saved_path.is_empty()
                    || saved_path.len() > 4096
                    || saved_path.chars().any(char::is_control)
                {
                    return Err("image item is invalid");
                }
            }
            Self::Sleep { duration_ms } => {
                if *duration_ms > 43_200_000 {
                    return Err("wait exceeds 12 hours");
                }
            }
        }
        Ok(())
    }
}
