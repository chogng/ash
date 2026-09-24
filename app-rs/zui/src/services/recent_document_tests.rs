use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;

use super::RecentDocumentHandle;
use super::RecentDocumentService;
use crate::services::SystemServiceError;
use crate::services::SystemServiceErrorCode;

#[derive(Clone)]
struct RecordingRecentDocuments {
    added: Rc<RefCell<Vec<PathBuf>>>,
    cleared: Rc<RefCell<usize>>,
    listed: Vec<PathBuf>,
}

impl RecentDocumentService for RecordingRecentDocuments {
    fn add(&mut self, path: PathBuf) -> Result<(), SystemServiceError> {
        self.added.borrow_mut().push(path);
        Ok(())
    }

    fn clear(&mut self) -> Result<(), SystemServiceError> {
        *self.cleared.borrow_mut() += 1;
        Ok(())
    }

    fn list(&mut self) -> Result<Vec<PathBuf>, SystemServiceError> {
        Ok(self.listed.clone())
    }
}

#[test]
fn handle_validates_paths_and_uses_the_injected_backend() {
    let added = Rc::new(RefCell::new(Vec::new()));
    let cleared = Rc::new(RefCell::new(0));
    let listed = std::env::temp_dir().join("zui-recent-document-listed");
    let handle = RecentDocumentHandle::new(RecordingRecentDocuments {
        added: Rc::clone(&added),
        cleared: Rc::clone(&cleared),
        listed: vec![listed.clone()],
    });
    let invalid = handle.add("relative.txt").unwrap_err();
    assert_eq!(invalid.code(), SystemServiceErrorCode::InvalidInput);
    assert!(added.borrow().is_empty());

    let path = std::env::temp_dir().join("zui-recent-document-added");
    handle.add(path.clone()).unwrap();
    handle.clear().unwrap();
    assert_eq!(added.borrow().as_slice(), [path]);
    assert_eq!(*cleared.borrow(), 1);
    assert_eq!(handle.list().unwrap(), [listed]);
}

#[test]
fn handle_rejects_relative_paths_returned_by_a_backend() {
    let handle = RecentDocumentHandle::new(RecordingRecentDocuments {
        added: Rc::new(RefCell::new(Vec::new())),
        cleared: Rc::new(RefCell::new(0)),
        listed: vec![PathBuf::from("relative.txt")],
    });
    let error = handle.list().unwrap_err();
    assert_eq!(error.code(), SystemServiceErrorCode::Backend);
}
