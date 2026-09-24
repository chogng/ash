use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Weak;

use futures::executor::block_on;

use crate::devtools::DevToolsHandle;
use crate::services::SystemServiceErrorCode;
use crate::window::WindowChrome;
use crate::window::WindowCloseRequester;
use crate::window::WindowHandle;
use crate::window::WindowId;

use super::FileDialogFilter;
use super::FileDialogFilterError;
use super::FileDialogFuture;
use super::FileDialogHandle;
use super::FileDialogOptions;
use super::FileDialogOptionsError;
use super::FileDialogService;
use super::SystemFileDialogs;

fn closed_window(id: WindowId) -> WindowHandle {
    WindowHandle::new(
        id,
        Weak::new(),
        WindowChrome::Native,
        DevToolsHandle::new(),
        WindowCloseRequester::new(|_, _| false),
        None,
        false,
    )
}

#[derive(Clone)]
struct RecordingFileDialogs {
    selected_folders: Arc<Mutex<Vec<FileDialogOptions>>>,
}

impl FileDialogService for RecordingFileDialogs {
    fn open_file(&self, _options: FileDialogOptions) -> FileDialogFuture<Option<PathBuf>> {
        Box::pin(async { Ok(None) })
    }

    fn open_files(&self, _options: FileDialogOptions) -> FileDialogFuture<Vec<PathBuf>> {
        Box::pin(async { Ok(Vec::new()) })
    }

    fn select_folder(&self, _options: FileDialogOptions) -> FileDialogFuture<Option<PathBuf>> {
        Box::pin(async { Ok(None) })
    }

    fn select_folders(&self, options: FileDialogOptions) -> FileDialogFuture<Vec<PathBuf>> {
        let selected_folders = Arc::clone(&self.selected_folders);
        Box::pin(async move {
            selected_folders.lock().unwrap().push(options);
            Ok(vec![PathBuf::from("one"), PathBuf::from("two")])
        })
    }

    fn save_file(&self, _options: FileDialogOptions) -> FileDialogFuture<Option<PathBuf>> {
        Box::pin(async { Ok(None) })
    }
}

struct LegacyFileDialogs;

impl FileDialogService for LegacyFileDialogs {
    fn open_file(&self, _options: FileDialogOptions) -> FileDialogFuture<Option<PathBuf>> {
        Box::pin(async { Ok(None) })
    }

    fn open_files(&self, _options: FileDialogOptions) -> FileDialogFuture<Vec<PathBuf>> {
        Box::pin(async { Ok(Vec::new()) })
    }

    fn select_folder(&self, _options: FileDialogOptions) -> FileDialogFuture<Option<PathBuf>> {
        Box::pin(async { Ok(None) })
    }

    fn save_file(&self, _options: FileDialogOptions) -> FileDialogFuture<Option<PathBuf>> {
        Box::pin(async { Ok(None) })
    }
}

#[test]
fn file_dialog_options_expose_and_validate_portable_metadata() {
    let filter = FileDialogFilter::new("Images", ["png", "jpeg"]);
    let options = FileDialogOptions::new()
        .with_title("Choose an image")
        .with_initial_directory("fixtures")
        .with_suggested_file_name("preview.png")
        .with_filter(filter.clone())
        .with_parent(closed_window(WindowId::from_raw(17)));

    assert_eq!(filter.name(), "Images");
    assert_eq!(filter.extensions(), ["png", "jpeg"]);
    assert_eq!(options.title(), Some("Choose an image"));
    assert_eq!(options.initial_directory(), Some(Path::new("fixtures")));
    assert_eq!(options.suggested_file_name(), Some("preview.png"));
    assert_eq!(options.filters(), [filter]);
    assert_eq!(options.parent_window(), Some(WindowId::from_raw(17)));
    assert_eq!(options.validate(), Ok(()));
}

#[test]
fn system_file_dialog_rejects_a_closed_parent_before_native_presentation() {
    let options = FileDialogOptions::new().with_parent(closed_window(WindowId::from_raw(9)));

    let error = block_on(SystemFileDialogs.open_file(options)).unwrap_err();

    assert_eq!(error.code(), SystemServiceErrorCode::Backend);
    assert!(std::error::Error::source(&error).is_some());
}

#[test]
fn file_dialog_options_reject_ambiguous_filters_and_file_names() {
    assert_eq!(
        FileDialogFilter::new("Images", ["png", "PNG"]).validate(),
        Err(FileDialogFilterError::DuplicateExtension { index: 1 })
    );
    assert_eq!(
        FileDialogOptions::new()
            .with_filter(FileDialogFilter::new("Images", [".png"]))
            .validate(),
        Err(FileDialogOptionsError::Filter {
            index: 0,
            source: FileDialogFilterError::InvalidExtension { index: 0 },
        })
    );
    assert_eq!(
        FileDialogOptions::new()
            .with_suggested_file_name("nested/result.txt")
            .validate(),
        Err(FileDialogOptionsError::InvalidSuggestedFileName)
    );
}

#[test]
fn file_dialog_handle_validates_before_dispatch_and_supports_multiple_folders() {
    let selected_folders = Arc::new(Mutex::new(Vec::new()));
    let handle = FileDialogHandle::new(RecordingFileDialogs {
        selected_folders: Arc::clone(&selected_folders),
    });
    let invalid = FileDialogOptions::new().with_title(" ");

    assert!(
        block_on(handle.select_folders(invalid))
            .unwrap_err()
            .is_invalid_input()
    );
    assert!(selected_folders.lock().unwrap().is_empty());

    let options = FileDialogOptions::new().with_title("Choose workspaces");
    assert_eq!(
        block_on(handle.select_folders(options.clone())).unwrap(),
        [PathBuf::from("one"), PathBuf::from("two")]
    );
    assert_eq!(*selected_folders.lock().unwrap(), [options]);
}

#[test]
fn existing_file_dialog_backends_report_multiple_folders_as_unsupported() {
    let handle = FileDialogHandle::new(LegacyFileDialogs);

    assert!(
        block_on(handle.select_folders(FileDialogOptions::new()))
            .unwrap_err()
            .is_unsupported()
    );
}

#[test]
fn file_dialog_futures_can_cross_threads() {
    fn require_send<T: Send>() {}

    require_send::<FileDialogFuture<Vec<PathBuf>>>();
}
