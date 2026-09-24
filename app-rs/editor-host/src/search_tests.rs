use super::{FileEditorSearchMode, FileEditorSearchState};
use zui::ui::TextInputCommand;

#[test]
fn search_state_only_owns_transient_single_line_inputs() {
    let mut search = FileEditorSearchState::default();
    assert_eq!(search.mode(), FileEditorSearchMode::Hidden);

    search.show_find();
    search.apply_query(TextInputCommand::Insert("needle".to_owned()));
    assert_eq!(search.mode(), FileEditorSearchMode::Find);
    assert_eq!(search.query().text(), "needle");

    search.show_replace();
    search.apply_replacement(TextInputCommand::Insert("replacement".to_owned()));
    assert_eq!(search.mode(), FileEditorSearchMode::Replace);
    assert_eq!(search.replacement(), "replacement");

    search.hide();
    assert_eq!(search.mode(), FileEditorSearchMode::Hidden);
}
