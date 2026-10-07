use crate::CoreError;
use core_api::TurnExecutionFinished;
use core_api::TurnExecutionObserver;
use core_api::TurnExecutionStarted;

/// Observer used when the host does not offer Turn change capture.
pub struct NoTurnExecutionObserver;

impl TurnExecutionObserver for NoTurnExecutionObserver {
    fn will_execute(&self, _: &TurnExecutionStarted) -> Result<(), CoreError> {
        Ok(())
    }

    fn did_finish(&self, _: &TurnExecutionFinished) {}
}
