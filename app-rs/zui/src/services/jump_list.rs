use std::cell::RefCell;
use std::rc::Rc;

use super::SystemServiceError;

#[path = "jump_list/model.rs"]
mod model;
#[path = "jump_list/platform.rs"]
mod platform;

pub use model::JumpListCategory;
pub use model::JumpListCategoryKind;
pub use model::JumpListItem;
pub use model::JumpListModelError;
pub use model::JumpListRequest;
pub use model::JumpListSettings;
pub use model::JumpListTask;
pub use model::JumpListUpdateResult;

const JUMP_LIST: &str = "Windows Jump List";

/// Main-thread backend for Windows taskbar Jump List configuration.
pub trait JumpListService {
    /// Returns the shell's minimum item count and destinations explicitly removed by the user.
    fn settings(&mut self) -> Result<JumpListSettings, SystemServiceError>;

    /// Replaces or resets the current process identity's Jump List.
    fn set(
        &mut self,
        request: &JumpListRequest,
    ) -> Result<JumpListUpdateResult, SystemServiceError>;
}

/// Cloneable main-thread capability for Windows taskbar Jump Lists.
#[derive(Clone)]
pub struct JumpListHandle {
    service: Rc<RefCell<Box<dyn JumpListService>>>,
}

impl JumpListHandle {
    pub(crate) fn new(service: impl JumpListService + 'static) -> Self {
        Self {
            service: Rc::new(RefCell::new(Box::new(service))),
        }
    }

    /// Returns the shell's minimum item count and destinations explicitly removed by the user.
    pub fn settings(&self) -> Result<JumpListSettings, SystemServiceError> {
        self.service.borrow_mut().settings()
    }

    /// Replaces the entire Jump List after validating every category and item.
    pub fn set(
        &self,
        categories: Vec<JumpListCategory>,
    ) -> Result<JumpListUpdateResult, SystemServiceError> {
        self.apply(JumpListRequest::Categories(categories))
    }

    /// Replaces the standard Tasks category with static application-launch tasks.
    pub fn set_user_tasks(
        &self,
        tasks: Vec<JumpListTask>,
    ) -> Result<JumpListUpdateResult, SystemServiceError> {
        let items = tasks.into_iter().map(JumpListItem::Task).collect();
        self.set(vec![JumpListCategory::tasks(items)])
    }

    /// Deletes the custom Jump List and restores the Windows-managed default.
    pub fn reset(&self) -> Result<JumpListUpdateResult, SystemServiceError> {
        self.apply(JumpListRequest::Default)
    }

    /// Applies an explicit replacement or reset request.
    pub fn apply(
        &self,
        request: JumpListRequest,
    ) -> Result<JumpListUpdateResult, SystemServiceError> {
        request
            .validate()
            .map_err(|source| SystemServiceError::invalid_input(JUMP_LIST, source))?;
        self.service.borrow_mut().set(&request)
    }
}

/// Default operating-system Jump List backend.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemJumpLists;

impl JumpListService for SystemJumpLists {
    fn settings(&mut self) -> Result<JumpListSettings, SystemServiceError> {
        platform::settings()
    }

    fn set(
        &mut self,
        request: &JumpListRequest,
    ) -> Result<JumpListUpdateResult, SystemServiceError> {
        request
            .validate()
            .map_err(|source| SystemServiceError::invalid_input(JUMP_LIST, source))?;
        platform::set(request)
    }
}

#[cfg(test)]
#[path = "jump_list_tests.rs"]
mod tests;
