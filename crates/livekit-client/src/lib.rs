//! LiveKit room client and wire contract for the separately launched media process.

mod mixer;
pub mod protocol;
mod resample;
#[cfg(test)]
mod resample_tests;
mod room;
mod types;

pub use mixer::AudioMixer;
pub use protocol::ScreenSource;
pub use protocol::ScreenTarget;
pub use resample::AudioRate;
pub use resample::AudioResampler;
pub use room::MediaRoom;
pub use room::screen_sources;
pub use types::*;

/// Checks room endpoints at both the caller and the media process boundaries.
pub fn validate_url(value: &str) -> Result<(), MediaError> {
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
