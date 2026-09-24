#![allow(unsafe_code)]

use std::error::Error;
use std::fmt;

use raw_window_handle::HandleError;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use raw_window_handle::HasWindowHandle;
use winit::window::Window;
use winit::window::WindowAttributes;

/// Failure while translating a validated ZUI parent into native window attributes.
#[derive(Debug)]
pub(crate) enum NativeWindowCreateError {
    Window(winit::error::OsError),
    ParentHandle(HandleError),
    #[cfg(target_os = "windows")]
    UnexpectedParentHandle,
}

impl NativeWindowCreateError {
    pub(crate) const fn window(source: winit::error::OsError) -> Self {
        Self::Window(source)
    }
}

impl fmt::Display for NativeWindowCreateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Window(source) => source.fmt(formatter),
            Self::ParentHandle(source) => {
                write!(formatter, "could not access parent window: {source}")
            }
            #[cfg(target_os = "windows")]
            Self::UnexpectedParentHandle => {
                formatter.write_str("parent window exposed an unexpected platform handle")
            }
        }
    }
}

impl Error for NativeWindowCreateError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Window(source) => Some(source),
            Self::ParentHandle(source) => Some(source),
            #[cfg(target_os = "windows")]
            Self::UnexpectedParentHandle => None,
        }
    }
}

impl From<HandleError> for NativeWindowCreateError {
    fn from(source: HandleError) -> Self {
        Self::ParentHandle(source)
    }
}

pub(crate) fn apply_parent(
    attributes: WindowAttributes,
    parent: Option<&Window>,
) -> Result<WindowAttributes, NativeWindowCreateError> {
    let Some(parent) = parent else {
        return Ok(attributes);
    };

    #[cfg(target_os = "macos")]
    {
        let parent = parent.window_handle()?.as_raw();
        // SAFETY: the application registry owns `parent` throughout synchronous child creation.
        Ok(unsafe { attributes.with_parent_window(Some(parent)) })
    }

    #[cfg(target_os = "windows")]
    {
        use raw_window_handle::RawWindowHandle;
        use winit::platform::windows::WindowAttributesExtWindows;

        match parent.window_handle()?.as_raw() {
            RawWindowHandle::Win32(parent) => Ok(attributes.with_owner_window(parent.hwnd.get())),
            _ => Err(NativeWindowCreateError::UnexpectedParentHandle),
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = parent;
        Ok(attributes)
    }
}
