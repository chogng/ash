#[cfg(not(target_os = "macos"))]
use super::APPLICATION_BADGE;
use super::ApplicationBadgeRequest;
use crate::services::SystemServiceError;

#[cfg(target_os = "macos")]
#[path = "platform/macos.rs"]
mod macos;
#[cfg(target_os = "macos")]
pub(super) fn set(request: &ApplicationBadgeRequest) -> Result<(), SystemServiceError> {
    macos::set(request)
}

#[cfg(target_os = "linux")]
pub(super) fn set(request: &ApplicationBadgeRequest) -> Result<(), SystemServiceError> {
    use std::collections::HashMap;

    use zbus::blocking::Connection;
    use zbus::zvariant::OwnedValue;

    use super::ApplicationBadge;

    const LAUNCHER_ENTRY_INTERFACE: &str = "com.canonical.Unity.LauncherEntry";
    const LAUNCHER_ENTRY_PATH: &str = "/com/canonical/unity/launcherentry";

    let desktop_file_name = request.desktop_file_name().ok_or_else(|| {
        SystemServiceError::invalid_input(
            APPLICATION_BADGE,
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "a Linux application badge requires a configured desktop filename",
            ),
        )
    })?;
    let count = match request.badge() {
        ApplicationBadge::Count(count) => count,
        ApplicationBadge::Hidden | ApplicationBadge::Indeterminate => 0,
    };
    let mut properties = HashMap::<&str, OwnedValue>::new();
    properties.insert("count", count.into());
    properties.insert("count-visible", (count != 0).into());
    let application_uri = format!("application://{}", desktop_file_name.as_str());
    Connection::session()
        .and_then(|connection| {
            connection.emit_signal(
                None::<&str>,
                LAUNCHER_ENTRY_PATH,
                LAUNCHER_ENTRY_INTERFACE,
                "Update",
                &(application_uri, properties),
            )
        })
        .map_err(|source| SystemServiceError::backend(APPLICATION_BADGE, source))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub(super) fn set(_request: &ApplicationBadgeRequest) -> Result<(), SystemServiceError> {
    Err(SystemServiceError::unsupported(APPLICATION_BADGE))
}
