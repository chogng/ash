//! Device-independent LiveKit room media. Room permissions belong to the caller.

mod mixer;
mod resample;
pub use mixer::AudioMixer;
mod room;
mod transport;
#[cfg(test)]
#[path = "video_tests.rs"]
mod video_tests;
pub use livekit::SessionStats;

pub use resample::AudioRate;
pub use resample::AudioResampler;
pub use room::AudioFrame;
pub use room::AudioPublication;
pub use room::MediaEvent;
pub use room::MediaRoom;
pub use room::ScreenFrame;

#[derive(Debug, thiserror::Error)]
pub enum MediaError {
    #[error("invalid media server address")]
    Address,
    #[error("media connection failed")]
    Connection,
    #[error("media operation timed out")]
    Timeout,
    #[error("audio publication is unavailable")]
    Publication,
    #[error("audio frame must contain 480 or 960 mono samples at 48 kHz")]
    AudioFrame,
    #[error("media event consumer is closed or overloaded")]
    Consumer,
    #[error("screen share publication failed")]
    ScreenShare,
    #[error("screen capture failed: {0}")]
    Capture(String),
}

pub(crate) fn validate_url(value: &str) -> Result<(), MediaError> {
    let url = url::Url::parse(value).map_err(|_| MediaError::Address)?;
    let loopback = match url.host() {
        Some(url::Host::Domain("localhost")) => true,
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        _ => false,
    };
    if !matches!(url.scheme(), "wss" | "ws")
        || (url.scheme() == "ws" && !loopback)
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(MediaError::Address);
    }
    Ok(())
}
