use std::future::Future;
use std::pin::Pin;
#[cfg(unix)]
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use super::SystemServiceError;
use super::blocking::BlockingServiceExecutor;

/// Owned asynchronous result of submitting a desktop notification.
pub type NotificationFuture =
    Pin<Box<dyn Future<Output = Result<NotificationId, SystemServiceError>> + Send + 'static>>;

static NEXT_NOTIFICATION_ID: AtomicU64 = AtomicU64::new(1);

/// Stable identity returned after submitting a desktop notification.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct NotificationId(u64);

impl NotificationId {
    /// Creates an identity supplied by a custom notification backend.
    pub const fn from_raw(value: u64) -> Self {
        Self(value)
    }

    /// Returns the backend-defined numeric identity.
    pub const fn into_raw(self) -> u64 {
        self.0
    }
}

/// Backend-independent content for one desktop notification.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NotificationRequest {
    title: String,
    body: Option<String>,
}

impl NotificationRequest {
    /// Creates a notification with a required title.
    pub fn new(title: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            body: None,
        }
    }

    /// Sets the optional notification body.
    pub fn with_body(mut self, body: impl Into<String>) -> Self {
        self.body = Some(body.into());
        self
    }
}

/// Desktop-notification backend used through an injectable [`NotificationHandle`].
pub trait NotificationService: Send + Sync {
    /// Submits a desktop notification and returns its backend identity.
    fn show(&self, request: NotificationRequest) -> Result<NotificationId, SystemServiceError>;
}

/// Cloneable capability for submitting desktop notifications.
#[derive(Clone)]
pub struct NotificationHandle {
    service: Arc<dyn NotificationService>,
    executor: BlockingServiceExecutor,
}

impl NotificationHandle {
    pub(crate) fn new(service: impl NotificationService + 'static) -> Self {
        Self {
            service: Arc::new(service),
            executor: BlockingServiceExecutor,
        }
    }

    /// Submits a notification without blocking the calling thread.
    pub fn show(&self, request: NotificationRequest) -> NotificationFuture {
        let service = Arc::clone(&self.service);
        self.executor
            .spawn("desktop notification", move || service.show(request))
    }
}

/// Default desktop-notification backend.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemNotifications;

impl NotificationService for SystemNotifications {
    fn show(&self, request: NotificationRequest) -> Result<NotificationId, SystemServiceError> {
        show_system_notification(&request)?;
        Ok(NotificationId(
            NEXT_NOTIFICATION_ID.fetch_add(1, Ordering::Relaxed),
        ))
    }
}

#[cfg(target_os = "macos")]
fn show_system_notification(request: &NotificationRequest) -> Result<(), SystemServiceError> {
    let title = escape_apple_script(&request.title);
    let body = escape_apple_script(request.body.as_deref().unwrap_or_default());
    let script = format!("display notification \"{body}\" with title \"{title}\"");
    let status = Command::new("/usr/bin/osascript")
        .args(["-e", &script])
        .status()
        .map_err(|source| SystemServiceError::backend("desktop notification", source))?;
    if status.success() {
        Ok(())
    } else {
        Err(SystemServiceError::backend(
            "desktop notification",
            std::io::Error::other(format!("osascript exited with {status}")),
        ))
    }
}

#[cfg(target_os = "macos")]
fn escape_apple_script(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(all(unix, not(target_os = "macos")))]
fn show_system_notification(request: &NotificationRequest) -> Result<(), SystemServiceError> {
    let mut command = Command::new("notify-send");
    command.arg(&request.title);
    if let Some(body) = &request.body {
        command.arg(body);
    }
    let status = command
        .status()
        .map_err(|source| SystemServiceError::backend("desktop notification", source))?;
    if status.success() {
        Ok(())
    } else {
        Err(SystemServiceError::backend(
            "desktop notification",
            std::io::Error::other(format!("notify-send exited with {status}")),
        ))
    }
}

#[cfg(not(any(unix, target_os = "macos")))]
fn show_system_notification(_request: &NotificationRequest) -> Result<(), SystemServiceError> {
    Err(SystemServiceError::unsupported("desktop notification"))
}
