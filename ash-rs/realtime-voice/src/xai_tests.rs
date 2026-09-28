use super::Draft;

#[test]
fn completed_phrases_accumulate_and_stop_replaces_unfinished_hypothesis() {
    let mut draft = Draft::default();
    assert_eq!(draft.preview("open"), "open");
    draft.locked("open the");
    assert_eq!(draft.preview("file"), "open the file");
    draft.phrase("open the file");
    assert_eq!(draft.finish(""), "open the file");
    assert_eq!(draft.preview("run"), "open the file run");
    draft.locked("run the");
    assert_eq!(draft.finish("run the tests"), "open the file run the tests");
}
