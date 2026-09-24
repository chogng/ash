use std::fmt::Write;
use std::future::Future;
use std::io;
use std::pin::Pin;

use crate::services::MenuAboutMetadata;
use crate::services::MessageDialogRequest;
use crate::services::SystemServiceError;
use crate::window::WindowId;

#[path = "presentation/platform.rs"]
pub(super) mod platform;

/// About-panel metadata shared with the native About menu role.
///
/// Passing the options directly to [`super::AppContext::show_about_panel`] combines Electron's
/// stateful `setAboutPanelOptions` and `showAboutPanel` pair into one Rust operation.
pub type AboutPanelOptions = MenuAboutMetadata;

/// Owned asynchronous completion of a native About panel.
pub type AboutPanelFuture =
    Pin<Box<dyn Future<Output = Result<(), SystemServiceError>> + Send + 'static>>;

/// JSON-compatible state transferred by one macOS Handoff user activity.
pub type UserActivityInfo = serde_json::Map<String, serde_json::Value>;

pub(super) const USER_ACTIVITY: &str = "macOS Handoff user activity";

/// Platform-specific options for requesting application activation.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ApplicationFocusOptions {
    steal: bool,
}

impl ApplicationFocusOptions {
    /// Creates a cooperative focus request.
    pub const fn new() -> Self {
        Self { steal: false }
    }

    /// Selects whether macOS may activate the application over another active application.
    ///
    /// Other platforms ignore this option. Stealing focus should be reserved for an explicit user
    /// action because it can interrupt work in another application.
    pub const fn with_steal(mut self, steal: bool) -> Self {
        self.steal = steal;
        self
    }

    /// Returns whether macOS may force application activation.
    pub const fn steal(self) -> bool {
        self.steal
    }
}

/// Native target selected by one application focus request.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ApplicationFocusOutcome {
    /// macOS received an application-level activation request.
    Application,
    /// A product window received the native focus request.
    Window(WindowId),
    /// No suitable product window existed on a window-focused platform.
    NoTarget,
}

pub(super) const fn focus_requires_visible_window() -> bool {
    !cfg!(target_os = "windows")
}

pub(super) fn select_window_target(
    requires_visible: bool,
    candidates: impl IntoIterator<Item = (WindowId, Option<bool>)>,
) -> Option<WindowId> {
    let mut candidates = candidates.into_iter().collect::<Vec<_>>();
    candidates.sort_by_key(|(window, _)| window.into_raw());
    candidates.into_iter().find_map(|(window, visible)| {
        (!requires_visible || visible != Some(false)).then_some(window)
    })
}

pub(super) fn fallback_about_request(options: &AboutPanelOptions) -> MessageDialogRequest {
    let name = options.name.as_deref().unwrap_or("Application");
    let mut message = String::new();
    if let Some(version) = options.version.as_deref() {
        let _ = writeln!(message, "Version {version}");
    }
    if let Some(build) = options.short_version.as_deref() {
        let _ = writeln!(message, "Build {build}");
    }
    if !options.authors.is_empty() {
        let _ = writeln!(message, "{}", options.authors.join(", "));
    }
    for text in [
        options.comments.as_deref(),
        options.copyright.as_deref(),
        options.license.as_deref(),
        options.credits.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if !message.is_empty() {
            message.push('\n');
        }
        message.push_str(text);
    }
    if let Some(website) = options.website.as_deref() {
        if !message.is_empty() {
            message.push('\n');
        }
        if let Some(label) = options.website_label.as_deref() {
            let _ = write!(message, "{label}: {website}");
        } else {
            message.push_str(website);
        }
    }
    MessageDialogRequest::new(format!("About {name}"), message)
}

pub(super) fn validate_user_activity(
    activity_type: &str,
    webpage_url: Option<&str>,
) -> Result<Option<url::Url>, SystemServiceError> {
    if activity_type.trim().is_empty() {
        return Err(SystemServiceError::invalid_input(
            USER_ACTIVITY,
            io::Error::new(io::ErrorKind::InvalidInput, "activity type cannot be empty"),
        ));
    }
    let Some(webpage_url) = webpage_url else {
        return Ok(None);
    };
    let webpage_url = url::Url::parse(webpage_url)
        .map_err(|source| SystemServiceError::invalid_input(USER_ACTIVITY, source))?;
    if !matches!(webpage_url.scheme(), "http" | "https") {
        return Err(SystemServiceError::invalid_input(
            USER_ACTIVITY,
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "Handoff webpage URL must use http or https",
            ),
        ));
    }
    Ok(Some(webpage_url))
}

#[cfg(test)]
#[path = "presentation_tests.rs"]
mod tests;
