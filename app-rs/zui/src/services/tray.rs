use std::cell::RefCell;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::collections::HashMap;
use std::error::Error;
use std::fmt;
use std::rc::Rc;
use std::sync::Arc;

use super::MenuModel;
use super::SystemServiceError;

#[cfg(target_os = "linux")]
mod linux;

const TRAY_SERVICE: &str = "system tray";

/// Stable application-owned identity for one system-tray item.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct TrayId(String);

impl TrayId {
    /// Creates a non-empty tray identity.
    pub fn new(value: impl Into<String>) -> Result<Self, TrayIdError> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(TrayIdError);
        }
        Ok(Self(value))
    }

    /// Returns the stable string identity.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    fn from_native(value: &str) -> Self {
        Self(value.to_owned())
    }
}

/// Failure to create an empty tray identity.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TrayIdError;

impl fmt::Display for TrayIdError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("tray identity cannot be empty")
    }
}

impl Error for TrayIdError {}

/// Validated 32-bit RGBA artwork for a system-tray icon.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TrayIconImage {
    rgba: Vec<u8>,
    width: u32,
    height: u32,
}

impl TrayIconImage {
    /// Creates an icon when the pixel count exactly matches its dimensions.
    pub fn from_rgba(rgba: Vec<u8>, width: u32, height: u32) -> Result<Self, TrayIconImageError> {
        let expected = width
            .checked_mul(height)
            .and_then(|pixels| pixels.checked_mul(4))
            .and_then(|bytes| usize::try_from(bytes).ok());
        if width == 0 || height == 0 || expected != Some(rgba.len()) {
            return Err(TrayIconImageError);
        }
        Ok(Self {
            rgba,
            width,
            height,
        })
    }
}

/// Invalid dimensions or byte length supplied for tray artwork.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TrayIconImageError;

impl fmt::Display for TrayIconImageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("tray artwork must contain width * height RGBA pixels")
    }
}

impl Error for TrayIconImageError {}

/// Initial platform-independent configuration for one tray item.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TrayOptions {
    pub id: TrayId,
    pub icon: TrayIconImage,
    pub tooltip: Option<String>,
    pub title: Option<String>,
    pub menu: Option<MenuModel>,
    pub icon_is_template: bool,
}

impl TrayOptions {
    /// Creates a tray item with required identity and artwork.
    pub fn new(id: TrayId, icon: TrayIconImage) -> Self {
        Self {
            id,
            icon,
            tooltip: None,
            title: None,
            menu: None,
            icon_is_template: false,
        }
    }

    /// Sets text shown by platforms that support tray tooltips.
    pub fn with_tooltip(mut self, tooltip: impl Into<String>) -> Self {
        self.tooltip = Some(tooltip.into());
        self
    }

    /// Sets the optional platform tray title.
    pub fn with_title(mut self, title: impl Into<String>) -> Self {
        self.title = Some(title.into());
        self
    }

    /// Installs a context menu using the same stable menu model as application menus.
    pub fn with_menu(mut self, menu: MenuModel) -> Self {
        self.menu = Some(menu);
        self
    }

    /// Marks the artwork as a monochrome system template where the platform supports it.
    pub const fn as_template(mut self) -> Self {
        self.icon_is_template = true;
        self
    }
}

/// Mouse button reported by a system-tray interaction.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TrayMouseButton {
    Left,
    Right,
    Middle,
}

/// Press or release phase of a tray click.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TrayButtonState {
    Pressed,
    Released,
}

/// Platform-independent kind of system-tray interaction.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TrayEventKind {
    Click {
        button: TrayMouseButton,
        state: TrayButtonState,
    },
    DoubleClick {
        button: TrayMouseButton,
    },
    PointerEntered,
    PointerMoved,
    PointerLeft,
}

/// Physical screen coordinate reported for a tray interaction.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TrayPosition {
    pub x: f64,
    pub y: f64,
}

/// Physical screen bounds occupied by a tray item.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TrayBounds {
    pub position: TrayPosition,
    pub width: u32,
    pub height: u32,
}

/// One interaction emitted by a runtime-owned tray item.
#[derive(Clone, Debug, PartialEq)]
pub struct TrayEvent {
    pub id: TrayId,
    pub kind: TrayEventKind,
    pub position: TrayPosition,
    pub bounds: TrayBounds,
}

/// Thread-safe callback installed by the runtime to receive native tray interactions.
pub type TrayEventHandler = Arc<dyn Fn(TrayEvent) + Send + Sync>;

/// Main-thread backend for creating and updating application tray items.
pub trait TrayService {
    /// Creates one tray item and retains it until explicitly removed or runtime shutdown.
    fn create(&mut self, options: TrayOptions) -> Result<(), SystemServiceError>;

    /// Removes a tray item. Removing an unknown identity is a no-op.
    fn remove(&mut self, id: &TrayId);

    /// Shows or hides an existing tray item.
    fn set_visible(&mut self, id: &TrayId, visible: bool) -> Result<(), SystemServiceError>;

    /// Replaces the context menu for an existing tray item.
    fn set_menu(&mut self, id: &TrayId, menu: MenuModel) -> Result<(), SystemServiceError>;

    /// Installs or clears the runtime event callback.
    fn set_event_handler(&mut self, handler: Option<TrayEventHandler>);
}

/// Cloneable main-thread capability for owning system-tray items.
#[derive(Clone)]
pub struct TrayHandle {
    service: Rc<RefCell<Box<dyn TrayService>>>,
}

impl TrayHandle {
    pub(crate) fn new(service: impl TrayService + 'static) -> Self {
        Self {
            service: Rc::new(RefCell::new(Box::new(service))),
        }
    }

    /// Creates one runtime-owned tray item.
    pub fn create(&self, options: TrayOptions) -> Result<(), SystemServiceError> {
        if let Some(menu) = &options.menu {
            validate_menu(menu)?;
        }
        self.service.borrow_mut().create(options)
    }

    /// Removes one runtime-owned tray item.
    pub fn remove(&self, id: &TrayId) {
        self.service.borrow_mut().remove(id);
    }

    /// Shows or hides one tray item.
    pub fn set_visible(&self, id: &TrayId, visible: bool) -> Result<(), SystemServiceError> {
        self.service.borrow_mut().set_visible(id, visible)
    }

    /// Replaces one tray item's context menu.
    pub fn set_menu(&self, id: &TrayId, menu: MenuModel) -> Result<(), SystemServiceError> {
        validate_menu(&menu)?;
        self.service.borrow_mut().set_menu(id, menu)
    }

    pub(crate) fn set_event_handler(&self, handler: Option<TrayEventHandler>) {
        self.service.borrow_mut().set_event_handler(handler);
    }
}

fn validate_menu(menu: &MenuModel) -> Result<(), SystemServiceError> {
    menu.validate()
        .map_err(|source| SystemServiceError::invalid_input(TRAY_SERVICE, source))
}

/// Default native tray backend for Linux, macOS, and Windows.
#[derive(Default)]
pub struct SystemTray {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    icons: HashMap<TrayId, tray_icon::TrayIcon>,
    #[cfg(target_os = "linux")]
    runtime: Option<linux::LinuxTrayRuntime>,
    #[cfg(target_os = "linux")]
    handler: Arc<std::sync::Mutex<Option<TrayEventHandler>>>,
}

impl TrayService for SystemTray {
    fn create(&mut self, options: TrayOptions) -> Result<(), SystemServiceError> {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            if self.icons.contains_key(&options.id) {
                return Err(duplicate_tray_error(options.id.as_str()));
            }
            let icon = tray_icon::Icon::from_rgba(
                options.icon.rgba,
                options.icon.width,
                options.icon.height,
            )
            .map_err(|source| SystemServiceError::backend(TRAY_SERVICE, source))?;
            let mut builder = tray_icon::TrayIconBuilder::new()
                .with_id(options.id.as_str())
                .with_icon(icon)
                .with_icon_as_template(options.icon_is_template);
            if let Some(tooltip) = options.tooltip {
                builder = builder.with_tooltip(tooltip);
            }
            if let Some(title) = options.title {
                builder = builder.with_title(title);
            }
            if let Some(model) = options.menu {
                let menu = super::menu::build_native_menu(model)?;
                builder = builder.with_menu(Box::new(menu));
            }
            let icon = builder
                .build()
                .map_err(|source| SystemServiceError::backend(TRAY_SERVICE, source))?;
            self.icons.insert(options.id, icon);
            Ok(())
        }
        #[cfg(target_os = "linux")]
        {
            self.linux_runtime()?.create(options)
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
        {
            let _ = options;
            Err(SystemServiceError::unsupported(TRAY_SERVICE))
        }
    }

    fn remove(&mut self, id: &TrayId) {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        self.icons.remove(id);
        #[cfg(target_os = "linux")]
        if let Some(runtime) = &self.runtime {
            runtime.remove(id);
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
        let _ = id;
    }

    fn set_visible(&mut self, id: &TrayId, visible: bool) -> Result<(), SystemServiceError> {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            let icon = self.icons.get(id).ok_or_else(|| missing_tray_error(id))?;
            icon.set_visible(visible)
                .map_err(|source| SystemServiceError::backend(TRAY_SERVICE, source))
        }
        #[cfg(target_os = "linux")]
        {
            self.linux_runtime()?.set_visible(id, visible)
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
        {
            let _ = (id, visible);
            Err(SystemServiceError::unsupported(TRAY_SERVICE))
        }
    }

    fn set_menu(&mut self, id: &TrayId, menu: MenuModel) -> Result<(), SystemServiceError> {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            let icon = self.icons.get(id).ok_or_else(|| missing_tray_error(id))?;
            icon.set_menu(Some(Box::new(super::menu::build_native_menu(menu)?)));
            Ok(())
        }
        #[cfg(target_os = "linux")]
        {
            self.linux_runtime()?.set_menu(id, menu)
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
        {
            let _ = (id, menu);
            Err(SystemServiceError::unsupported(TRAY_SERVICE))
        }
    }

    fn set_event_handler(&mut self, handler: Option<TrayEventHandler>) {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        tray_icon::TrayIconEvent::set_event_handler(
            handler.map(|handler| move |event| handler(TrayEvent::from_native(event))),
        );
        #[cfg(target_os = "linux")]
        {
            *self.handler.lock().expect("Linux tray handler lock") = handler;
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
        let _ = handler;
    }
}

#[cfg(target_os = "linux")]
impl SystemTray {
    fn linux_runtime(&mut self) -> Result<&linux::LinuxTrayRuntime, SystemServiceError> {
        if self.runtime.is_none() {
            self.runtime = Some(linux::LinuxTrayRuntime::new(self.handler.clone())?);
        }
        Ok(self
            .runtime
            .as_ref()
            .expect("Linux tray runtime initialized"))
    }
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
impl TrayEvent {
    fn from_native(event: tray_icon::TrayIconEvent) -> Self {
        use tray_icon::TrayIconEvent;

        let (id, kind, position, rect) = match event {
            TrayIconEvent::Click {
                id,
                position,
                rect,
                button,
                button_state,
            } => (
                id,
                TrayEventKind::Click {
                    button: tray_button(button),
                    state: match button_state {
                        tray_icon::MouseButtonState::Down => TrayButtonState::Pressed,
                        tray_icon::MouseButtonState::Up => TrayButtonState::Released,
                    },
                },
                position,
                rect,
            ),
            TrayIconEvent::DoubleClick {
                id,
                position,
                rect,
                button,
            } => (
                id,
                TrayEventKind::DoubleClick {
                    button: tray_button(button),
                },
                position,
                rect,
            ),
            TrayIconEvent::Enter { id, position, rect } => {
                (id, TrayEventKind::PointerEntered, position, rect)
            }
            TrayIconEvent::Move { id, position, rect } => {
                (id, TrayEventKind::PointerMoved, position, rect)
            }
            TrayIconEvent::Leave { id, position, rect } => {
                (id, TrayEventKind::PointerLeft, position, rect)
            }
            _ => unreachable!("all tray event variants are converted by zui"),
        };
        Self {
            id: TrayId::from_native(id.as_ref()),
            kind,
            position: TrayPosition {
                x: position.x,
                y: position.y,
            },
            bounds: TrayBounds {
                position: TrayPosition {
                    x: rect.position.x,
                    y: rect.position.y,
                },
                width: rect.size.width,
                height: rect.size.height,
            },
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
fn tray_button(button: tray_icon::MouseButton) -> TrayMouseButton {
    match button {
        tray_icon::MouseButton::Left => TrayMouseButton::Left,
        tray_icon::MouseButton::Right => TrayMouseButton::Right,
        tray_icon::MouseButton::Middle => TrayMouseButton::Middle,
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn duplicate_tray_error(id: &str) -> SystemServiceError {
    SystemServiceError::backend(
        TRAY_SERVICE,
        std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            format!("tray identity `{id}` already exists"),
        ),
    )
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn missing_tray_error(id: &TrayId) -> SystemServiceError {
    SystemServiceError::backend(
        TRAY_SERVICE,
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("tray identity `{}` does not exist", id.as_str()),
        ),
    )
}
