use crate::services::SystemServiceError;
use crate::window::WindowIcon;
use crate::window::WindowOperationError;
use crate::window::WindowRole;

use super::AppContext;
use super::WindowContext;
use crate::app::presentation::AboutPanelFuture;
use crate::app::presentation::AboutPanelOptions;
use crate::app::presentation::ApplicationFocusOptions;
use crate::app::presentation::ApplicationFocusOutcome;
use crate::app::presentation::USER_ACTIVITY;
use crate::app::presentation::UserActivityInfo;
use crate::app::presentation::fallback_about_request;
use crate::app::presentation::focus_requires_visible_window;
use crate::app::presentation::platform;
use crate::app::presentation::select_window_target;
use crate::app::presentation::validate_user_activity;

const APPLICATION_HIDE: &str = "application hiding";
const APPLICATION_SHOW: &str = "application showing";
const APPLICATION_HIDDEN_STATE: &str = "application hidden-state query";
const EMOJI_PANEL: &str = "native emoji panel";
const DOCK_ICON: &str = "macOS Dock icon";
const DOCK_VISIBILITY: &str = "macOS Dock visibility";

macro_rules! presentation_panel_methods {
    () => {
        /// Returns whether this operating system exposes a native emoji or character picker.
        pub fn is_emoji_panel_supported(&self) -> bool {
            platform::is_emoji_panel_supported()
        }

        /// Shows the native emoji or character picker for the current text responder.
        pub fn show_emoji_panel(&self) -> Result<(), SystemServiceError> {
            platform::show_emoji_panel()
                .then_some(())
                .ok_or_else(|| SystemServiceError::unsupported(EMOJI_PANEL))
        }
    };
}

impl<'a, T: 'static> AppContext<'a, T> {
    presentation_panel_methods!();

    /// Shows application metadata in the platform About UI.
    ///
    /// macOS uses its standard About panel. Other platforms reuse the injected asynchronous
    /// message-dialog capability instead of introducing a second dialog runtime.
    pub fn show_about_panel(&self, mut options: AboutPanelOptions) -> AboutPanelFuture {
        if options.name.is_none() {
            options.name = Some(self.application_name().to_string_lossy().into_owned());
        }
        if options.version.is_none() {
            options.version = Some(self.application_version());
        }
        if platform::show_about_panel(&options) {
            return Box::pin(async { Ok(()) });
        }
        let future = self
            .services
            .message_dialogs()
            .show(fallback_about_request(&options));
        Box::pin(async move { future.await.map(|_| ()) })
    }

    /// Hides the application icon from the macOS Dock.
    pub fn hide_dock(&self) -> Result<(), SystemServiceError> {
        platform::set_dock_visible(false)
            .then_some(())
            .ok_or_else(|| SystemServiceError::unsupported(DOCK_VISIBILITY))
    }

    /// Shows the application icon in the macOS Dock.
    pub fn show_dock(&self) -> Result<(), SystemServiceError> {
        platform::set_dock_visible(true)
            .then_some(())
            .ok_or_else(|| SystemServiceError::unsupported(DOCK_VISIBILITY))
    }

    /// Returns whether the application currently appears in the macOS Dock.
    pub fn is_dock_visible(&self) -> Result<bool, SystemServiceError> {
        platform::is_dock_visible().ok_or_else(|| SystemServiceError::unsupported(DOCK_VISIBILITY))
    }

    /// Replaces the macOS Dock artwork with an existing validated ZUI icon.
    pub fn set_dock_icon(&self, icon: &WindowIcon) -> Result<(), SystemServiceError> {
        platform::set_dock_icon(Some(icon))
            .then_some(())
            .ok_or_else(|| SystemServiceError::unsupported(DOCK_ICON))
    }

    /// Restores the bundled macOS Dock artwork.
    pub fn clear_dock_icon(&self) -> Result<(), SystemServiceError> {
        platform::set_dock_icon(None)
            .then_some(())
            .ok_or_else(|| SystemServiceError::unsupported(DOCK_ICON))
    }

    /// Creates and publishes the current macOS Handoff user activity.
    ///
    /// `webpage_url`, when present, must use HTTP or HTTPS so another device can fall back to a
    /// browser when no application handles `activity_type`.
    pub fn set_user_activity(
        &self,
        activity_type: &str,
        user_info: &UserActivityInfo,
        webpage_url: Option<&str>,
    ) -> Result<(), SystemServiceError> {
        let webpage_url = validate_user_activity(activity_type, webpage_url)?;
        platform::set_user_activity(activity_type, user_info, webpage_url.as_ref())
    }

    /// Returns the current macOS Handoff activity type, or `None` before one is set.
    pub fn current_user_activity_type(&self) -> Result<Option<String>, SystemServiceError> {
        platform::current_user_activity_type()
            .ok_or_else(|| SystemServiceError::unsupported(USER_ACTIVITY))
    }

    /// Merges JSON-compatible state into the matching current macOS Handoff activity.
    ///
    /// A missing activity or mismatched `activity_type` leaves the current activity unchanged.
    pub fn update_current_activity(
        &self,
        activity_type: &str,
        user_info: &UserActivityInfo,
    ) -> Result<(), SystemServiceError> {
        validate_user_activity(activity_type, None)?;
        platform::update_current_activity(activity_type, user_info)
    }

    /// Marks the current macOS Handoff activity inactive without invalidating it.
    pub fn resign_current_activity(&self) -> Result<(), SystemServiceError> {
        platform::resign_current_activity()
    }

    /// Invalidates and forgets the current macOS Handoff activity.
    pub fn invalidate_current_activity(&self) -> Result<(), SystemServiceError> {
        platform::invalidate_current_activity()
    }

    /// Requests native application focus using Electron-compatible platform selection.
    ///
    /// macOS activates the application itself. Windows focuses the first product window, while
    /// other platforms focus the first product window that is not explicitly hidden. Window
    /// selection is stable by [`crate::window::WindowId`].
    pub fn focus_application(
        &self,
        options: ApplicationFocusOptions,
    ) -> Result<ApplicationFocusOutcome, WindowOperationError> {
        if platform::focus(options.steal()) {
            return Ok(ApplicationFocusOutcome::Application);
        }
        let target = select_window_target(
            focus_requires_visible_window(),
            self.windows
                .values()
                .filter(|runtime| runtime.role() == WindowRole::Product)
                .map(|runtime| {
                    let visible = runtime
                        .handle()
                        .state()
                        .ok()
                        .and_then(|state| state.visible());
                    (runtime.id(), visible)
                }),
        );
        let Some(target) = target else {
            return Ok(ApplicationFocusOutcome::NoTarget);
        };
        self.windows
            .get(&target)
            .expect("selected application focus target must remain live")
            .handle()
            .focus()?;
        Ok(ApplicationFocusOutcome::Window(target))
    }

    /// Returns whether the operating system currently considers this application active.
    ///
    /// macOS uses application-level activation state. Other platforms report active while any
    /// product window owns keyboard focus.
    pub fn is_application_active(&self) -> bool {
        platform::is_active().unwrap_or_else(|| {
            self.windows
                .values()
                .any(|runtime| runtime.role() == WindowRole::Product && runtime.has_focus())
        })
    }

    /// Hides every application window on macOS without minimizing them.
    pub fn hide_application(&self) -> Result<(), SystemServiceError> {
        platform::hide()
            .then_some(())
            .ok_or_else(|| SystemServiceError::unsupported(APPLICATION_HIDE))
    }

    /// Reveals application windows on macOS without automatically activating the application.
    pub fn show_application(&self) -> Result<(), SystemServiceError> {
        platform::show()
            .then_some(())
            .ok_or_else(|| SystemServiceError::unsupported(APPLICATION_SHOW))
    }

    /// Returns whether macOS currently hides the application and all of its windows.
    pub fn is_application_hidden(&self) -> Result<bool, SystemServiceError> {
        platform::is_hidden()
            .ok_or_else(|| SystemServiceError::unsupported(APPLICATION_HIDDEN_STATE))
    }
}

impl<'a, T: 'static> WindowContext<'a, T> {
    presentation_panel_methods!();
}
