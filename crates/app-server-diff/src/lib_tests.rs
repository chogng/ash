use super::project;
use ash_diff::DiffDocument;

#[test]
fn projects_rust_rows_and_utf16_inline_ranges_for_the_frontend() {
    let document = DiffDocument::from_text("before 😀 after", "before 🤖 after").unwrap();
    let result = project(document, &super::zero_based_line_index);

    assert_eq!(result.original_line_count, 1);
    assert_eq!(result.modified_line_count, 1);
    assert_eq!(result.rows.len(), 1);
    assert_eq!(result.rows[0].original_line_index, Some(0));
    assert_eq!(result.rows[0].modified_line_index, Some(0));
    assert_eq!(result.rows[0].original_changes[0].start_column, 7);
    assert_eq!(result.rows[0].original_changes[0].end_column, 9);
    assert_eq!(result.rows[0].modified_changes[0].start_column, 7);
    assert_eq!(result.rows[0].modified_changes[0].end_column, 9);
}

#[test]
fn request_boundary_rejects_invalid_params_and_binary_inputs() {
    for params in [
        serde_json::json!(null),
        serde_json::json!({"original": 1, "modified": ""}),
        serde_json::json!({"original": "a\u{0}b", "modified": ""}),
    ] {
        let error = super::compute(&params).unwrap_err();
        assert_eq!(error.code, -32602);
        assert_eq!(
            error.data.kind,
            ash_app_server_protocol::protocol::error::AppServerErrorName::InvalidParams
        );
    }
}

#[test]
fn request_boundary_limits_utf8_bytes_on_each_side() {
    let oversized = "😀".repeat(128 * 1024 + 1);
    for params in [
        serde_json::json!({"original": oversized, "modified": ""}),
        serde_json::json!({"original": "", "modified": oversized}),
    ] {
        let error = super::compute(&params).unwrap_err();
        assert_eq!(error.code, -32602);
        assert_eq!(
            error.data.kind,
            ash_app_server_protocol::protocol::error::AppServerErrorName::InvalidParams
        );
    }
}

#[test]
fn function_override_projects_rows_and_hunks_and_can_decline() {
    let params = serde_json::json!({"original": "before 😀", "modified": "after 🤖"});
    let native = super::compute(&params).unwrap();
    assert_eq!(
        super::compute_with_line_index(&params, |_| None).unwrap(),
        native
    );
    let replaced = super::compute_with_line_index(&params, Some).unwrap();
    assert_eq!(replaced["rows"][0]["originalLineIndex"], 1);
    assert_eq!(replaced["hunks"][0]["originalStartLineIndex"], 1);
    assert_eq!(
        replaced["rows"][0]["originalChanges"],
        native["rows"][0]["originalChanges"]
    );
}
