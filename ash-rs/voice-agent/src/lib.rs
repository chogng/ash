//! A room participant that bridges authorized human audio to a model-owned voice session.

mod audio;
mod session;

pub use session::AgentCommand;
pub use session::AgentEvent;
pub use session::VoiceAgent;

#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    #[error("invalid voice agent participants")]
    Participants,
    #[error("voice agent audio queue exceeded its limit")]
    AudioOverflow,
    #[error("voice agent consumer stopped or is overloaded")]
    Consumer,
    #[error("voice agent media failed")]
    Media(#[from] livekit_client::MediaError),
    #[error("voice agent model session failed")]
    Model(#[from] ash_model_provider::ModelProviderError),
}
