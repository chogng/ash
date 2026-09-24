use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::thread;

use futures::executor::block_on;

use super::FileIconFuture;
use super::FileIconHandle;
use super::FileIconImage;
use super::FileIconImageError;
use super::FileIconRequest;
use super::FileIconRequestError;
use super::FileIconService;
use super::FileIconSize;
#[cfg(target_os = "macos")]
use super::SystemFileIcons;
use super::SystemServiceError;
use crate::services::SystemServiceErrorCode;

#[derive(Clone)]
struct RecordingFileIcons {
    requests: Arc<Mutex<Vec<(FileIconRequest, thread::ThreadId)>>>,
}

impl FileIconService for RecordingFileIcons {
    fn load(&self, request: &FileIconRequest) -> Result<FileIconImage, SystemServiceError> {
        self.requests
            .lock()
            .unwrap()
            .push((request.clone(), thread::current().id()));
        FileIconImage::from_rgba([10, 20, 30, 40], 1, 1)
            .map_err(|source| SystemServiceError::backend("file icon", source))
    }
}

fn require_send<T: Send>() {}

#[test]
fn file_icon_future_can_cross_threads() {
    require_send::<FileIconFuture>();
}

#[test]
fn request_defaults_to_normal_and_retains_native_path() {
    let path = PathBuf::from("document.zui-test");
    let request = FileIconRequest::new(path.clone());
    assert_eq!(request.path(), path);
    assert_eq!(request.size(), FileIconSize::Normal);
    assert_eq!(
        request.clone().with_size(FileIconSize::Small).size(),
        FileIconSize::Small
    );
    assert_eq!(request.validate(), Ok(()));
    assert_eq!(
        FileIconRequest::new(PathBuf::new()).validate(),
        Err(FileIconRequestError::EmptyPath)
    );
    assert_eq!(
        FileIconRequest::new("bad\0path").validate(),
        Err(FileIconRequestError::NullPath)
    );
}

#[test]
fn rgba_storage_validates_dimensions_and_exact_length() {
    let image = FileIconImage::from_rgba([1, 2, 3, 4, 5, 6, 7, 8], 2, 1).unwrap();
    assert_eq!(image.width(), 2);
    assert_eq!(image.height(), 1);
    assert_eq!(image.rgba(), &[1, 2, 3, 4, 5, 6, 7, 8]);
    assert_eq!(image.clone().into_rgba(), image.rgba());
    assert_eq!(
        FileIconImage::from_rgba(Vec::new(), 0, 1),
        Err(FileIconImageError::ZeroDimensions)
    );
    assert_eq!(
        FileIconImage::from_rgba([1, 2, 3], 1, 1),
        Err(FileIconImageError::InvalidRgbaLength {
            expected: 4,
            actual: 3,
        })
    );
}

#[test]
fn injected_backend_runs_off_the_calling_thread_and_receives_typed_request() {
    let caller = thread::current().id();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let handle = FileIconHandle::new(RecordingFileIcons {
        requests: Arc::clone(&requests),
    });
    let request = FileIconRequest::new("demo.txt").with_size(FileIconSize::Large);
    let image = block_on(handle.get_with(request.clone())).unwrap();
    assert_eq!(image.rgba(), &[10, 20, 30, 40]);
    let requests = requests.lock().unwrap();
    assert_eq!(requests[0].0, request);
    assert_ne!(requests[0].1, caller);
}

#[test]
fn invalid_request_is_rejected_before_injected_backend_dispatch() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let handle = FileIconHandle::new(RecordingFileIcons {
        requests: Arc::clone(&requests),
    });
    let error = block_on(handle.get(PathBuf::new())).unwrap_err();
    assert_eq!(error.code(), SystemServiceErrorCode::InvalidInput);
    assert!(requests.lock().unwrap().is_empty());
}

#[cfg(target_os = "macos")]
#[test]
fn macos_system_backend_returns_exact_normal_pixels() {
    let executable = std::env::current_exe().unwrap();
    let handle = FileIconHandle::new(SystemFileIcons);
    let image = block_on(handle.get(executable)).unwrap();
    assert_eq!((image.width(), image.height()), (32, 32));
    assert!(image.rgba().chunks_exact(4).any(|pixel| pixel[3] != 0));
}

#[cfg(target_os = "macos")]
#[test]
fn macos_system_backend_rejects_large_icons_explicitly() {
    let request =
        FileIconRequest::new(std::env::current_exe().unwrap()).with_size(FileIconSize::Large);
    let handle = FileIconHandle::new(SystemFileIcons);
    let error = block_on(handle.get_with(request)).unwrap_err();
    assert_eq!(error.code(), SystemServiceErrorCode::Unsupported);
}
