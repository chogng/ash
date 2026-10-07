use super::*;

#[test]
fn plugin_paths_use_one_portable_canonical_form() {
    let path = PluginPath::new("skills/code-review/SKILL.md").unwrap();
    assert_eq!(path.as_str(), "skills/code-review/SKILL.md");
    assert_eq!(
        path.to_platform_path(),
        PathBuf::from("skills").join("code-review").join("SKILL.md")
    );
}

#[test]
fn plugin_paths_reject_traversal_and_platform_ambiguity() {
    let cases = [
        ("", InvalidPluginPath::Empty),
        ("/etc/passwd", InvalidPluginPath::NotRelativeSlashSeparated),
        (
            "C:\\Windows\\system.ini",
            InvalidPluginPath::NotRelativeSlashSeparated,
        ),
        ("skills//review", InvalidPluginPath::EmptySegment),
        ("skills/./review", InvalidPluginPath::DotSegment),
        ("skills/../review", InvalidPluginPath::DotSegment),
        ("assets/con.txt", InvalidPluginPath::PlatformDeviceName),
        ("assets/COM1", InvalidPluginPath::PlatformDeviceName),
        ("技能/review", InvalidPluginPath::UnsupportedCharacter),
        (
            "assets/name with space",
            InvalidPluginPath::UnsupportedCharacter,
        ),
    ];
    for (value, expected) in cases {
        assert_eq!(PluginPath::new(value), Err(expected), "{value}");
    }
}

#[test]
fn plugin_paths_enforce_depth_and_segment_limits() {
    assert_eq!(
        PluginPath::new("x".repeat(MAX_PLUGIN_PATH_SEGMENT_BYTES + 1)),
        Err(InvalidPluginPath::SegmentTooLong)
    );
    assert_eq!(
        PluginPath::new(vec!["x"; MAX_PLUGIN_PATH_DEPTH + 1].join("/")),
        Err(InvalidPluginPath::TooDeep)
    );
}
