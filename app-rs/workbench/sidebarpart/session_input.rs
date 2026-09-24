use crate::TabInput;
use crate::TabInputMetadata;
use crate::TabStatus;
use ash_protocol::Session;

/// Builds the Workbench tab description owned by one Session.
pub fn session_tab_input(session: &Session, dirs: impl IntoIterator<Item = PathBuf>) -> TabInput {
    let metadata = TabInputMetadata::new(&session.title)
        .with_dirs(dirs)
        .with_status(TabStatus::from(session.manager.status));
    TabInput::session(session.session_id.clone(), metadata)
}

#[cfg(test)]
#[path = "session_input_tests.rs"]
mod tests;
use std::path::PathBuf;
