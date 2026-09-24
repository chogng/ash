use std::error::Error;
use std::fmt;
use std::future::Future;
use std::path::Path;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use crate::window::WindowHandle;
use crate::window::WindowId;

use super::SystemServiceError;
use super::dialog_parent::DialogParent;

/// Owned asynchronous result returned by an injectable file-dialog backend.
pub type FileDialogFuture<T> =
    Pin<Box<dyn Future<Output = Result<T, SystemServiceError>> + Send + 'static>>;

/// Named extension filter shown by a native file dialog.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileDialogFilter {
    name: String,
    extensions: Vec<String>,
}

impl FileDialogFilter {
    /// Creates a named filter from extension strings without leading dots.
    pub fn new(
        name: impl Into<String>,
        extensions: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        Self {
            name: name.into(),
            extensions: extensions.into_iter().map(Into::into).collect(),
        }
    }

    /// Returns the label shown for this filter.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Returns extensions without leading dots, or the wildcard `*`.
    pub fn extensions(&self) -> &[String] {
        &self.extensions
    }

    /// Validates the display label and extension patterns before native dispatch.
    pub fn validate(&self) -> Result<(), FileDialogFilterError> {
        if self.name.trim().is_empty() || self.name.contains('\0') {
            return Err(FileDialogFilterError::InvalidName);
        }
        if self.extensions.is_empty() {
            return Err(FileDialogFilterError::EmptyExtensions);
        }
        for (index, extension) in self.extensions.iter().enumerate() {
            let trimmed = extension.trim();
            if trimmed.is_empty() {
                return Err(FileDialogFilterError::EmptyExtension { index });
            }
            if trimmed != extension
                || (trimmed != "*"
                    && (trimmed.starts_with('.')
                        || trimmed.contains('/')
                        || trimmed.contains('\\')
                        || trimmed.contains('\0')))
            {
                return Err(FileDialogFilterError::InvalidExtension { index });
            }
            if self.extensions[..index]
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(extension))
            {
                return Err(FileDialogFilterError::DuplicateExtension { index });
            }
        }
        Ok(())
    }
}

/// Invalid native file-dialog extension filter.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FileDialogFilterError {
    /// The display name is empty or contains a null byte.
    InvalidName,
    /// The filter contains no extension patterns.
    EmptyExtensions,
    /// One extension is empty.
    EmptyExtension { index: usize },
    /// One extension uses whitespace, a leading dot, a path separator, or a null byte.
    InvalidExtension { index: usize },
    /// One extension duplicates an earlier pattern without regard to ASCII case.
    DuplicateExtension { index: usize },
}

impl fmt::Display for FileDialogFilterError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidName => {
                formatter.write_str("file filter name cannot be empty or contain a null byte")
            }
            Self::EmptyExtensions => {
                formatter.write_str("file filter must contain at least one extension")
            }
            Self::EmptyExtension { index } => {
                write!(formatter, "file filter extension {index} cannot be empty")
            }
            Self::InvalidExtension { index } => write!(
                formatter,
                "file filter extension {index} must omit whitespace, leading dots, and path separators"
            ),
            Self::DuplicateExtension { index } => {
                write!(formatter, "file filter extension {index} is duplicated")
            }
        }
    }
}

impl Error for FileDialogFilterError {}

/// Backend-independent options shared by open, folder, and save dialogs.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct FileDialogOptions {
    title: Option<String>,
    initial_directory: Option<PathBuf>,
    suggested_file_name: Option<String>,
    filters: Vec<FileDialogFilter>,
    parent: Option<DialogParent>,
}

impl FileDialogOptions {
    /// Creates empty options using platform defaults.
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets the native dialog title.
    pub fn with_title(mut self, title: impl Into<String>) -> Self {
        self.title = Some(title.into());
        self
    }

    /// Sets the directory shown when the dialog opens.
    pub fn with_initial_directory(mut self, directory: impl Into<PathBuf>) -> Self {
        self.initial_directory = Some(directory.into());
        self
    }

    /// Sets the initial file name used by save dialogs.
    pub fn with_suggested_file_name(mut self, file_name: impl Into<String>) -> Self {
        self.suggested_file_name = Some(file_name.into());
        self
    }

    /// Appends one selectable extension filter.
    pub fn with_filter(mut self, filter: FileDialogFilter) -> Self {
        self.filters.push(filter);
        self
    }

    /// Attaches the dialog to one non-owning runtime window capability.
    ///
    /// The default backend presents a modal window or sheet where supported. If the application
    /// closes `parent` before the dialog begins, the returned future resolves with a backend
    /// error instead of extending the native window lifetime.
    pub fn with_parent(mut self, parent: WindowHandle) -> Self {
        self.parent = Some(DialogParent::new(parent));
        self
    }

    /// Returns the optional native dialog title.
    pub fn title(&self) -> Option<&str> {
        self.title.as_deref()
    }

    /// Returns the initial directory supplied to the native picker.
    pub fn initial_directory(&self) -> Option<&Path> {
        self.initial_directory.as_deref()
    }

    /// Returns the optional initial file name.
    pub fn suggested_file_name(&self) -> Option<&str> {
        self.suggested_file_name.as_deref()
    }

    /// Returns the selectable extension filters in display order.
    pub fn filters(&self) -> &[FileDialogFilter] {
        &self.filters
    }

    /// Returns the stable parent-window identity supplied for modal presentation.
    pub fn parent_window(&self) -> Option<WindowId> {
        self.parent.as_ref().map(DialogParent::id)
    }

    /// Validates options shared by native and injected dialog backends.
    pub fn validate(&self) -> Result<(), FileDialogOptionsError> {
        if self
            .title
            .as_ref()
            .is_some_and(|title| title.trim().is_empty() || title.contains('\0'))
        {
            return Err(FileDialogOptionsError::InvalidTitle);
        }
        if self
            .initial_directory
            .as_ref()
            .is_some_and(|directory| directory.as_os_str().is_empty())
        {
            return Err(FileDialogOptionsError::EmptyInitialDirectory);
        }
        if let Some(file_name) = &self.suggested_file_name
            && (file_name.trim().is_empty()
                || file_name == "."
                || file_name == ".."
                || file_name.contains('/')
                || file_name.contains('\\')
                || file_name.contains('\0'))
        {
            return Err(FileDialogOptionsError::InvalidSuggestedFileName);
        }
        for (index, filter) in self.filters.iter().enumerate() {
            filter
                .validate()
                .map_err(|source| FileDialogOptionsError::Filter { index, source })?;
        }
        Ok(())
    }
}

/// Invalid backend-independent native file-dialog options.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FileDialogOptionsError {
    /// An explicitly supplied title is empty or contains a null byte.
    InvalidTitle,
    /// An explicitly supplied initial directory is empty.
    EmptyInitialDirectory,
    /// The suggested file name is not one portable path component.
    InvalidSuggestedFileName,
    /// One extension filter is invalid.
    Filter {
        index: usize,
        source: FileDialogFilterError,
    },
}

impl fmt::Display for FileDialogOptionsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidTitle => {
                formatter.write_str("file dialog title cannot be empty or contain a null byte")
            }
            Self::EmptyInitialDirectory => {
                formatter.write_str("file dialog initial directory cannot be empty")
            }
            Self::InvalidSuggestedFileName => formatter.write_str(
                "suggested file name must be one non-empty path component without a null byte",
            ),
            Self::Filter { index, source } => {
                write!(formatter, "file dialog filter {index} is invalid: {source}")
            }
        }
    }
}

impl Error for FileDialogOptionsError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Filter { source, .. } => Some(source),
            Self::InvalidTitle | Self::EmptyInitialDirectory | Self::InvalidSuggestedFileName => {
                None
            }
        }
    }
}

/// Native file-dialog backend used through an injectable [`FileDialogHandle`].
pub trait FileDialogService: Send + Sync {
    /// Selects one file, or returns `None` when the user cancels.
    fn open_file(&self, options: FileDialogOptions) -> FileDialogFuture<Option<PathBuf>>;

    /// Selects zero or more files.
    fn open_files(&self, options: FileDialogOptions) -> FileDialogFuture<Vec<PathBuf>>;

    /// Selects one directory, or returns `None` when the user cancels.
    fn select_folder(&self, options: FileDialogOptions) -> FileDialogFuture<Option<PathBuf>>;

    /// Selects zero or more directories.
    ///
    /// Existing injected backends may keep the default explicit unsupported result.
    fn select_folders(&self, _options: FileDialogOptions) -> FileDialogFuture<Vec<PathBuf>> {
        Box::pin(async { Err(SystemServiceError::unsupported("file dialog")) })
    }

    /// Selects a destination path, or returns `None` when the user cancels.
    fn save_file(&self, options: FileDialogOptions) -> FileDialogFuture<Option<PathBuf>>;
}

/// Cloneable capability for opening native file, folder, and save dialogs.
#[derive(Clone)]
pub struct FileDialogHandle {
    service: Arc<dyn FileDialogService>,
}

impl FileDialogHandle {
    pub(crate) fn new(service: impl FileDialogService + 'static) -> Self {
        Self {
            service: Arc::new(service),
        }
    }

    /// Selects one file through the injected backend.
    pub fn open_file(&self, options: FileDialogOptions) -> FileDialogFuture<Option<PathBuf>> {
        if let Err(error) = options.validate() {
            return invalid_options(error);
        }
        self.service.open_file(options)
    }

    /// Selects zero or more files through the injected backend.
    pub fn open_files(&self, options: FileDialogOptions) -> FileDialogFuture<Vec<PathBuf>> {
        if let Err(error) = options.validate() {
            return invalid_options(error);
        }
        self.service.open_files(options)
    }

    /// Selects one directory through the injected backend.
    pub fn select_folder(&self, options: FileDialogOptions) -> FileDialogFuture<Option<PathBuf>> {
        if let Err(error) = options.validate() {
            return invalid_options(error);
        }
        self.service.select_folder(options)
    }

    /// Selects zero or more directories through the injected backend.
    pub fn select_folders(&self, options: FileDialogOptions) -> FileDialogFuture<Vec<PathBuf>> {
        if let Err(error) = options.validate() {
            return invalid_options(error);
        }
        self.service.select_folders(options)
    }

    /// Selects a destination path through the injected backend.
    pub fn save_file(&self, options: FileDialogOptions) -> FileDialogFuture<Option<PathBuf>> {
        if let Err(error) = options.validate() {
            return invalid_options(error);
        }
        self.service.save_file(options)
    }
}

/// Default native file-dialog backend.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemFileDialogs;

impl FileDialogService for SystemFileDialogs {
    fn open_file(&self, options: FileDialogOptions) -> FileDialogFuture<Option<PathBuf>> {
        Box::pin(async move {
            Ok(dialog(options)?
                .pick_file()
                .await
                .map(|file| file.path().to_owned()))
        })
    }

    fn open_files(&self, options: FileDialogOptions) -> FileDialogFuture<Vec<PathBuf>> {
        Box::pin(async move {
            Ok(dialog(options)?
                .pick_files()
                .await
                .unwrap_or_default()
                .into_iter()
                .map(|file| file.path().to_owned())
                .collect())
        })
    }

    fn select_folder(&self, options: FileDialogOptions) -> FileDialogFuture<Option<PathBuf>> {
        Box::pin(async move {
            Ok(dialog(options)?
                .pick_folder()
                .await
                .map(|folder| folder.path().to_owned()))
        })
    }

    fn select_folders(&self, options: FileDialogOptions) -> FileDialogFuture<Vec<PathBuf>> {
        Box::pin(async move {
            Ok(dialog(options)?
                .pick_folders()
                .await
                .unwrap_or_default()
                .into_iter()
                .map(|folder| folder.path().to_owned())
                .collect())
        })
    }

    fn save_file(&self, options: FileDialogOptions) -> FileDialogFuture<Option<PathBuf>> {
        Box::pin(async move {
            Ok(dialog(options)?
                .save_file()
                .await
                .map(|file| file.path().to_owned()))
        })
    }
}

fn invalid_options<T: 'static>(error: FileDialogOptionsError) -> FileDialogFuture<T> {
    Box::pin(async move { Err(SystemServiceError::invalid_input("file dialog", error)) })
}

fn dialog(options: FileDialogOptions) -> Result<rfd::AsyncFileDialog, SystemServiceError> {
    let mut dialog = rfd::AsyncFileDialog::new();
    if let Some(title) = options.title {
        dialog = dialog.set_title(title);
    }
    if let Some(directory) = options.initial_directory {
        dialog = dialog.set_directory(directory);
    }
    if let Some(file_name) = options.suggested_file_name {
        dialog = dialog.set_file_name(file_name);
    }
    for filter in options.filters {
        dialog = dialog.add_filter(filter.name, &filter.extensions);
    }
    if let Some(parent) = options.parent {
        dialog = parent.bind_file_dialog(dialog)?;
    }
    Ok(dialog)
}

#[cfg(test)]
#[path = "file_dialog_tests.rs"]
mod tests;
