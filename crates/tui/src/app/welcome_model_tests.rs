use super::*;
use std::path::Path;

#[test]
fn directory_below_home_uses_tilde_prefix() {
    assert_eq!(
        format_directory(
            Path::new("/Users/ash/Desktop/project"),
            Some(Path::new("/Users/ash")),
        ),
        format!(
            "~{}{}",
            std::path::MAIN_SEPARATOR,
            Path::new("Desktop/project").display()
        )
    );
}

#[test]
fn directory_outside_home_keeps_its_absolute_path() {
    assert_eq!(
        format_directory(Path::new("/work/project"), Some(Path::new("/Users/ash"))),
        "/work/project"
    );
}
