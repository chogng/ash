use std::sync::Arc;
use std::sync::Weak;

use winit::dpi::LogicalPosition as NativeLogicalPosition;
use winit::window::Window;

use crate::devtools::DevToolsHandle;

use super::CursorIcon;
use super::ImeCursorArea;
use super::LogicalPosition;
use super::LogicalSize;
use super::PhysicalExtent;
use super::PhysicalPosition;
use super::WindowChrome;
use super::WindowControlInsets;
use super::WindowId;
use super::WindowLevel;
use super::WindowOperationError;
use super::WindowState;
use super::chrome::window_control_insets;
use super::platform::focus_supported;
use super::platform::map_external_error;
use super::platform::minimized_restore_supported;
use super::platform::programmatic_position_supported;
use super::platform::visibility_supported;
use super::platform::window_level_supported;

#[derive(Clone)]
pub(crate) struct WindowCloseRequester {
    send: Arc<dyn Fn(WindowId, WindowCloseMode) -> bool + Send + Sync>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum WindowCloseMode {
    Request,
    Destroy,
}

impl WindowCloseRequester {
    pub(crate) fn new(
        send: impl Fn(WindowId, WindowCloseMode) -> bool + Send + Sync + 'static,
    ) -> Self {
        Self {
            send: Arc::new(send),
        }
    }

    fn request(&self, window: WindowId) -> bool {
        (self.send)(window, WindowCloseMode::Request)
    }

    fn destroy(&self, window: WindowId) -> bool {
        (self.send)(window, WindowCloseMode::Destroy)
    }
}

/// Non-owning platform capability for updating a live native window.
///
/// Application runtimes retain canonical window ownership. Product state may keep this handle to
/// request redraws or forward UI decisions without extending the native window lifecycle.
#[derive(Clone)]
pub struct WindowHandle {
    id: WindowId,
    window: Weak<Window>,
    chrome: WindowChrome,
    devtools: DevToolsHandle,
    close_requester: WindowCloseRequester,
    parent: Option<WindowId>,
    modal: bool,
}

impl WindowHandle {
    pub(crate) fn new(
        id: WindowId,
        window: Weak<Window>,
        chrome: WindowChrome,
        devtools: DevToolsHandle,
        close_requester: WindowCloseRequester,
        parent: Option<WindowId>,
        modal: bool,
    ) -> Self {
        Self {
            id,
            window,
            chrome,
            devtools,
            close_requester,
            parent,
            modal,
        }
    }

    /// Returns the stable identity assigned when the window was opened.
    pub const fn id(&self) -> WindowId {
        self.id
    }

    /// Returns the live product parent selected when this window was opened, if any.
    pub const fn parent_id(&self) -> Option<WindowId> {
        self.parent
    }

    /// Returns whether this window disables its parent while it remains open.
    pub const fn is_modal(&self) -> bool {
        self.modal
    }

    /// Returns whether the application runtime still owns the native window.
    pub fn is_open(&self) -> bool {
        self.window.strong_count() > 0
    }

    /// Captures current platform state or reports that the window has closed.
    pub fn state(&self) -> Result<WindowState, WindowOperationError> {
        let window = self.live_window("window state query")?;
        Ok(WindowState::from_native(&window))
    }

    /// Schedules a redraw or reports that the window has closed.
    pub fn request_redraw(&self) -> Result<(), WindowOperationError> {
        self.live_window("redraw request")?.request_redraw();
        Ok(())
    }

    /// Requests a cancelable [`super::WindowEvent::CloseRequested`] callback on the main loop.
    pub fn close(&self) -> Result<(), WindowOperationError> {
        let operation = "window close request";
        let _window = self.live_window(operation)?;
        if !self.close_requester.request(self.id) {
            return Err(WindowOperationError::Disconnected {
                window: self.id,
                operation,
            });
        }
        Ok(())
    }

    /// Destroys this window without delivering a cancelable close request.
    pub fn destroy(&self) -> Result<(), WindowOperationError> {
        let operation = "window destroy request";
        let _window = self.live_window(operation)?;
        if !self.close_requester.destroy(self.id) {
            return Err(WindowOperationError::Disconnected {
                window: self.id,
                operation,
            });
        }
        Ok(())
    }

    /// Returns the shared DevTools session capability for this window.
    pub fn devtools(&self) -> DevToolsHandle {
        self.devtools.clone()
    }

    /// Opens the default zui DevTools window for this window and schedules a frame.
    pub fn open_devtools(&self) -> Result<(), WindowOperationError> {
        let window = self.live_window("open DevTools")?;
        self.devtools.open();
        window.request_redraw();
        Ok(())
    }

    /// Closes the default zui DevTools window for this window and schedules a frame.
    pub fn close_devtools(&self) -> Result<(), WindowOperationError> {
        let window = self.live_window("close DevTools")?;
        self.devtools.close();
        window.request_redraw();
        Ok(())
    }

    /// Toggles DevTools for this window and returns whether it is now open.
    pub fn toggle_devtools(&self) -> Result<bool, WindowOperationError> {
        let window = self.live_window("toggle DevTools")?;
        let is_open = self.devtools.toggle();
        window.request_redraw();
        Ok(is_open)
    }

    /// Returns whether DevTools is currently open for this window.
    pub fn is_devtools_open(&self) -> bool {
        self.devtools.is_open()
    }

    /// Begins a platform window drag when the runtime still owns the window.
    pub fn start_window_drag(&self) -> Result<(), WindowOperationError> {
        let operation = "window drag";
        self.live_window(operation)?
            .drag_window()
            .map_err(|source| map_external_error(self.id, operation, source))?;
        Ok(())
    }

    /// Updates the pointer cursor or reports that the window has closed.
    pub fn set_cursor(&self, cursor: CursorIcon) -> Result<(), WindowOperationError> {
        self.live_window("cursor update")?
            .set_cursor(cursor.into_native());
        Ok(())
    }

    /// Updates the platform window title or reports that the window has closed.
    pub fn set_title(&self, title: &str) -> Result<(), WindowOperationError> {
        self.live_window("title update")?.set_title(title);
        Ok(())
    }

    /// Requests a new logical inner size and returns an immediately applied physical extent.
    pub fn request_inner_logical_size(
        &self,
        size: LogicalSize,
    ) -> Result<Option<PhysicalExtent>, WindowOperationError> {
        if !size.is_valid() {
            return Err(WindowOperationError::InvalidSize {
                window: self.id,
                operation: "inner size request",
            });
        }
        Ok(self
            .live_window("inner size request")?
            .request_inner_size(size.into_native())
            .map(|size| PhysicalExtent::new(size.width, size.height)))
    }

    /// Returns the current outer top-left screen position in physical pixels.
    pub fn outer_position(&self) -> Result<PhysicalPosition, WindowOperationError> {
        let operation = "outer position query";
        let position = self
            .live_window(operation)?
            .outer_position()
            .map_err(|source| WindowOperationError::Platform {
                window: self.id,
                operation,
                source: Box::new(source),
            })?;
        Ok(PhysicalPosition::new(
            f64::from(position.x),
            f64::from(position.y),
        ))
    }

    /// Requests a new logical top-left screen position.
    pub fn set_outer_logical_position(
        &self,
        position: LogicalPosition,
    ) -> Result<(), WindowOperationError> {
        let operation = "outer position update";
        if !position.is_valid() {
            return Err(WindowOperationError::InvalidPosition {
                window: self.id,
                operation,
            });
        }
        let window = self.live_window(operation)?;
        if !programmatic_position_supported(&window) {
            return Err(WindowOperationError::Unsupported {
                window: self.id,
                operation,
            });
        }
        window.set_outer_position(position.into_native());
        Ok(())
    }

    /// Requests a native stacking level for this window.
    pub fn set_window_level(&self, level: WindowLevel) -> Result<(), WindowOperationError> {
        let operation = "window level update";
        let window = self.live_window(operation)?;
        if level != WindowLevel::Normal && !window_level_supported(&window) {
            return Err(WindowOperationError::Unsupported {
                window: self.id,
                operation,
            });
        }
        window.set_window_level(level.into_native());
        Ok(())
    }

    /// Shows or hides the native window.
    pub fn set_visible(&self, visible: bool) -> Result<(), WindowOperationError> {
        let operation = "visibility update";
        let window = self.live_window(operation)?;
        if !visibility_supported(&window) {
            return Err(WindowOperationError::Unsupported {
                window: self.id,
                operation,
            });
        }
        window.set_visible(visible);
        Ok(())
    }

    /// Requests keyboard focus for the native window.
    pub fn focus(&self) -> Result<(), WindowOperationError> {
        let operation = "focus request";
        let window = self.live_window(operation)?;
        if !focus_supported(&window) {
            return Err(WindowOperationError::Unsupported {
                window: self.id,
                operation,
            });
        }
        window.focus_window();
        Ok(())
    }

    /// Changes the platform minimization state.
    pub fn set_minimized(&self, minimized: bool) -> Result<(), WindowOperationError> {
        let operation = "minimization update";
        let window = self.live_window(operation)?;
        if !minimized && !minimized_restore_supported(&window) {
            return Err(WindowOperationError::Unsupported {
                window: self.id,
                operation,
            });
        }
        window.set_minimized(minimized);
        Ok(())
    }

    /// Changes the platform maximization state.
    pub fn set_maximized(&self, maximized: bool) -> Result<(), WindowOperationError> {
        self.live_window("maximization update")?
            .set_maximized(maximized);
        Ok(())
    }

    /// Enters or leaves borderless fullscreen mode.
    pub fn set_fullscreen(&self, fullscreen: bool) -> Result<(), WindowOperationError> {
        self.live_window("fullscreen update")?
            .set_fullscreen(fullscreen.then_some(winit::window::Fullscreen::Borderless(None)));
        Ok(())
    }

    /// Changes whether the user can resize the native window.
    pub fn set_resizable(&self, resizable: bool) -> Result<(), WindowOperationError> {
        self.live_window("resizability update")?
            .set_resizable(resizable);
        Ok(())
    }

    /// Enables platform text input or reports that the window has closed.
    pub fn enable_ime(&self) -> Result<(), WindowOperationError> {
        self.live_window("IME enable")?.set_ime_allowed(true);
        Ok(())
    }

    /// Disables platform text input or reports that the window has closed.
    pub fn disable_ime(&self) -> Result<(), WindowOperationError> {
        self.live_window("IME disable")?.set_ime_allowed(false);
        Ok(())
    }

    /// Updates the IME candidate area or reports that the window has closed.
    pub fn set_ime_cursor_area(&self, area: ImeCursorArea) -> Result<(), WindowOperationError> {
        self.live_window("IME cursor-area update")?
            .set_ime_cursor_area(
                NativeLogicalPosition::new(area.x, area.y),
                winit::dpi::LogicalSize::new(area.width, area.height),
            );
        Ok(())
    }

    /// Returns logical insets occupied by native controls for this window's chrome policy.
    pub fn window_control_insets(&self) -> WindowControlInsets {
        window_control_insets(self.chrome)
    }

    pub(crate) fn live_window(
        &self,
        operation: &'static str,
    ) -> Result<Arc<Window>, WindowOperationError> {
        self.window.upgrade().ok_or(WindowOperationError::Closed {
            window: self.id,
            operation,
        })
    }

    #[cfg(target_os = "windows")]
    pub(crate) fn native_hwnd(&self) -> Option<isize> {
        use raw_window_handle::HasWindowHandle;

        let window = self.window.upgrade()?;
        let handle = window.window_handle().ok()?;
        match handle.as_raw() {
            raw_window_handle::RawWindowHandle::Win32(handle) => Some(handle.hwnd.get()),
            _ => None,
        }
    }
}

#[cfg(test)]
#[path = "capability_tests.rs"]
mod tests;
