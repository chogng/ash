use std::cell::RefCell;
use std::path::Path;
use std::path::PathBuf;
use std::rc::Rc;

use super::SystemServiceError;

#[path = "recent_document/platform.rs"]
mod platform;

const RECENT_DOCUMENTS: &str = "recent documents";

/// Main-thread backend for the operating system's recent-document list.
pub trait RecentDocumentService {
    /// Records one absolute document path as recently accessed.
    fn add(&mut self, path: PathBuf) -> Result<(), SystemServiceError>;

    /// Clears recent-document usage owned by the platform implementation.
    fn clear(&mut self) -> Result<(), SystemServiceError>;

    /// Returns recent document targets in platform order when the backend can resolve them.
    fn list(&mut self) -> Result<Vec<PathBuf>, SystemServiceError> {
        Err(SystemServiceError::unsupported(RECENT_DOCUMENTS))
    }
}

/// Cloneable main-thread capability for managing operating-system recent documents.
#[derive(Clone)]
pub struct RecentDocumentHandle {
    service: Rc<RefCell<Box<dyn RecentDocumentService>>>,
}

impl RecentDocumentHandle {
    pub(crate) fn new(service: impl RecentDocumentService + 'static) -> Self {
        Self {
            service: Rc::new(RefCell::new(Box::new(service))),
        }
    }

    /// Adds one absolute path to the operating-system recent-document list.
    pub fn add(&self, path: impl Into<PathBuf>) -> Result<(), SystemServiceError> {
        let path = path.into();
        validate_absolute(&path)?;
        self.service.borrow_mut().add(path)
    }

    /// Clears the operating-system recent-document list.
    pub fn clear(&self) -> Result<(), SystemServiceError> {
        self.service.borrow_mut().clear()
    }

    /// Returns recent document targets in operating-system order.
    pub fn list(&self) -> Result<Vec<PathBuf>, SystemServiceError> {
        let paths = self.service.borrow_mut().list()?;
        for path in &paths {
            if !path.is_absolute() {
                return Err(SystemServiceError::backend(
                    RECENT_DOCUMENTS,
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        format!("backend returned relative recent-document path {path:?}"),
                    ),
                ));
            }
        }
        Ok(paths)
    }
}

fn validate_absolute(path: &Path) -> Result<(), SystemServiceError> {
    if path.is_absolute() {
        return Ok(());
    }
    Err(SystemServiceError::invalid_input(
        RECENT_DOCUMENTS,
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "recent-document path must be absolute",
        ),
    ))
}

/// Default native recent-document backend.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemRecentDocuments;

impl RecentDocumentService for SystemRecentDocuments {
    fn add(&mut self, path: PathBuf) -> Result<(), SystemServiceError> {
        platform::add(&path)
    }

    fn clear(&mut self) -> Result<(), SystemServiceError> {
        platform::clear()
    }

    fn list(&mut self) -> Result<Vec<PathBuf>, SystemServiceError> {
        platform::list()
    }
}

#[cfg(test)]
#[path = "recent_document_tests.rs"]
mod tests;
