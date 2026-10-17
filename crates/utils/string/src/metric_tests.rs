use super::sanitize_metric_tag_value;

#[test]
fn metric_labels_match_the_codex_contract() {
    for (input, expected) in [
        ("", "unspecified"),
        ("__.-/中文__", "unspecified"),
        (" bad value! ", "bad_value"),
        ("A.b_c-d/e", "A.b_c-d/e"),
        ("模型/gpt-5", "/gpt-5"),
    ] {
        assert_eq!(sanitize_metric_tag_value(input), expected);
    }
    assert_eq!(sanitize_metric_tag_value(&"😀a".repeat(300)).len(), 256);
}
