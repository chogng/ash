use ash_editor::{
    CodeEditorCommand, CodeEditorLanguage, CodeEditorPosition, CodeEditorSearchQuery,
    CodeEditorSelectionMode,
};
use ash_text_file::{
    TextFileAccess, TextFileDiskVersion, TextFileModifiedAt, TextFileSnapshot, TextFileStatus,
};

use super::*;
use zui::ui::TextInputCompositionEvent;

fn version(modified_at_millis: u64) -> TextFileDiskVersion {
    TextFileDiskVersion::new(
        8,
        TextFileModifiedAt::KnownMillis(modified_at_millis),
        TextFileAccess::Writable,
    )
}

fn snapshot(path: &str, content: &str, modified_at_millis: u64) -> TextFileSnapshot {
    TextFileSnapshot::new(path.into(), content.into(), version(modified_at_millis))
}

#[test]
fn tabs_retain_independent_documents_viewports_and_language_modes() {
    let mut host = FileEditorHost::default();
    host.open(snapshot("src/main.rs", "fn main() {}\n", 1));
    host.active_mut()
        .unwrap()
        .viewport_mut()
        .set_horizontal_column(7);
    host.open(snapshot("config.json", "{}\n", 2));

    assert_eq!(host.tabs().len(), 2);
    assert_eq!(host.active_index(), Some(1));
    assert_eq!(
        host.tabs()[0].document().language(),
        CodeEditorLanguage::Rust
    );
    assert_eq!(
        host.tabs()[1].document().language(),
        CodeEditorLanguage::Json
    );
    assert_eq!(host.tabs()[0].viewport().horizontal_column(), 7);
    assert!(host.select(0));
    assert_eq!(host.active().unwrap().path(), Path::new("src/main.rs"));
}

#[test]
fn dirty_save_and_close_contracts_follow_the_active_document() {
    let mut host = FileEditorHost::default();
    host.open(snapshot("notes.txt", "base", 1));
    host.apply(CodeEditorCommand::Insert("changed ".into()));

    assert_eq!(host.active().unwrap().status(), TextFileStatus::Dirty);
    assert_eq!(
        host.request_close_active(),
        FileEditorCloseRequest::NeedsConfirmation
    );
    let request = host.save_request().unwrap();
    assert_eq!(request.path(), Path::new("notes.txt"));
    assert_eq!(request.content(), "changed base");
    assert_eq!(request.expected_version(), version(1));

    assert!(host.mark_active_saved(version(2)));
    assert_eq!(host.active().unwrap().status(), TextFileStatus::Clean);
    assert_eq!(
        host.request_close_active(),
        FileEditorCloseRequest::CanClose
    );
}

#[test]
fn external_changes_reload_clean_tabs_and_conflict_with_dirty_tabs() {
    let mut host = FileEditorHost::default();
    host.open(snapshot("data.json", "{\"value\":1}", 1));
    assert!(host.observe_external(snapshot("data.json", "{\"value\":2}", 2)));
    assert_eq!(
        host.active().unwrap().status(),
        TextFileStatus::ReloadAvailable
    );
    assert!(host.reload_active_external());
    assert_eq!(host.active().unwrap().document().text(), "{\"value\":2}");

    host.apply(CodeEditorCommand::Insert(" ".into()));
    assert!(host.observe_external(snapshot("data.json", "{\"value\":3}", 3)));
    assert_eq!(host.active().unwrap().status(), TextFileStatus::Conflict);
    assert_eq!(host.active().unwrap().document().text(), " {\"value\":2}");
    let overwrite = host.overwrite_request().unwrap();
    assert_eq!(overwrite.content(), " {\"value\":2}");
    assert_eq!(overwrite.expected_version(), version(3));
}

#[test]
fn readonly_tabs_allow_navigation_but_reject_text_mutation() {
    let mut host = FileEditorHost::default();
    let readonly = TextFileSnapshot::new(
        "generated.rs".into(),
        "fn generated() {}".into(),
        TextFileDiskVersion::new(
            8,
            TextFileModifiedAt::KnownMillis(1),
            TextFileAccess::ReadOnly,
        ),
    );
    host.open(readonly);

    assert!(host.apply(CodeEditorCommand::SelectAll));
    assert!(!host.apply(CodeEditorCommand::DeleteForward));
    assert_eq!(
        host.active().unwrap().document().text(),
        "fn generated() {}"
    );
    assert_eq!(host.save_request(), None);
}

#[test]
fn dir_change_never_discards_dirty_tabs_implicitly() {
    let mut host = FileEditorHost::default();
    host.open(snapshot("first.txt", "first", 1));
    host.apply(CodeEditorCommand::Insert("dirty ".into()));

    assert_eq!(
        host.request_dir_change(),
        FileEditorCloseRequest::NeedsConfirmation
    );
    assert_eq!(host.tabs().len(), 1);
    assert!(host.close_active_discarding_changes());
    assert_eq!(host.request_dir_change(), FileEditorCloseRequest::CanClose);
    host.reset_for_dir_change();
}

#[test]
fn native_input_operations_delegate_text_and_viewport_state_to_the_active_editor() {
    let mut host = FileEditorHost::default();
    host.open(snapshot(
        "notes.txt",
        "zero\none\ntwo\nthree\nfour\nfive\n",
        1,
    ));

    assert!(host.move_active_caret(
        CodeEditorPosition {
            row_index: 5,
            byte_offset: 4,
        },
        CodeEditorSelectionMode::Move,
    ));
    host.reveal_active_caret(2);
    assert_eq!(host.active().unwrap().viewport().first_visible_row(), 4);

    assert!(host.apply_composition(TextInputCompositionEvent::Commit("!".into())));
    assert!(host.active().unwrap().document().text().contains("five!"));
    assert!(host.scroll_active_rows(-2, 7, 2));
    assert_eq!(host.active().unwrap().viewport().first_visible_row(), 2);
}

#[test]
fn native_find_replace_delegates_matching_and_mutation_to_the_active_editor() {
    let mut host = FileEditorHost::default();
    host.open(snapshot("notes.txt", "one fish two fish", 1));
    let query = CodeEditorSearchQuery::new("fish");

    assert_eq!(host.active_match_count(&query), 2);
    assert!(host.find_next(&query));
    assert_eq!(
        host.active().unwrap().document().selected_text(),
        Some("fish")
    );
    assert!(host.replace_current(&query, "cat"));
    assert_eq!(host.active().unwrap().document().text(), "one cat two fish");
    assert_eq!(host.replace_all(&query, "bird"), 1);
    assert_eq!(host.active().unwrap().document().text(), "one cat two bird");
}
