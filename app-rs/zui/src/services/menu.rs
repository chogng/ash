#[cfg(target_os = "windows")]
use std::cell::Cell;
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use super::SystemServiceError;

mod model;
#[cfg(target_os = "windows")]
mod windows;

pub use model::MenuAboutMetadata;
pub use model::MenuAccelerator;
pub use model::MenuAcceleratorError;
pub use model::MenuAction;
pub use model::MenuEntry;
pub use model::MenuGroup;
pub use model::MenuItemId;
pub use model::MenuItemIdError;
pub use model::MenuModel;
pub use model::MenuModelError;
pub use model::MenuRole;
pub use model::MenuRoleItem;

const MENU_SERVICE: &str = "native application menu";

/// Thread-safe callback installed by the runtime to receive native menu actions.
pub type MenuEventHandler = Arc<dyn Fn(MenuItemId) + Send + Sync>;

/// Main-thread native menu backend used through an injectable [`MenuHandle`].
pub trait MenuService {
    /// Replaces the current application menu.
    fn set_application_menu(&mut self, model: MenuModel) -> Result<(), SystemServiceError>;

    /// Installs or clears the runtime event callback.
    fn set_event_handler(&mut self, handler: Option<MenuEventHandler>);

    /// Attaches the current application menu to a newly opened window on platforms with
    /// per-window native menu ownership.
    fn attach_window(
        &mut self,
        _window: crate::window::WindowHandle,
    ) -> Result<(), SystemServiceError> {
        Ok(())
    }

    /// Detaches native menu resources before a runtime-owned window is destroyed.
    fn detach_window(&mut self, _window: crate::window::WindowId) {}

    /// Exposes the live Windows accelerator table to the native event-loop bridge.
    #[cfg(target_os = "windows")]
    #[doc(hidden)]
    fn accelerator_table(&self) -> Option<Rc<Cell<isize>>> {
        None
    }
}

/// Cloneable main-thread capability for configuring the application menu.
#[derive(Clone)]
pub struct MenuHandle {
    service: Rc<RefCell<Box<dyn MenuService>>>,
}

impl MenuHandle {
    pub(crate) fn new(service: impl MenuService + 'static) -> Self {
        Self {
            service: Rc::new(RefCell::new(Box::new(service))),
        }
    }

    /// Replaces the application menu through the injected backend.
    pub fn set_application_menu(&self, model: MenuModel) -> Result<(), SystemServiceError> {
        model
            .validate()
            .map_err(|source| SystemServiceError::invalid_input(MENU_SERVICE, source))?;
        self.service.borrow_mut().set_application_menu(model)
    }

    pub(crate) fn set_event_handler(&self, handler: Option<MenuEventHandler>) {
        self.service.borrow_mut().set_event_handler(handler);
    }

    pub(crate) fn attach_window(
        &self,
        window: crate::window::WindowHandle,
    ) -> Result<(), SystemServiceError> {
        self.service.borrow_mut().attach_window(window)
    }

    pub(crate) fn detach_window(&self, window: crate::window::WindowId) {
        self.service.borrow_mut().detach_window(window);
    }

    #[cfg(target_os = "windows")]
    pub(crate) fn accelerator_table(&self) -> Option<Rc<Cell<isize>>> {
        self.service.borrow().accelerator_table()
    }
}

/// Default native application-menu backend.
#[derive(Default)]
pub struct SystemMenu {
    #[cfg(target_os = "macos")]
    menu: Option<muda::Menu>,
    #[cfg(target_os = "windows")]
    menu: Option<muda::Menu>,
    #[cfg(target_os = "windows")]
    windows: std::collections::HashMap<crate::window::WindowId, isize>,
    #[cfg(target_os = "windows")]
    accelerator_table: Rc<Cell<isize>>,
}

impl MenuService for SystemMenu {
    fn set_application_menu(&mut self, model: MenuModel) -> Result<(), SystemServiceError> {
        #[cfg(target_os = "macos")]
        {
            let menu = build_native_menu(model)?;
            menu.init_for_nsapp();
            self.menu = Some(menu);
            Ok(())
        }
        #[cfg(target_os = "windows")]
        {
            let menu = build_native_menu(model)?;
            let previous = self.menu.take();
            self.accelerator_table.set(0);
            if let Some(previous) = &previous {
                for hwnd in self.windows.values().copied() {
                    let _ = windows::remove(previous, hwnd);
                }
            }
            let mut attached = Vec::new();
            for hwnd in self.windows.values().copied() {
                if let Err(source) = windows::attach(&menu, hwnd) {
                    for hwnd in attached {
                        let _ = windows::remove(&menu, hwnd);
                    }
                    if let Some(previous) = previous {
                        for hwnd in self.windows.values().copied() {
                            let _ = windows::attach(&previous, hwnd);
                        }
                        self.accelerator_table.set(previous.haccel());
                        self.menu = Some(previous);
                    }
                    return Err(source);
                }
                attached.push(hwnd);
            }
            self.accelerator_table.set(menu.haccel());
            self.menu = Some(menu);
            Ok(())
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let _ = model;
            Err(SystemServiceError::unsupported("native application menu"))
        }
    }

    fn set_event_handler(&mut self, handler: Option<MenuEventHandler>) {
        #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
        {
            muda::MenuEvent::set_event_handler(handler.map(|handler| {
                move |event: muda::MenuEvent| {
                    handler(MenuItemId::from_native(event.id.as_ref()));
                }
            }));
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
        let _ = handler;
    }

    fn attach_window(
        &mut self,
        window: crate::window::WindowHandle,
    ) -> Result<(), SystemServiceError> {
        #[cfg(target_os = "windows")]
        {
            if !window.is_open() {
                return Err(SystemServiceError::backend(
                    "native application menu",
                    std::io::Error::other("menu target window is no longer live"),
                ));
            }
            let id = window.id();
            if self.windows.contains_key(&id) {
                return Ok(());
            }
            let hwnd = window.native_hwnd().ok_or_else(|| {
                SystemServiceError::backend(
                    "native application menu",
                    std::io::Error::other("window does not expose a Win32 HWND"),
                )
            })?;
            if let Some(menu) = &self.menu {
                windows::attach(menu, hwnd)?;
            }
            self.windows.insert(id, hwnd);
        }
        #[cfg(not(target_os = "windows"))]
        let _ = window;
        Ok(())
    }

    fn detach_window(&mut self, window: crate::window::WindowId) {
        #[cfg(target_os = "windows")]
        if let Some(hwnd) = self.windows.remove(&window)
            && let Some(menu) = &self.menu
        {
            let _ = windows::remove(menu, hwnd);
        }
        #[cfg(not(target_os = "windows"))]
        let _ = window;
    }

    #[cfg(target_os = "windows")]
    fn accelerator_table(&self) -> Option<Rc<Cell<isize>>> {
        Some(self.accelerator_table.clone())
    }
}

impl Drop for SystemMenu {
    fn drop(&mut self) {
        #[cfg(target_os = "windows")]
        self.accelerator_table.set(0);
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn translate_accelerator(table: &Cell<isize>, message: *const std::ffi::c_void) -> bool {
    windows::translate_accelerator(table, message)
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
pub(super) fn build_native_menu(model: MenuModel) -> Result<muda::Menu, SystemServiceError> {
    model
        .validate()
        .map_err(|source| SystemServiceError::invalid_input(MENU_SERVICE, source))?;
    let menu = muda::Menu::new();
    for group in model.groups {
        let submenu = build_submenu(group)?;
        menu.append(&submenu)
            .map_err(|source| SystemServiceError::backend("native application menu", source))?;
    }
    Ok(menu)
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
fn build_submenu(group: MenuGroup) -> Result<muda::Submenu, SystemServiceError> {
    let submenu = muda::Submenu::with_id(group.id.as_str(), group.label, group.enabled);
    for entry in group.entries {
        match entry {
            MenuEntry::Action(action) => {
                let accelerator = action
                    .accelerator
                    .as_ref()
                    .map(MenuAccelerator::to_native)
                    .transpose()
                    .map_err(|source| SystemServiceError::invalid_input(MENU_SERVICE, source))?;
                if let Some(checked) = action.checked {
                    let item = muda::CheckMenuItem::with_id(
                        action.id.as_str(),
                        action.label,
                        action.enabled,
                        checked,
                        accelerator,
                    );
                    append_item(&submenu, &item)?;
                } else {
                    let item = muda::MenuItem::with_id(
                        action.id.as_str(),
                        action.label,
                        action.enabled,
                        accelerator,
                    );
                    append_item(&submenu, &item)?;
                }
            }
            MenuEntry::Role(role) => {
                let item = build_role(role)?;
                append_item(&submenu, &item)?;
            }
            MenuEntry::Separator => {
                let separator = muda::PredefinedMenuItem::separator();
                append_item(&submenu, &separator)?;
            }
            MenuEntry::Submenu(group) => {
                let child = build_submenu(group)?;
                append_item(&submenu, &child)?;
            }
        }
    }
    Ok(submenu)
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
fn append_item(
    submenu: &muda::Submenu,
    item: &dyn muda::IsMenuItem,
) -> Result<(), SystemServiceError> {
    submenu
        .append(item)
        .map_err(|source| SystemServiceError::backend(MENU_SERVICE, source))
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
fn build_role(role: MenuRoleItem) -> Result<muda::PredefinedMenuItem, SystemServiceError> {
    if !role_supported(&role.role) {
        return Err(SystemServiceError::unsupported("native menu role"));
    }
    let label = role.label.as_deref();
    Ok(match role.role {
        MenuRole::Copy => muda::PredefinedMenuItem::copy(label),
        MenuRole::Cut => muda::PredefinedMenuItem::cut(label),
        MenuRole::Paste => muda::PredefinedMenuItem::paste(label),
        MenuRole::SelectAll => muda::PredefinedMenuItem::select_all(label),
        MenuRole::Undo => muda::PredefinedMenuItem::undo(label),
        MenuRole::Redo => muda::PredefinedMenuItem::redo(label),
        MenuRole::Minimize => muda::PredefinedMenuItem::minimize(label),
        MenuRole::Maximize => muda::PredefinedMenuItem::maximize(label),
        MenuRole::Fullscreen => muda::PredefinedMenuItem::fullscreen(label),
        MenuRole::Hide => muda::PredefinedMenuItem::hide(label),
        MenuRole::HideOthers => muda::PredefinedMenuItem::hide_others(label),
        MenuRole::ShowAll => muda::PredefinedMenuItem::show_all(label),
        MenuRole::CloseWindow => muda::PredefinedMenuItem::close_window(label),
        MenuRole::Quit => muda::PredefinedMenuItem::quit(label),
        MenuRole::About(metadata) => {
            muda::PredefinedMenuItem::about(label, Some((*metadata).into_native()))
        }
        MenuRole::Services => muda::PredefinedMenuItem::services(label),
        MenuRole::BringAllToFront => muda::PredefinedMenuItem::bring_all_to_front(label),
    })
}

#[cfg(target_os = "macos")]
const fn role_supported(_role: &MenuRole) -> bool {
    true
}

#[cfg(target_os = "windows")]
const fn role_supported(role: &MenuRole) -> bool {
    matches!(
        role,
        MenuRole::Copy
            | MenuRole::Cut
            | MenuRole::Paste
            | MenuRole::SelectAll
            | MenuRole::Undo
            | MenuRole::Redo
            | MenuRole::Minimize
            | MenuRole::Maximize
            | MenuRole::Hide
            | MenuRole::CloseWindow
            | MenuRole::Quit
            | MenuRole::About(_)
    )
}

#[cfg(target_os = "linux")]
const fn role_supported(role: &MenuRole) -> bool {
    matches!(
        role,
        MenuRole::Copy | MenuRole::Cut | MenuRole::Paste | MenuRole::SelectAll | MenuRole::About(_)
    )
}

#[cfg(test)]
#[path = "menu_tests.rs"]
mod tests;
