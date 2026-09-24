use std::cell::Cell;
use std::cell::RefCell;
use std::rc::Rc;

use super::DesktopFileName;
use super::SystemServiceError;

#[path = "application_badge/platform.rs"]
mod platform;

const APPLICATION_BADGE: &str = "application badge";

/// Badge content requested for the application launcher or Dock icon.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ApplicationBadge {
    /// Hides any currently displayed badge.
    #[default]
    Hidden,
    /// Displays a number-independent marker where supported and hides the badge on Linux.
    Indeterminate,
    /// Displays one signed counter value; zero has the same platform effect as [`Self::Hidden`].
    Count(i64),
}

impl ApplicationBadge {
    /// Converts an Electron-style badge count, treating zero as hidden.
    pub const fn from_count(count: i64) -> Self {
        if count == 0 {
            Self::Hidden
        } else {
            Self::Count(count)
        }
    }

    /// Returns the numeric badge value, or zero for hidden and indeterminate badges.
    pub const fn count(self) -> i64 {
        match self {
            Self::Count(count) => count,
            Self::Hidden | Self::Indeterminate => 0,
        }
    }

    /// Returns whether this request asks a supported platform to draw badge content.
    pub const fn is_visible(self) -> bool {
        !matches!(self, Self::Hidden | Self::Count(0))
    }

    #[cfg(any(target_os = "macos", test))]
    fn display_label(self) -> Option<String> {
        match self {
            Self::Hidden | Self::Count(0) => None,
            Self::Indeterminate => Some("•".to_owned()),
            Self::Count(count) if count > 99 => Some("99+".to_owned()),
            Self::Count(count) => Some(count.to_string()),
        }
    }
}

/// Fully resolved application badge mutation passed to an injected backend.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ApplicationBadgeRequest {
    badge: ApplicationBadge,
    desktop_file_name: Option<DesktopFileName>,
}

impl ApplicationBadgeRequest {
    /// Returns the requested badge content.
    pub const fn badge(&self) -> ApplicationBadge {
        self.badge
    }

    /// Returns the installed Linux desktop-entry filename when configured.
    pub const fn desktop_file_name(&self) -> Option<&DesktopFileName> {
        self.desktop_file_name.as_ref()
    }
}

/// Main-thread backend for an operating-system application launcher badge.
pub trait ApplicationBadgeService {
    /// Applies one badge mutation to the application launcher or Dock icon.
    fn set(&mut self, request: &ApplicationBadgeRequest) -> Result<(), SystemServiceError>;
}

/// Cloneable main-thread capability for the operating-system application badge.
#[derive(Clone)]
pub struct ApplicationBadgeHandle {
    service: Rc<RefCell<Box<dyn ApplicationBadgeService>>>,
    badge: Rc<Cell<ApplicationBadge>>,
    desktop_file_name: Rc<RefCell<Option<DesktopFileName>>>,
}

impl ApplicationBadgeHandle {
    pub(crate) fn new(service: impl ApplicationBadgeService + 'static) -> Self {
        Self {
            service: Rc::new(RefCell::new(Box::new(service))),
            badge: Rc::new(Cell::new(ApplicationBadge::Hidden)),
            desktop_file_name: Rc::new(RefCell::new(None)),
        }
    }

    pub(crate) fn set_desktop_file_name(&self, name: Option<DesktopFileName>) {
        *self.desktop_file_name.borrow_mut() = name;
    }

    /// Applies explicit badge content and records it after the backend succeeds.
    pub fn set(&self, badge: ApplicationBadge) -> Result<(), SystemServiceError> {
        let request = ApplicationBadgeRequest {
            badge,
            desktop_file_name: self.desktop_file_name.borrow().clone(),
        };
        self.service.borrow_mut().set(&request)?;
        self.badge.set(badge);
        Ok(())
    }

    /// Displays an Electron-style numeric badge, treating zero as hidden.
    pub fn set_count(&self, count: i64) -> Result<(), SystemServiceError> {
        self.set(ApplicationBadge::from_count(count))
    }

    /// Displays a plain marker where supported and hides the badge on Linux.
    pub fn set_indeterminate(&self) -> Result<(), SystemServiceError> {
        self.set(ApplicationBadge::Indeterminate)
    }

    /// Hides the current application badge.
    pub fn clear(&self) -> Result<(), SystemServiceError> {
        self.set(ApplicationBadge::Hidden)
    }

    /// Returns the last badge content successfully accepted by the backend.
    pub fn badge(&self) -> ApplicationBadge {
        self.badge.get()
    }

    /// Returns the last successful numeric count, or zero for other badge content.
    pub fn count(&self) -> i64 {
        self.badge().count()
    }
}

/// Default native application-badge backend.
#[derive(Debug, Default)]
pub struct SystemApplicationBadge;

impl ApplicationBadgeService for SystemApplicationBadge {
    fn set(&mut self, request: &ApplicationBadgeRequest) -> Result<(), SystemServiceError> {
        platform::set(request)
    }
}

#[cfg(test)]
#[path = "application_badge_tests.rs"]
mod tests;
