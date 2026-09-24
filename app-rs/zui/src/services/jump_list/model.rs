use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;

use thiserror::Error;

const MAX_DESCRIPTION_UTF16: usize = 260;

/// One static Windows Jump List task that launches a program with a command line.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JumpListTask {
    program: PathBuf,
    arguments: String,
    title: String,
    description: String,
    icon: Option<(PathBuf, i32)>,
    working_directory: Option<PathBuf>,
}

impl JumpListTask {
    /// Creates a task with an absolute program and user-visible title.
    pub fn new(program: impl Into<PathBuf>, title: impl Into<String>) -> Self {
        Self {
            program: program.into(),
            arguments: String::new(),
            title: title.into(),
            description: String::new(),
            icon: None,
            working_directory: None,
        }
    }

    /// Sets the Windows command-line string passed to the task program.
    pub fn with_arguments(mut self, arguments: impl Into<String>) -> Self {
        self.arguments = arguments.into();
        self
    }

    /// Sets the task tooltip, limited to 260 UTF-16 code units by Windows Shell.
    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = description.into();
        self
    }

    /// Sets an absolute icon resource path and zero-based resource index.
    pub fn with_icon(mut self, path: impl Into<PathBuf>, index: i32) -> Self {
        self.icon = Some((path.into(), index));
        self
    }

    /// Sets the absolute working directory used to launch the task.
    pub fn with_working_directory(mut self, directory: impl Into<PathBuf>) -> Self {
        self.working_directory = Some(directory.into());
        self
    }

    /// Returns the absolute program path.
    pub fn program(&self) -> &Path {
        &self.program
    }

    /// Returns the Windows command-line string passed to the program.
    pub fn arguments(&self) -> &str {
        &self.arguments
    }

    /// Returns the user-visible task title.
    pub fn title(&self) -> &str {
        &self.title
    }

    /// Returns the task tooltip.
    pub fn description(&self) -> &str {
        &self.description
    }

    /// Returns the icon resource path and index when configured.
    pub fn icon(&self) -> Option<(&Path, i32)> {
        self.icon
            .as_ref()
            .map(|(path, index)| (path.as_path(), *index))
    }

    /// Returns the task working directory when configured.
    pub fn working_directory(&self) -> Option<&Path> {
        self.working_directory.as_deref()
    }

    fn validate(&self) -> Result<(), JumpListModelError> {
        validate_absolute(&self.program, "task program")?;
        validate_text(&self.title, "task title", true)?;
        validate_text(&self.arguments, "task arguments", false)?;
        validate_text(&self.description, "task description", false)?;
        let length = self.description.encode_utf16().count();
        if length > MAX_DESCRIPTION_UTF16 {
            return Err(JumpListModelError::DescriptionTooLong { length });
        }
        if let Some((path, _)) = &self.icon {
            validate_absolute(path, "task icon")?;
        }
        if let Some(directory) = &self.working_directory {
            validate_absolute(directory, "task working directory")?;
        }
        Ok(())
    }
}

/// One item in a standard or custom Windows Jump List category.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum JumpListItem {
    /// Launches a configured program and command line.
    Task(JumpListTask),
    /// Separates task items and is valid only in the standard Tasks category.
    Separator,
    /// Opens one absolute file through the application's registered file association.
    File(PathBuf),
}

impl JumpListItem {
    /// Creates an absolute file-link item.
    pub fn file(path: impl Into<PathBuf>) -> Self {
        Self::File(path.into())
    }

    fn validate(&self) -> Result<(), JumpListModelError> {
        match self {
            Self::Task(task) => task.validate(),
            Self::Separator => Ok(()),
            Self::File(path) => validate_absolute(path, "file item"),
        }
    }
}

/// Stable kind of a Windows Jump List category.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum JumpListCategoryKind {
    /// The standard bottom Tasks category.
    Tasks,
    /// An application-named category containing tasks or file links.
    Custom,
    /// The Windows-managed frequently used destination category.
    Frequent,
    /// The Windows-managed recently used destination category.
    Recent,
}

/// One standard, known, or application-defined Windows Jump List category.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum JumpListCategory {
    /// The standard bottom Tasks category.
    Tasks(Vec<JumpListItem>),
    /// An application-named category containing tasks or file links.
    Custom {
        /// User-visible category name.
        name: String,
        /// Category tasks and file links.
        items: Vec<JumpListItem>,
    },
    /// The Windows-managed frequently used destination category.
    Frequent,
    /// The Windows-managed recently used destination category.
    Recent,
}

impl JumpListCategory {
    /// Creates the standard Tasks category.
    pub fn tasks(items: Vec<JumpListItem>) -> Self {
        Self::Tasks(items)
    }

    /// Creates an application-named custom category.
    pub fn custom(name: impl Into<String>, items: Vec<JumpListItem>) -> Self {
        Self::Custom {
            name: name.into(),
            items,
        }
    }

    /// Returns this category's stable kind.
    pub const fn kind(&self) -> JumpListCategoryKind {
        match self {
            Self::Tasks(_) => JumpListCategoryKind::Tasks,
            Self::Custom { .. } => JumpListCategoryKind::Custom,
            Self::Frequent => JumpListCategoryKind::Frequent,
            Self::Recent => JumpListCategoryKind::Recent,
        }
    }

    /// Returns the custom category name when one exists.
    pub fn name(&self) -> Option<&str> {
        match self {
            Self::Custom { name, .. } => Some(name),
            _ => None,
        }
    }

    /// Returns application-provided items for Tasks and custom categories.
    pub fn items(&self) -> Option<&[JumpListItem]> {
        match self {
            Self::Tasks(items) | Self::Custom { items, .. } => Some(items),
            Self::Frequent | Self::Recent => None,
        }
    }

    fn validate(&self) -> Result<(), JumpListModelError> {
        if let Self::Custom { name, items } = self {
            validate_text(name, "custom category name", true)?;
            if items
                .iter()
                .any(|item| matches!(item, JumpListItem::Separator))
            {
                return Err(JumpListModelError::SeparatorOutsideTasks);
            }
        }
        if let Some(items) = self.items() {
            for item in items {
                item.validate()?;
            }
        }
        Ok(())
    }
}

/// Complete replacement or reset request passed to a Jump List backend.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum JumpListRequest {
    /// Restores the default Windows-managed Jump List.
    Default,
    /// Replaces the Jump List with the supplied categories.
    Categories(Vec<JumpListCategory>),
}

impl JumpListRequest {
    pub(super) fn validate(&self) -> Result<(), JumpListModelError> {
        let Self::Categories(categories) = self else {
            return Ok(());
        };
        let mut standard = HashSet::new();
        let mut custom_names = HashSet::new();
        for category in categories {
            category.validate()?;
            match category {
                JumpListCategory::Custom { name, .. } => {
                    if !custom_names.insert(name.as_str()) {
                        return Err(JumpListModelError::DuplicateCustomCategory(name.clone()));
                    }
                }
                _ if !standard.insert(category.kind()) => {
                    return Err(JumpListModelError::DuplicateStandardCategory(
                        category.kind(),
                    ));
                }
                _ => {}
            }
        }
        Ok(())
    }
}

/// Result of a Windows Jump List replacement or reset.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum JumpListUpdateResult {
    /// The replacement or reset committed successfully.
    Applied,
    /// A custom category referenced a file type not registered to the application.
    FileTypeRegistrationRequired,
    /// Windows privacy or group policy disabled application-defined custom categories.
    CustomCategoriesDisabled,
}

/// Windows Jump List transaction settings and destinations explicitly removed by the user.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct JumpListSettings {
    min_items: u32,
    removed_items: Vec<JumpListItem>,
}

impl JumpListSettings {
    /// Creates a settings snapshot, primarily for injected backends.
    pub fn new(min_items: u32, removed_items: Vec<JumpListItem>) -> Self {
        Self {
            min_items,
            removed_items,
        }
    }

    /// Returns the minimum number of items Windows says it can display.
    pub const fn min_items(&self) -> u32 {
        self.min_items
    }

    /// Returns destinations the user explicitly removed from custom categories.
    pub fn removed_items(&self) -> &[JumpListItem] {
        &self.removed_items
    }
}

/// Invalid portable Jump List content rejected before native shell mutation.
#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum JumpListModelError {
    /// A path field was relative or contained a NUL code point.
    #[error("{field} must be an absolute path without NUL code points: {path:?}")]
    InvalidPath {
        /// Stable field label.
        field: &'static str,
        /// Invalid path.
        path: PathBuf,
    },
    /// A text field was empty where user-visible content is required.
    #[error("{0} must not be empty")]
    EmptyText(&'static str),
    /// A text field contained a NUL code point.
    #[error("{0} must not contain NUL code points")]
    TextContainsNul(&'static str),
    /// A task description exceeded the Windows Shell limit.
    #[error("task description is {length} UTF-16 code units; the Windows limit is 260")]
    DescriptionTooLong {
        /// Observed UTF-16 length.
        length: usize,
    },
    /// A separator appeared outside the standard Tasks category.
    #[error("Jump List separators are only valid in the standard Tasks category")]
    SeparatorOutsideTasks,
    /// A standard category kind was repeated.
    #[error("Jump List standard category {0:?} appears more than once")]
    DuplicateStandardCategory(JumpListCategoryKind),
    /// Two custom categories used the same user-visible name.
    #[error("Jump List custom category {0:?} appears more than once")]
    DuplicateCustomCategory(String),
}

fn validate_absolute(path: &Path, field: &'static str) -> Result<(), JumpListModelError> {
    if path.is_absolute() && !path.as_os_str().to_string_lossy().contains('\0') {
        Ok(())
    } else {
        Err(JumpListModelError::InvalidPath {
            field,
            path: path.to_path_buf(),
        })
    }
}

fn validate_text(
    value: &str,
    field: &'static str,
    nonempty: bool,
) -> Result<(), JumpListModelError> {
    if nonempty && value.trim().is_empty() {
        return Err(JumpListModelError::EmptyText(field));
    }
    if value.contains('\0') {
        return Err(JumpListModelError::TextContainsNul(field));
    }
    Ok(())
}
