use super::project_matched_indices;
use super::project_position;

#[test]
fn byte_positions_project_to_editor_utf16_coordinates() {
    let text = "😀alpha\nβeta";
    let beta = text.find('β').expect("beta offset");
    let position = project_position(text, beta + 'β'.len_utf8(), 1).expect("position");
    assert_eq!(position.line_index, 1);
    assert_eq!(position.column_index, 1);
}

#[test]
fn matcher_scalar_indices_project_to_utf16_offsets() {
    assert_eq!(project_matched_indices("😀aβ", &[0, 1, 2]), vec![0, 2, 3]);
}
