//! Remote message-board transport. Credentials belong to the host, never model arguments.
mod client;
mod notifications;

pub use agent_message_board::API_PATH;
pub use agent_message_board::AccessToken;
pub use agent_message_board::BoardCall;
pub use agent_message_board::BoardOperation;
pub use agent_message_board::MAX_BODY;
pub use agent_message_board::MemberRegistration;
pub use agent_message_board::NotificationWatch;
pub use agent_message_board::ServiceFailure;
pub use client::RemoteMessageBoard;
pub use notifications::NotificationHost;
pub use notifications::install_notifications;
