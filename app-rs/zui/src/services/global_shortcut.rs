use std::cell::RefCell;
use std::collections::HashMap;
use std::error::Error;
use std::fmt;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::Mutex;

use super::SystemServiceError;

#[cfg(any(target_os = "linux", all(test, target_os = "macos")))]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
mod portal;

const GLOBAL_SHORTCUT_SERVICE: &str = "global shortcut";

/// Stable application-owned identity for one registered global shortcut.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct GlobalShortcutId(String);

impl GlobalShortcutId {
    /// Creates a non-empty shortcut identity.
    pub fn new(value: impl Into<String>) -> Result<Self, GlobalShortcutIdError> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(GlobalShortcutIdError);
        }
        Ok(Self(value))
    }

    /// Returns the stable application-owned identity.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Failure to create an empty global-shortcut identity.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GlobalShortcutIdError;

impl fmt::Display for GlobalShortcutIdError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("global shortcut identity cannot be empty")
    }
}

impl Error for GlobalShortcutIdError {}

/// Validated, portable accelerator such as `CommandOrControl+Shift+KeyP`.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ShortcutAccelerator(String);

impl ShortcutAccelerator {
    /// Parses an accelerator without exposing the concrete platform hotkey crate.
    pub fn parse(value: impl Into<String>) -> Result<Self, ShortcutAcceleratorError> {
        let value = value.into();
        value
            .parse::<global_hotkey::hotkey::HotKey>()
            .map_err(|error| ShortcutAcceleratorError(error.to_string()))?;
        Ok(Self(value))
    }

    /// Returns the normalized input spelling retained by ZUI.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn to_native(
        &self,
    ) -> Result<global_hotkey::hotkey::HotKey, global_hotkey::hotkey::HotKeyParseError> {
        self.0.parse()
    }
}

/// Invalid global-shortcut accelerator.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShortcutAcceleratorError(String);

impl fmt::Display for ShortcutAcceleratorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "invalid global shortcut accelerator: {}", self.0)
    }
}

impl Error for ShortcutAcceleratorError {}

/// Application-owned registration of a system-wide keyboard shortcut.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GlobalShortcut {
    pub id: GlobalShortcutId,
    pub accelerator: ShortcutAccelerator,
}

impl GlobalShortcut {
    /// Creates one registration from stable identity and validated accelerator.
    pub const fn new(id: GlobalShortcutId, accelerator: ShortcutAccelerator) -> Self {
        Self { id, accelerator }
    }
}

/// Press or release phase of a global shortcut.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GlobalShortcutState {
    Pressed,
    Released,
}

/// Global shortcut interaction delivered on the ZUI application thread.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GlobalShortcutEvent {
    pub id: GlobalShortcutId,
    pub state: GlobalShortcutState,
}

/// Thread-safe callback installed by the runtime to receive native shortcut interactions.
pub type GlobalShortcutEventHandler = Arc<dyn Fn(GlobalShortcutEvent) + Send + Sync>;

/// Main-thread backend for system-wide keyboard shortcut registrations.
pub trait GlobalShortcutService {
    /// Registers one global shortcut until explicitly removed or runtime shutdown.
    fn register(&mut self, shortcut: GlobalShortcut) -> Result<(), SystemServiceError>;

    /// Removes one registration. Removing an unknown identity is a no-op.
    fn unregister(&mut self, id: &GlobalShortcutId) -> Result<(), SystemServiceError>;

    /// Removes all registrations owned by the application runtime.
    fn unregister_all(&mut self) -> Result<(), SystemServiceError>;

    /// Installs or clears the runtime event callback.
    fn set_event_handler(&mut self, handler: Option<GlobalShortcutEventHandler>);
}

/// Cloneable main-thread capability for system-wide keyboard shortcuts.
#[derive(Clone)]
pub struct GlobalShortcutHandle {
    service: Rc<RefCell<Box<dyn GlobalShortcutService>>>,
}

impl GlobalShortcutHandle {
    pub(crate) fn new(service: impl GlobalShortcutService + 'static) -> Self {
        Self {
            service: Rc::new(RefCell::new(Box::new(service))),
        }
    }

    /// Registers one shortcut through the injected backend.
    pub fn register(&self, shortcut: GlobalShortcut) -> Result<(), SystemServiceError> {
        self.service.borrow_mut().register(shortcut)
    }

    /// Removes one shortcut registration.
    pub fn unregister(&self, id: &GlobalShortcutId) -> Result<(), SystemServiceError> {
        self.service.borrow_mut().unregister(id)
    }

    /// Removes all shortcut registrations owned by this runtime.
    pub fn unregister_all(&self) -> Result<(), SystemServiceError> {
        self.service.borrow_mut().unregister_all()
    }

    pub(crate) fn set_event_handler(&self, handler: Option<GlobalShortcutEventHandler>) {
        self.service.borrow_mut().set_event_handler(handler);
    }
}

/// Default desktop global-shortcut backend.
#[derive(Default)]
pub struct SystemGlobalShortcuts {
    manager: Option<global_hotkey::GlobalHotKeyManager>,
    registrations: HashMap<GlobalShortcutId, global_hotkey::hotkey::HotKey>,
    event_ids: Arc<Mutex<HashMap<u32, GlobalShortcutId>>>,
    handler: Arc<Mutex<Option<GlobalShortcutEventHandler>>>,
    #[cfg(target_os = "linux")]
    portal: Option<portal::PortalGlobalShortcuts>,
    #[cfg(target_os = "linux")]
    portal_registrations: HashMap<GlobalShortcutId, GlobalShortcut>,
}

impl SystemGlobalShortcuts {
    fn manager(&mut self) -> Result<&global_hotkey::GlobalHotKeyManager, SystemServiceError> {
        if self.manager.is_none() {
            self.manager =
                Some(global_hotkey::GlobalHotKeyManager::new().map_err(|source| {
                    SystemServiceError::backend(GLOBAL_SHORTCUT_SERVICE, source)
                })?);
        }
        Ok(self.manager.as_ref().expect("shortcut manager initialized"))
    }

    #[cfg(target_os = "linux")]
    fn portal(&mut self) -> Result<&portal::PortalGlobalShortcuts, SystemServiceError> {
        if self.portal.is_none() {
            self.portal = Some(portal::PortalGlobalShortcuts::new(self.handler.clone())?);
        }
        Ok(self.portal.as_ref().expect("shortcut portal initialized"))
    }
}

impl GlobalShortcutService for SystemGlobalShortcuts {
    fn register(&mut self, shortcut: GlobalShortcut) -> Result<(), SystemServiceError> {
        #[cfg(target_os = "linux")]
        if portal::is_wayland_session() {
            if self.portal_registrations.contains_key(&shortcut.id) {
                return Err(shortcut_exists_error(shortcut.id.as_str()));
            }
            if self
                .portal_registrations
                .values()
                .any(|registered| registered.accelerator == shortcut.accelerator)
            {
                return Err(accelerator_exists_error(shortcut.accelerator.as_str()));
            }
            let mut registrations = self
                .portal_registrations
                .values()
                .cloned()
                .collect::<Vec<_>>();
            registrations.push(shortcut.clone());
            self.portal()?.replace(registrations)?;
            self.portal_registrations
                .insert(shortcut.id.clone(), shortcut);
            return Ok(());
        }
        if self.registrations.contains_key(&shortcut.id) {
            return Err(shortcut_exists_error(shortcut.id.as_str()));
        }
        let native = shortcut
            .accelerator
            .to_native()
            .map_err(|source| SystemServiceError::backend(GLOBAL_SHORTCUT_SERVICE, source))?;
        if self
            .event_ids
            .lock()
            .expect("global shortcut registry lock")
            .contains_key(&native.id())
        {
            return Err(accelerator_exists_error(shortcut.accelerator.as_str()));
        }
        self.manager()?
            .register(native)
            .map_err(|source| SystemServiceError::backend(GLOBAL_SHORTCUT_SERVICE, source))?;
        self.event_ids
            .lock()
            .expect("global shortcut registry lock")
            .insert(native.id(), shortcut.id.clone());
        self.registrations.insert(shortcut.id, native);
        Ok(())
    }

    fn unregister(&mut self, id: &GlobalShortcutId) -> Result<(), SystemServiceError> {
        #[cfg(target_os = "linux")]
        if portal::is_wayland_session() {
            if !self.portal_registrations.contains_key(id) {
                return Ok(());
            }
            let registrations = self
                .portal_registrations
                .iter()
                .filter(|(registered_id, _)| *registered_id != id)
                .map(|(_, shortcut)| shortcut.clone())
                .collect::<Vec<_>>();
            self.portal()?.replace(registrations)?;
            self.portal_registrations.remove(id);
            return Ok(());
        }
        let Some(native) = self.registrations.remove(id) else {
            return Ok(());
        };
        if let Some(manager) = &self.manager {
            manager
                .unregister(native)
                .map_err(|source| SystemServiceError::backend(GLOBAL_SHORTCUT_SERVICE, source))?;
        }
        self.event_ids
            .lock()
            .expect("global shortcut registry lock")
            .remove(&native.id());
        Ok(())
    }

    fn unregister_all(&mut self) -> Result<(), SystemServiceError> {
        #[cfg(target_os = "linux")]
        if portal::is_wayland_session() {
            if let Some(portal) = &self.portal {
                portal.replace(Vec::new())?;
            }
            self.portal_registrations.clear();
            return Ok(());
        }
        let registrations = std::mem::take(&mut self.registrations);
        if let Some(manager) = &self.manager {
            let hotkeys = registrations.values().copied().collect::<Vec<_>>();
            manager
                .unregister_all(&hotkeys)
                .map_err(|source| SystemServiceError::backend(GLOBAL_SHORTCUT_SERVICE, source))?;
        }
        self.event_ids
            .lock()
            .expect("global shortcut registry lock")
            .clear();
        Ok(())
    }

    fn set_event_handler(&mut self, handler: Option<GlobalShortcutEventHandler>) {
        *self.handler.lock().expect("global shortcut handler lock") = handler;
        #[cfg(target_os = "linux")]
        if portal::is_wayland_session() {
            return;
        }
        let event_ids = self.event_ids.clone();
        let handler = self.handler.clone();
        global_hotkey::GlobalHotKeyEvent::set_event_handler(Some(
            move |event: global_hotkey::GlobalHotKeyEvent| {
                let id = event_ids
                    .lock()
                    .expect("global shortcut registry lock")
                    .get(&event.id)
                    .cloned();
                let handler = handler
                    .lock()
                    .expect("global shortcut handler lock")
                    .clone();
                if let (Some(id), Some(handler)) = (id, handler) {
                    handler(GlobalShortcutEvent {
                        id,
                        state: match event.state {
                            global_hotkey::HotKeyState::Pressed => GlobalShortcutState::Pressed,
                            global_hotkey::HotKeyState::Released => GlobalShortcutState::Released,
                        },
                    });
                }
            },
        ));
    }
}

fn shortcut_exists_error(id: &str) -> SystemServiceError {
    SystemServiceError::backend(
        GLOBAL_SHORTCUT_SERVICE,
        std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            format!("shortcut identity `{id}` is already registered"),
        ),
    )
}

fn accelerator_exists_error(accelerator: &str) -> SystemServiceError {
    SystemServiceError::backend(
        GLOBAL_SHORTCUT_SERVICE,
        std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            format!("shortcut accelerator `{accelerator}` is already registered"),
        ),
    )
}
