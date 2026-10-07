use crate::CoreError;
use core_api::ThreadWorktreeBinder;
use core_api::ThreadWorktreeBindingRequest;

pub struct NoThreadWorktreeBinder;

impl ThreadWorktreeBinder for NoThreadWorktreeBinder {
    fn provision(&self, _: &ThreadWorktreeBindingRequest) -> Result<(), CoreError> {
        Ok(())
    }
}
