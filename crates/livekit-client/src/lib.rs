//! LiveKit room client. The optional host implementation runs in the separately packaged program.

#[cfg(feature = "host")]
pub mod backend;
#[cfg(feature = "host")]
mod codec;
mod mixer;
pub mod protocol;
mod resample;
#[cfg(test)]
mod resample_tests;
mod room;
#[cfg(feature = "host")]
mod rtc;
#[cfg(feature = "host")]
mod transport;
mod types;
#[cfg(all(test, feature = "host"))]
#[path = "video_tests.rs"]
mod video_tests;

pub use mixer::AudioMixer;
pub use protocol::ScreenSource;
pub use protocol::ScreenTarget;
pub use resample::AudioRate;
pub use resample::AudioResampler;
pub use room::MediaRoom;
pub use room::screen_sources;
pub use types::*;

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
