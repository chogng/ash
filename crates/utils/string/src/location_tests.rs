use super::normalize_markdown_hash_location_suffix;

#[test]
fn location_suffix_supports_lines_columns_and_ranges() {
    for (input, expected) in [
        ("#L12", ":12"),
        ("#L12C3", ":12:3"),
        ("#L12-L14", ":12-14"),
        ("#L12C3-L14C9", ":12:3-14:9"),
        ("#L12-L14C9", ":12-14:9"),
    ] {
        assert_eq!(
            normalize_markdown_hash_location_suffix(input).as_deref(),
            Some(expected)
        );
    }
}

#[test]
fn invalid_and_non_location_fragments_are_rejected() {
    for input in [
        "",
        "#section",
        "L12",
        "#L",
        "#L1C",
        "#Lx",
        "#L1C-1",
        "#L1-",
        "#L1-L2-L3",
        "#L1\n",
        "#L１",
    ] {
        assert!(
            normalize_markdown_hash_location_suffix(input).is_none(),
            "{input:?}"
        );
    }
}
