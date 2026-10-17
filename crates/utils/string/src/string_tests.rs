use super::take_bytes_at_char_boundary;

#[test]
fn prefix_uses_bytes_and_keeps_complete_unicode_scalars() {
    let text = "aé中😀z";
    let expected = [
        "",
        "a",
        "a",
        "aé",
        "aé",
        "aé",
        "aé中",
        "aé中",
        "aé中",
        "aé中",
        "aé中😀",
        "aé中😀z",
    ];
    for (budget, expected) in expected.into_iter().enumerate() {
        let prefix = take_bytes_at_char_boundary(text, budget);
        assert_eq!(prefix, expected, "budget {budget}");
        assert!(prefix.len() <= budget);
        assert_eq!(prefix.as_ptr(), text.as_ptr());
    }
}

#[test]
fn empty_exact_and_oversized_budgets_preserve_the_borrowed_prefix() {
    for text in ["", "ascii", "中文", "😀"] {
        assert_eq!(take_bytes_at_char_boundary(text, 0), "");
        for budget in [text.len(), text.len() + 1, usize::MAX] {
            let prefix = take_bytes_at_char_boundary(text, budget);
            assert_eq!(prefix, text);
            assert_eq!(prefix.as_ptr(), text.as_ptr());
        }
    }
}

#[test]
fn prefix_does_not_apply_grapheme_or_display_width_policy() {
    assert_eq!(take_bytes_at_char_boundary("e\u{301}", 1), "e");
    assert_eq!(take_bytes_at_char_boundary("👩‍💻", 4), "👩");
}
