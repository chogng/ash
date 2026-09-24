//! Session Pane interaction identity tests.

use super::ContextAction;
use super::{CONTEXT_DIFF, CONTEXT_GIT_BRANCH, CONTEXT_LOCATION, CONTEXT_WORKING_DIRECTORY};

#[test]
fn context_actions_have_stable_unique_element_identities() {
    let ids = ContextAction::ALL.map(ContextAction::element_id);

    assert_eq!(
        ids,
        [
            CONTEXT_LOCATION,
            CONTEXT_WORKING_DIRECTORY,
            CONTEXT_GIT_BRANCH,
            CONTEXT_DIFF,
        ]
    );
    assert_eq!(
        ContextAction::from_element_id(ids[2]),
        Some(ContextAction::GitBranch)
    );
    assert_eq!(
        ids.into_iter()
            .collect::<std::collections::HashSet<_>>()
            .len(),
        4
    );
}
