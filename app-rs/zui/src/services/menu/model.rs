use std::collections::HashSet;
use std::error::Error;
use std::fmt;

/// Stable application-owned identity for one actionable native menu item.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct MenuItemId(String);

impl MenuItemId {
    /// Creates a non-empty application-owned menu identity.
    pub fn new(value: impl Into<String>) -> Result<Self, MenuItemIdError> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(MenuItemIdError);
        }
        Ok(Self(value))
    }

    /// Returns the stable string identity.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    pub(super) fn from_native(value: &str) -> Self {
        Self(value.to_owned())
    }
}

/// Failure to create an empty menu item identity.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MenuItemIdError;

impl fmt::Display for MenuItemIdError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("menu item identity cannot be empty")
    }
}

impl Error for MenuItemIdError {}

/// Validated application-local accelerator such as `CommandOrControl+Shift+KeyP`.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct MenuAccelerator(String);

impl MenuAccelerator {
    /// Parses a native-menu accelerator without exposing the backend parser.
    pub fn parse(value: impl Into<String>) -> Result<Self, MenuAcceleratorError> {
        let value = value.into();
        #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
        value
            .parse::<muda::accelerator::Accelerator>()
            .map_err(|error| MenuAcceleratorError(error.to_string()))?;
        #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
        if value.trim().is_empty() {
            return Err(MenuAcceleratorError(
                "accelerator cannot be empty".to_owned(),
            ));
        }
        Ok(Self(value))
    }

    /// Returns the validated portable spelling retained by ZUI.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    pub(super) fn to_native(&self) -> Result<muda::accelerator::Accelerator, MenuAcceleratorError> {
        self.0
            .parse()
            .map_err(|error: muda::accelerator::AcceleratorParseError| {
                MenuAcceleratorError(error.to_string())
            })
    }
}

/// Failure to parse an application-local menu accelerator.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MenuAcceleratorError(String);

impl fmt::Display for MenuAcceleratorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "invalid menu accelerator: {}", self.0)
    }
}

impl Error for MenuAcceleratorError {}

/// One actionable item in a backend-independent menu model.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MenuAction {
    pub id: MenuItemId,
    pub label: String,
    pub enabled: bool,
    pub checked: Option<bool>,
    pub accelerator: Option<MenuAccelerator>,
}

impl MenuAction {
    /// Creates an enabled normal action.
    pub fn new(id: MenuItemId, label: impl Into<String>) -> Self {
        Self {
            id,
            label: label.into(),
            enabled: true,
            checked: None,
            accelerator: None,
        }
    }

    /// Sets whether the action can currently be selected.
    pub const fn with_enabled(mut self, enabled: bool) -> Self {
        self.enabled = enabled;
        self
    }

    /// Renders this action as a checkbox with an explicit initial state.
    pub const fn with_checked(mut self, checked: bool) -> Self {
        self.checked = Some(checked);
        self
    }

    /// Installs an application-local keyboard accelerator.
    pub fn with_accelerator(mut self, accelerator: MenuAccelerator) -> Self {
        self.accelerator = Some(accelerator);
        self
    }
}

/// Application metadata displayed by the native About role.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct MenuAboutMetadata {
    pub name: Option<String>,
    pub version: Option<String>,
    pub short_version: Option<String>,
    pub authors: Vec<String>,
    pub comments: Option<String>,
    pub copyright: Option<String>,
    pub license: Option<String>,
    pub website: Option<String>,
    pub website_label: Option<String>,
    pub credits: Option<String>,
}

impl MenuAboutMetadata {
    /// Creates empty metadata that can be filled with builder methods or public fields.
    pub const fn new() -> Self {
        Self {
            name: None,
            version: None,
            short_version: None,
            authors: Vec::new(),
            comments: None,
            copyright: None,
            license: None,
            website: None,
            website_label: None,
            credits: None,
        }
    }

    /// Sets the application name displayed by the native panel.
    pub fn with_name(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }

    /// Sets the full application version displayed by the native panel.
    pub fn with_version(mut self, version: impl Into<String>) -> Self {
        self.version = Some(version.into());
        self
    }

    /// Sets the application copyright displayed by the native panel.
    pub fn with_copyright(mut self, copyright: impl Into<String>) -> Self {
        self.copyright = Some(copyright.into());
        self
    }

    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    pub(super) fn into_native(self) -> muda::AboutMetadata {
        muda::AboutMetadata {
            name: self.name,
            version: self.version,
            short_version: self.short_version,
            authors: (!self.authors.is_empty()).then_some(self.authors),
            comments: self.comments,
            copyright: self.copyright,
            license: self.license,
            website: self.website,
            website_label: self.website_label,
            credits: self.credits,
            icon: None,
        }
    }
}

/// Operating-system menu behavior that does not emit an application action.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MenuRole {
    Copy,
    Cut,
    Paste,
    SelectAll,
    Undo,
    Redo,
    Minimize,
    Maximize,
    Fullscreen,
    Hide,
    HideOthers,
    ShowAll,
    CloseWindow,
    Quit,
    About(Box<MenuAboutMetadata>),
    Services,
    BringAllToFront,
}

impl MenuRole {
    /// Creates the native About role with application metadata.
    pub fn about(metadata: MenuAboutMetadata) -> Self {
        Self::About(Box::new(metadata))
    }
}

/// Native role with an optional product-supplied display label.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MenuRoleItem {
    pub role: MenuRole,
    pub label: Option<String>,
}

impl MenuRoleItem {
    /// Creates a role using the platform's standard localized label.
    pub const fn new(role: MenuRole) -> Self {
        Self { role, label: None }
    }

    /// Overrides the platform's standard role label.
    pub fn with_label(mut self, label: impl Into<String>) -> Self {
        self.label = Some(label.into());
        self
    }
}

/// Action, native role, separator, or nested submenu in a menu group.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MenuEntry {
    Action(MenuAction),
    Role(MenuRoleItem),
    Separator,
    Submenu(MenuGroup),
}

/// Labeled menu containing actions and nested groups.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MenuGroup {
    pub id: MenuItemId,
    pub label: String,
    pub enabled: bool,
    pub entries: Vec<MenuEntry>,
}

impl MenuGroup {
    /// Creates an enabled menu group.
    pub fn new(
        id: MenuItemId,
        label: impl Into<String>,
        entries: impl IntoIterator<Item = MenuEntry>,
    ) -> Self {
        Self {
            id,
            label: label.into(),
            enabled: true,
            entries: entries.into_iter().collect(),
        }
    }

    /// Sets whether the complete group can currently be selected.
    pub const fn with_enabled(mut self, enabled: bool) -> Self {
        self.enabled = enabled;
        self
    }
}

/// Complete backend-independent application-menu model.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct MenuModel {
    pub groups: Vec<MenuGroup>,
}

impl MenuModel {
    /// Creates a menu model from top-level groups.
    pub fn new(groups: impl IntoIterator<Item = MenuGroup>) -> Self {
        Self {
            groups: groups.into_iter().collect(),
        }
    }

    /// Rejects identities that would make native action dispatch ambiguous.
    pub fn validate(&self) -> Result<(), MenuModelError> {
        let mut identities = HashSet::new();
        for group in &self.groups {
            validate_group(group, &mut identities)?;
        }
        Ok(())
    }
}

fn validate_group(
    group: &MenuGroup,
    identities: &mut HashSet<String>,
) -> Result<(), MenuModelError> {
    insert_identity(&group.id, identities)?;
    for entry in &group.entries {
        match entry {
            MenuEntry::Action(action) => insert_identity(&action.id, identities)?,
            MenuEntry::Submenu(group) => validate_group(group, identities)?,
            MenuEntry::Role(_) | MenuEntry::Separator => {}
        }
    }
    Ok(())
}

fn insert_identity(
    id: &MenuItemId,
    identities: &mut HashSet<String>,
) -> Result<(), MenuModelError> {
    if identities.insert(id.as_str().to_owned()) {
        Ok(())
    } else {
        Err(MenuModelError::DuplicateId(id.clone()))
    }
}

/// Invalid structure rejected before a menu reaches an injected or native backend.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MenuModelError {
    DuplicateId(MenuItemId),
}

impl fmt::Display for MenuModelError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DuplicateId(id) => {
                write!(formatter, "duplicate menu item identity `{}`", id.as_str())
            }
        }
    }
}

impl Error for MenuModelError {}

#[cfg(test)]
#[path = "model_tests.rs"]
mod tests;
