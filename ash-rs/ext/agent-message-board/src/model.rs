use crate::Error;
use crate::Result;
use protocol::SessionId;
use protocol::ThreadId;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;

pub(crate) const OUTPUT_BYTES: usize = 8_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct Scope {
    pub session: SessionId,
    pub root: ThreadId,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Read {
    Channels {
        query: Option<String>,
        cursor: Option<String>,
        limit: Option<u16>,
    },
    Topics {
        channel: String,
        cursor: Option<String>,
        limit: Option<u16>,
    },
    Posts {
        channel: Option<String>,
        topic: Option<i64>,
        author: Option<ThreadId>,
        query: Option<String>,
        cursor: Option<String>,
        limit: Option<u16>,
    },
    Unread {
        cursor: Option<String>,
        limit: Option<u16>,
    },
    Post {
        id: i64,
        #[serde(default)]
        offset: usize,
        chars: Option<u16>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Write {
    CreateChannel {
        channel: String,
    },
    Post {
        channel: String,
        topic: Option<i64>,
        text: String,
        #[serde(default)]
        notify: Vec<ThreadId>,
    },
    Subscription {
        channel: String,
        topic: Option<i64>,
        state: Subscription,
    },
    Acknowledge {
        through: i64,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Subscription {
    On,
    Off,
}

impl Write {
    pub fn validate(&self) -> Result<()> {
        let channel = match self {
            Self::CreateChannel { channel }
            | Self::Subscription { channel, .. }
            | Self::Post { channel, .. } => Some(channel),
            Self::Acknowledge { .. } => None,
        };
        if let Some(channel) = channel {
            channel_name(channel)?;
        }
        match self {
            Self::Post {
                text,
                topic,
                notify,
                ..
            } => {
                if text.trim().is_empty() || text.len() > 65_536 {
                    return Err(input(
                        "post text must contain 1–65536 bytes and be nonblank",
                    ));
                }
                if notify.len() > 256 {
                    return Err(input("at most 256 notification recipients are allowed"));
                }
                if let Some(id) = topic {
                    post_id(*id)?;
                }
            }
            Self::Subscription {
                topic: Some(id), ..
            } => post_id(*id)?,
            Self::Acknowledge { through } => post_id(*through)?,
            _ => {}
        }
        Ok(())
    }

    pub fn members(&self) -> &[ThreadId] {
        match self {
            Self::Post { notify, .. } => notify,
            _ => &[],
        }
    }
}

pub(crate) struct Message {
    pub id: i64,
    pub topic: i64,
    pub channel: String,
    pub author: ThreadId,
    pub time: i64,
    pub text: String,
    pub replies: i64,
}

impl Message {
    pub fn receipt(&self) -> Value {
        json!({
            "id": self.id, "topic": self.topic, "channel": self.channel,
            "author": self.author, "created_at": self.time,
        })
    }

    pub fn summary(&self, chars: usize) -> Value {
        let mut value = self.receipt();
        value["preview"] = self.text.chars().take(chars).collect::<String>().into();
        value["total_chars"] = self.text.chars().count().into();
        value["replies"] = self.replies.into();
        value
    }
}

pub(crate) struct Commit {
    pub output: Value,
}

pub(crate) fn input(message: impl Into<String>) -> Error {
    Error::Input(message.into())
}

pub(crate) fn channel_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 128
        || name.trim() != name
        || name.chars().any(char::is_control)
    {
        return Err(input(
            "channel names must contain 1–128 bytes without surrounding whitespace or control characters",
        ));
    }
    Ok(())
}

pub(crate) fn post_id(id: i64) -> Result<()> {
    if id <= 0 {
        return Err(input("post and topic IDs must be positive integers"));
    }
    Ok(())
}

pub(crate) fn search_term(query: &Option<String>) -> Result<String> {
    let query = query.as_deref().unwrap_or("");
    if query.len() > 2048 {
        return Err(input("search text exceeds 2048 bytes"));
    }
    Ok(caseless::default_case_fold_str(query))
}
