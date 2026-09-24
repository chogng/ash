use winit::dpi::LogicalPosition as NativeLogicalPosition;
use winit::dpi::PhysicalPosition as NativePhysicalPosition;
use winit::window::Window;

use super::CursorGrabMode;
use super::DisplaySnapshot;
use super::ImePurpose;
use super::LogicalPosition;
use super::LogicalSize;
use super::PhysicalExtent;
use super::PhysicalPosition;
use super::ResizeDirection;
use super::Theme;
use super::UserAttentionType;
use super::WindowButtons;
use super::WindowHandle;
use super::WindowIcon;
use super::WindowOperationError;
use super::platform::blur_supported;
use super::platform::dynamic_transparency_supported;
use super::platform::ime_purpose_supported;
use super::platform::map_external_error;
use super::platform::programmatic_position_supported;
use super::platform::window_icon_supported;

impl WindowHandle {
    /// Returns the current platform theme preference or reports that the window has closed.
    pub fn theme(&self) -> Result<Option<Theme>, WindowOperationError> {
        Ok(self
            .live_window("theme query")?
            .theme()
            .map(Theme::from_native))
    }

    /// Applies an explicit platform theme or reports that the window has closed.
    pub fn set_theme(&self, theme: Option<Theme>) -> Result<(), WindowOperationError> {
        self.live_window("theme update")?
            .set_theme(theme.map(Theme::into_native));
        Ok(())
    }

    /// Captures connected displays and the primary/current display for this live window.
    pub fn display_snapshot(&self) -> Result<DisplaySnapshot, WindowOperationError> {
        let window = self.live_window("display snapshot")?;
        Ok(DisplaySnapshot::from_native(
            window.available_monitors(),
            window.primary_monitor(),
            window.current_monitor(),
        ))
    }

    /// Returns the native title currently reported for this live window.
    pub fn title(&self) -> Result<String, WindowOperationError> {
        Ok(self.live_window("window title query")?.title())
    }

    /// Enables or disables native transparency at runtime where the backend supports it.
    pub fn set_transparent(&self, transparent: bool) -> Result<(), WindowOperationError> {
        let operation = "window transparency update";
        let window = self.live_window(operation)?;
        if !dynamic_transparency_supported(&window) {
            return Err(WindowOperationError::Unsupported {
                window: self.id(),
                operation,
            });
        }
        window.set_transparent(transparent);
        Ok(())
    }

    /// Enables or disables compositor blur behind transparent window content.
    pub fn set_blur(&self, blur: bool) -> Result<(), WindowOperationError> {
        let operation = "window background blur update";
        let window = self.live_window(operation)?;
        if blur && !blur_supported(&window) {
            return Err(WindowOperationError::Unsupported {
                window: self.id(),
                operation,
            });
        }
        window.set_blur(blur);
        Ok(())
    }

    /// Changes whether the platform draws standard outer window decorations.
    pub fn set_decorated(&self, decorated: bool) -> Result<(), WindowOperationError> {
        self.live_window("window decoration update")?
            .set_decorations(decorated);
        Ok(())
    }

    /// Installs or clears per-window titlebar/task-switcher artwork where supported.
    pub fn set_icon(&self, icon: Option<WindowIcon>) -> Result<(), WindowOperationError> {
        let operation = "window icon update";
        let window = self.live_window(operation)?;
        if icon.is_some() && !window_icon_supported(&window) {
            return Err(WindowOperationError::Unsupported {
                window: self.id(),
                operation,
            });
        }
        window.set_window_icon(icon.map(WindowIcon::into_native));
        Ok(())
    }

    /// Hints whether platform text input is normal, secret, or terminal-oriented.
    pub fn set_ime_purpose(&self, purpose: ImePurpose) -> Result<(), WindowOperationError> {
        let operation = "IME purpose update";
        let window = self.live_window(operation)?;
        if !ime_purpose_supported(&window) {
            return Err(WindowOperationError::Unsupported {
                window: self.id(),
                operation,
            });
        }
        window.set_ime_purpose(purpose.into_native());
        Ok(())
    }

    /// Changes or removes the minimum logical content size.
    pub fn set_min_inner_logical_size(
        &self,
        size: Option<LogicalSize>,
    ) -> Result<(), WindowOperationError> {
        let operation = "minimum inner size update";
        validate_optional_size(self, operation, size)?;
        self.live_window(operation)?
            .set_min_inner_size(size.map(LogicalSize::into_native));
        Ok(())
    }

    /// Changes or removes the maximum logical content size.
    pub fn set_max_inner_logical_size(
        &self,
        size: Option<LogicalSize>,
    ) -> Result<(), WindowOperationError> {
        let operation = "maximum inner size update";
        validate_optional_size(self, operation, size)?;
        self.live_window(operation)?
            .set_max_inner_size(size.map(LogicalSize::into_native));
        Ok(())
    }

    /// Changes or removes the logical step used for user-driven resizing.
    pub fn set_resize_increments(
        &self,
        increments: Option<LogicalSize>,
    ) -> Result<(), WindowOperationError> {
        let operation = "resize increments update";
        validate_optional_size(self, operation, increments)?;
        self.live_window(operation)?
            .set_resize_increments(increments.map(LogicalSize::into_native));
        Ok(())
    }

    /// Returns the effective resize increments in physical pixels when available.
    pub fn resize_increments(&self) -> Result<Option<PhysicalExtent>, WindowOperationError> {
        Ok(self
            .live_window("resize increments query")?
            .resize_increments()
            .map(|size| PhysicalExtent::new(size.width, size.height)))
    }

    /// Changes which standard native titlebar buttons remain enabled.
    pub fn set_enabled_buttons(&self, buttons: WindowButtons) -> Result<(), WindowOperationError> {
        let operation = "native window buttons update";
        let window = self.live_window(operation)?;
        if buttons != WindowButtons::ALL && !window_buttons_supported(&window) {
            return Err(WindowOperationError::Unsupported {
                window: self.id(),
                operation,
            });
        }
        window.set_enabled_buttons(buttons.into_native());
        Ok(())
    }

    /// Returns the native titlebar buttons currently reported as enabled.
    pub fn enabled_buttons(&self) -> Result<WindowButtons, WindowOperationError> {
        Ok(WindowButtons::from_native(
            self.live_window("native window buttons query")?
                .enabled_buttons(),
        ))
    }

    /// Enables or disables operating-system protection against external window capture.
    pub fn set_content_protected(&self, protected: bool) -> Result<(), WindowOperationError> {
        let operation = "window content protection update";
        let window = self.live_window(operation)?;
        if protected && !content_protection_supported(&window) {
            return Err(WindowOperationError::Unsupported {
                window: self.id(),
                operation,
            });
        }
        window.set_content_protected(protected);
        Ok(())
    }

    /// Requests or clears a platform-specific indication that this window needs attention.
    pub fn request_user_attention(
        &self,
        attention: Option<UserAttentionType>,
    ) -> Result<(), WindowOperationError> {
        self.live_window("user attention request")?
            .request_user_attention(attention.map(UserAttentionType::into_native));
        Ok(())
    }

    /// Moves the pointer to logical content coordinates.
    pub fn set_cursor_logical_position(
        &self,
        position: LogicalPosition,
    ) -> Result<(), WindowOperationError> {
        let operation = "cursor position update";
        if !position.is_valid() {
            return Err(WindowOperationError::InvalidPosition {
                window: self.id(),
                operation,
            });
        }
        self.live_window(operation)?
            .set_cursor_position(NativeLogicalPosition::new(position.x, position.y))
            .map_err(|source| map_external_error(self.id(), operation, source))?;
        Ok(())
    }

    /// Changes whether and how the pointer is constrained to this window.
    pub fn set_cursor_grab(&self, mode: CursorGrabMode) -> Result<(), WindowOperationError> {
        let operation = "cursor grab update";
        self.live_window(operation)?
            .set_cursor_grab(mode.into_native())
            .map_err(|source| map_external_error(self.id(), operation, source))?;
        Ok(())
    }

    /// Shows or hides the platform pointer while it interacts with this window.
    pub fn set_cursor_visible(&self, visible: bool) -> Result<(), WindowOperationError> {
        self.live_window("cursor visibility update")?
            .set_cursor_visible(visible);
        Ok(())
    }

    /// Starts an operating-system managed resize gesture from one edge or corner.
    pub fn start_window_resize(
        &self,
        direction: ResizeDirection,
    ) -> Result<(), WindowOperationError> {
        let operation = "window resize gesture";
        self.live_window(operation)?
            .drag_resize_window(direction.into_native())
            .map_err(|source| map_external_error(self.id(), operation, source))?;
        Ok(())
    }

    /// Enables native pointer hit testing or lets pointer events pass to windows behind this one.
    pub fn set_pointer_input_enabled(&self, enabled: bool) -> Result<(), WindowOperationError> {
        let operation = "native pointer input update";
        self.live_window(operation)?
            .set_cursor_hittest(enabled)
            .map_err(|source| map_external_error(self.id(), operation, source))?;
        Ok(())
    }

    /// Centers the outer window on its current or primary monitor.
    ///
    /// Returns `None` when the platform has no monitor to target.
    pub fn center(&self) -> Result<Option<PhysicalPosition>, WindowOperationError> {
        let operation = "window centering";
        let window = self.live_window(operation)?;
        if !programmatic_position_supported(&window) {
            return Err(WindowOperationError::Unsupported {
                window: self.id(),
                operation,
            });
        }
        let Some(monitor) = window
            .current_monitor()
            .or_else(|| window.primary_monitor())
        else {
            return Ok(None);
        };
        let monitor_position = monitor.position();
        let monitor_size = monitor.size();
        let window_size = window.outer_size();
        let x = centered_axis(monitor_position.x, monitor_size.width, window_size.width);
        let y = centered_axis(monitor_position.y, monitor_size.height, window_size.height);
        window.set_outer_position(NativePhysicalPosition::new(x, y));
        Ok(Some(PhysicalPosition::new(f64::from(x), f64::from(y))))
    }
}

fn validate_optional_size(
    window: &WindowHandle,
    operation: &'static str,
    size: Option<LogicalSize>,
) -> Result<(), WindowOperationError> {
    if size.is_some_and(|size| !size.is_valid()) {
        return Err(WindowOperationError::InvalidSize {
            window: window.id(),
            operation,
        });
    }
    Ok(())
}

fn centered_axis(origin: i32, monitor_extent: u32, window_extent: u32) -> i32 {
    let centered = i64::from(origin)
        + (i64::from(monitor_extent).saturating_sub(i64::from(window_extent))) / 2;
    centered.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

fn window_buttons_supported(window: &Window) -> bool {
    #[cfg(target_os = "linux")]
    {
        let _ = window;
        false
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = window;
        true
    }
}

fn content_protection_supported(window: &Window) -> bool {
    window_buttons_supported(window)
}

#[cfg(test)]
#[path = "operations_tests.rs"]
mod tests;
