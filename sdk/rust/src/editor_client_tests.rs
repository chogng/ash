use super::DOCUMENT_CLIENT_CHANNEL;
use super::DescribeClientOperation;
use super::DescribeClientRequest;
use super::DocumentClientContribution;
use super::DocumentClientEditor;
use crate::HostErrorCode;
use serde_json::json;

fn digest() -> String {
    format!("sha256:{}", "a0".repeat(32))
}

fn editor() -> DocumentClientEditor {
    DocumentClientEditor {
        editor_id: "ash.editor.document".into(),
        display_name: "Document 文档".into(),
        document_type: "general".into(),
        content_type: "application/vnd.ash.document+json".into(),
        selectors: vec!["*.ash-doc".into()],
    }
}

fn assert_invalid(module: &str, digest: &str, editors: Vec<DocumentClientEditor>) {
    let error = DocumentClientContribution::new(module, digest, editors).unwrap_err();
    assert_eq!(error.code, HostErrorCode::InvalidRequest);
}

#[test]
fn exact_v1_json_shapes() {
    assert_eq!(DOCUMENT_CLIENT_CHANNEL, "editor.client.v1");
    let request: DescribeClientRequest = serde_json::from_value(json!({
        "operation": "describe", "language": "zh-CN"
    }))
    .unwrap();
    assert_eq!(request.operation, DescribeClientOperation::Describe);
    assert_eq!(request.language, "zh-CN");
    assert_eq!(
        serde_json::to_value(request).unwrap(),
        json!({ "operation": "describe", "language": "zh-CN" })
    );
    let contribution =
        DocumentClientContribution::new("dist/editor.js", digest(), vec![editor()]).unwrap();
    assert_eq!(
        serde_json::to_value(contribution).unwrap(),
        json!({
            "version": 1,
            "clientModule": "dist/editor.js",
            "clientDigest": digest(),
            "editors": [{
                "editorId": "ash.editor.document",
                "displayName": "Document 文档",
                "documentType": "general",
                "contentType": "application/vnd.ash.document+json",
                "selectors": ["*.ash-doc"]
            }]
        })
    );
}

#[test]
fn rejects_unknown_or_invalid_requests() {
    for value in [
        json!({ "operation": "describe", "language": "en", "extra": true }),
        json!({ "operation": "Describe", "language": "en" }),
        json!({ "operation": "other", "language": "en" }),
        json!({ "operation": "describe" }),
        json!({ "language": "en" }),
        json!({ "operation": "describe", "language": null }),
        json!({ "operation": "describe", "language": 1 }),
        json!({ "operation": "describe", "language": "" }),
        json!({ "operation": "describe", "language": "x".repeat(65) }),
        json!({ "operation": "describe", "language": "界".repeat(22) }),
        json!({ "operation": "describe", "language": "en\n" }),
        json!({ "operation": "describe", "language": "en\0" }),
        json!({ "operation": "describe", "language": "en\u{0085}" }),
    ] {
        assert!(
            serde_json::from_value::<DescribeClientRequest>(value.clone()).is_err(),
            "{value}"
        );
    }
    for language in ["en".to_owned(), "x".repeat(64), "界".repeat(21)] {
        assert!(
            serde_json::from_value::<DescribeClientRequest>(json!({
                "operation": "describe", "language": language
            }))
            .is_ok()
        );
    }
}

#[test]
fn rejects_unsupported_module_paths() {
    for module in [
        "",
        "/editor.js",
        "dist/",
        "dist//editor.js",
        ".",
        "..",
        "./editor.js",
        "../editor.js",
        "dist/./editor.js",
        "dist/../editor.js",
        "dist\\editor.js",
        "C:/editor.js",
        "https://example.com/editor.js",
        "dist/ed\0itor.js",
        "dist/ed\nitor.js",
        "dist/ed\u{0085}itor.js",
    ] {
        assert_invalid(module, &digest(), vec![editor()]);
    }
    assert_invalid(&"x".repeat(513), &digest(), vec![editor()]);
    assert_invalid(&"界".repeat(171), &digest(), vec![editor()]);
    for module in ["editor.js", "dist/nested/editor.js", &"x".repeat(512)] {
        assert!(DocumentClientContribution::new(module, digest(), vec![editor()]).is_ok());
    }
}

#[test]
fn rejects_unsupported_digests() {
    for value in [
        String::new(),
        "a".repeat(64),
        format!("SHA256:{}", "a".repeat(64)),
        format!("sha256:{}", "A".repeat(64)),
        format!("sha256:{}", "g".repeat(64)),
        format!("sha256:{}", "a".repeat(63)),
        format!("sha256:{}", "a".repeat(65)),
        format!("sha256:{}\n", "a".repeat(64)),
    ] {
        assert_invalid("dist/editor.js", &value, vec![editor()]);
    }
}

#[test]
fn rejects_duplicate_ids_and_editor_count_limits() {
    assert_invalid("editor.js", &digest(), vec![]);
    assert_invalid("editor.js", &digest(), vec![editor(), editor()]);
    let editors: Vec<_> = (0..33)
        .map(|index| DocumentClientEditor {
            editor_id: format!("editor.{index}"),
            ..editor()
        })
        .collect();
    assert_invalid("editor.js", &digest(), editors.clone());
    assert!(DocumentClientContribution::new("editor.js", digest(), editors[..32].to_vec()).is_ok());
}

#[test]
fn enforces_all_editor_text_and_selector_bounds() {
    for field in 0..5 {
        let limit = if field == 1 || field == 4 { 512 } else { 256 };
        for invalid in [
            String::new(),
            "x".repeat(limit + 1),
            "界".repeat(limit / 3 + 1),
            "text\n".into(),
            "text\0".into(),
            "text\u{007f}".into(),
            "text\u{009f}".into(),
        ] {
            let mut entry = editor();
            match field {
                0 => entry.editor_id = invalid,
                1 => entry.display_name = invalid,
                2 => entry.document_type = invalid,
                3 => entry.content_type = invalid,
                4 => entry.selectors = vec![invalid],
                _ => unreachable!(),
            }
            assert_invalid("editor.js", &digest(), vec![entry]);
        }
    }
    let mut entry = editor();
    entry.selectors = vec!["*.doc".into(); 65];
    assert_invalid("editor.js", &digest(), vec![entry]);
    let entry = DocumentClientEditor {
        editor_id: "i".repeat(256),
        display_name: "l".repeat(512),
        document_type: "t".repeat(256),
        content_type: "m".repeat(256),
        selectors: vec!["s".repeat(512); 64],
    };
    assert!(DocumentClientContribution::new("editor.js", digest(), vec![entry]).is_ok());
    let mut entry = editor();
    entry.selectors.clear();
    assert!(DocumentClientContribution::new("editor.js", digest(), vec![entry]).is_ok());
}
