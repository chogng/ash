use crate::app::ApplicationHandle;
use crate::services::JumpListCategory;
use crate::services::JumpListSettings;
use crate::services::JumpListTask;
use crate::services::JumpListUpdateResult;
use crate::services::SystemServiceError;

use super::AppContext;
use super::WindowContext;

macro_rules! jump_list_methods {
    () => {
        /// Returns Windows Jump List limits and destinations explicitly removed by the user.
        pub fn jump_list_settings(&self) -> Result<JumpListSettings, SystemServiceError> {
            self.services.jump_lists().settings()
        }

        /// Replaces the complete Windows Jump List.
        pub fn set_jump_list(
            &self,
            categories: Vec<JumpListCategory>,
        ) -> Result<JumpListUpdateResult, SystemServiceError> {
            self.services.jump_lists().set(categories)
        }

        /// Replaces the standard Windows Jump List Tasks category.
        pub fn set_user_tasks(
            &self,
            tasks: Vec<JumpListTask>,
        ) -> Result<JumpListUpdateResult, SystemServiceError> {
            self.services.jump_lists().set_user_tasks(tasks)
        }

        /// Deletes the custom Jump List and restores the Windows-managed default.
        pub fn reset_jump_list(&self) -> Result<JumpListUpdateResult, SystemServiceError> {
            self.services.jump_lists().reset()
        }
    };
}

impl<T: 'static> ApplicationHandle<T> {
    jump_list_methods!();
}

impl<'a, T: 'static> AppContext<'a, T> {
    jump_list_methods!();
}

impl<'a, T: 'static> WindowContext<'a, T> {
    jump_list_methods!();
}
