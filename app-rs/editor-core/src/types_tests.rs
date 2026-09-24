use super::EditorCoreRevision;
use super::EditorCoreSelection;
use super::EditorCoreSelectionSet;
use super::EditorCoreUtf16Offset;
use crate::EditorCoreEditError;

#[test]
fn selection_sets_require_an_existing_primary_selection() {
    assert!(EditorCoreSelectionSet::new(Vec::new(), 0).is_none());
    assert!(
        EditorCoreSelectionSet::new(
            vec![EditorCoreSelection::collapsed_at(
                EditorCoreUtf16Offset::ZERO
            )],
            1,
        )
        .is_none()
    );
}

#[test]
fn revisions_serialize_as_decimal_strings_for_javascript_transport() {
    let revision = EditorCoreRevision::INITIAL;

    assert_eq!(serde_json::to_string(&revision).unwrap(), "\"1\"");
    assert_eq!(
        serde_json::from_str::<EditorCoreRevision>("\"42\"")
            .unwrap()
            .value(),
        42
    );
}

#[test]
fn utf16_offsets_round_trip_at_utf8_boundaries_without_splitting_surrogates() {
    let text = "a😀b";
    let emoji_end = EditorCoreUtf16Offset::at_byte_offset(text, 5).unwrap();

    assert_eq!(emoji_end.value(), 3);
    assert_eq!(emoji_end.byte_offset_in(text).unwrap(), 5);
    assert_eq!(
        EditorCoreUtf16Offset::new(2).byte_offset_in(text),
        Err(EditorCoreEditError::InvalidUtf16Offset)
    );
    assert_eq!(
        EditorCoreUtf16Offset::at_byte_offset(text, 2),
        Err(EditorCoreEditError::InvalidUtf8Offset)
    );
}
