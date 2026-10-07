use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

/// A provider-neutral WebSocket close frame.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WebSocketCloseFrame {
    pub code: u16,
    pub reason: String,
}

/// A complete WebSocket message without backend-specific frame types.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WebSocketMessage {
    Text(String),
    Binary(Vec<u8>),
    Ping(Vec<u8>),
    Pong(Vec<u8>),
    Close(WebSocketCloseFrame),
    CloseWithoutFrame,
}

impl WebSocketMessage {
    pub(crate) fn into_tungstenite(self) -> tokio_tungstenite::tungstenite::Message {
        match self {
            Self::Text(value) => tokio_tungstenite::tungstenite::Message::Text(value.into()),
            Self::Binary(value) => tokio_tungstenite::tungstenite::Message::Binary(value.into()),
            Self::Ping(value) => tokio_tungstenite::tungstenite::Message::Ping(value.into()),
            Self::Pong(value) => tokio_tungstenite::tungstenite::Message::Pong(value.into()),
            Self::Close(frame) => {
                tokio_tungstenite::tungstenite::Message::Close(Some(CloseFrame {
                    code: CloseCode::from(frame.code),
                    reason: frame.reason.into(),
                }))
            }
            Self::CloseWithoutFrame => tokio_tungstenite::tungstenite::Message::Close(None),
        }
    }

    pub(crate) fn from_tungstenite(
        message: tokio_tungstenite::tungstenite::Message,
    ) -> Option<Self> {
        match message {
            tokio_tungstenite::tungstenite::Message::Text(value) => {
                Some(Self::Text(value.to_string()))
            }
            tokio_tungstenite::tungstenite::Message::Binary(value) => {
                Some(Self::Binary(value.to_vec()))
            }
            tokio_tungstenite::tungstenite::Message::Ping(value) => {
                Some(Self::Ping(value.to_vec()))
            }
            tokio_tungstenite::tungstenite::Message::Pong(value) => {
                Some(Self::Pong(value.to_vec()))
            }
            tokio_tungstenite::tungstenite::Message::Close(Some(frame)) => {
                Some(Self::Close(WebSocketCloseFrame {
                    code: u16::from(frame.code),
                    reason: frame.reason.to_string(),
                }))
            }
            tokio_tungstenite::tungstenite::Message::Close(None) => Some(Self::CloseWithoutFrame),
            tokio_tungstenite::tungstenite::Message::Frame(_) => None,
        }
    }
}
