//! Versioned contract for the remote client and compatible external services.
use crate::Error;
use crate::ReadRequest;
use crate::Result;
use crate::Scope;
use crate::WriteRequest;
use protocol::ThreadId;
use protocol::TurnId;
use serde::Deserialize;
use serde::Serialize;
use std::fmt;
use zeroize::Zeroize;

pub const API_PATH: &str = "/v1/agent-message-board";
pub const MAX_BODY: usize = 128 * 1024;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MemberRegistration {
    pub scope: Scope,
    pub members: Vec<ThreadId>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BoardCall {
    pub scope: Scope,
    pub caller: ThreadId,
    pub operation: BoardOperation,
}

#[derive(Deserialize, Serialize)]
#[serde(
    tag = "method",
    content = "params",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum BoardOperation {
    Read(ReadRequest),
    Write {
        operation_id: String,
        time: i64,
        request: WriteRequest,
    },
    Unread,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NotificationWatch {
    pub scope: Scope,
    pub caller: ThreadId,
    pub turn_id: TurnId,
    pub after: i64,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ServiceFailure {
    pub code: String,
    pub message: String,
}

/// Host credential with bounded header syntax and redacted diagnostics.
#[derive(Clone)]
pub struct AccessToken(String);
impl AccessToken {
    /// Creates the credential-bound header consumed only by the HTTP adapter.
    pub fn authorization_header(&self) -> String {
        format!("Bearer {}", self.0)
    }

    pub fn new(value: String) -> Result<Self> {
        if !(32..=4096).contains(&value.len()) || !value.bytes().all(|byte| byte.is_ascii_graphic())
        {
            return Err(Error::Input(
                "board credential must contain 32–4096 visible ASCII bytes".into(),
            ));
        }
        Ok(Self(value))
    }
}
impl fmt::Debug for AccessToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("AccessToken([REDACTED])")
    }
}
impl Drop for AccessToken {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}
