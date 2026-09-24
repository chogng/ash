//! Sidebar Session search matching and input tests.

use super::SessionSearchState;
use zui::ui::TextInputCommand;

#[test]
fn session_name_matching_is_case_insensitive_and_ignores_outer_query_whitespace() {
    let mut search = SessionSearchState::default();

    assert!(search.matches_session_name("Review terminal navigation"));

    search.apply(TextInputCommand::Insert("  TERMINAL  ".to_owned()));

    assert!(search.matches_session_name("Review terminal navigation"));
    assert!(!search.matches_session_name("Directory setup"));
}
