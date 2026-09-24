use super::{ALL_ICONS, IconId, IconRendering, generated::ALL_ARTWORK, icon_by_id, icons};

#[test]
fn semantic_library_is_sorted_and_has_unique_ids() {
    assert!(!ALL_ICONS.is_empty());
    assert!(
        ALL_ICONS
            .windows(2)
            .all(|icons| icons[0].id() < icons[1].id())
    );
}

#[test]
fn catalog_resolves_generated_icon_ids() {
    assert_eq!(icon_by_id("files"), Some(icons::FILES));
    assert_eq!(icon_by_id("file-text"), Some(icons::FILE_TEXT));
    assert_eq!(icon_by_id("git-branch"), Some(icons::GIT_BRANCH));
    assert_eq!(icon_by_id("new-folder"), Some(icons::NEW_FOLDER));
    assert_eq!(icon_by_id("refresh"), Some(icons::REFRESH));
    assert_eq!(icon_by_id("missing"), None);
}

#[test]
fn semantic_library_distinguishes_symbolic_and_multicolor_artwork() {
    assert_eq!(
        icons::FILES.definition().rendering(),
        IconRendering::Symbolic
    );
    assert_eq!(
        icons::LAYOUT_PANEL_OFF.definition().rendering(),
        IconRendering::Multicolor
    );
}

#[test]
fn sidebar_toggle_icons_preserve_their_rendering_contracts() {
    for icon in [
        icons::LAYOUT_SIDEBAR_LEFT,
        icons::LAYOUT_SIDEBAR_LEFT_OFF_EMPTY,
        icons::LAYOUT_SIDEBAR_RIGHT,
        icons::LAYOUT_SIDEBAR_RIGHT_OFF_EMPTY,
    ] {
        assert_eq!(icon.definition().rendering(), IconRendering::Symbolic);
    }
    assert_eq!(
        icons::LAYOUT_SIDEBAR_RIGHT_OFF.definition().rendering(),
        IconRendering::Multicolor
    );
}

#[test]
fn generated_icons_use_their_svg_filename_as_the_id() {
    assert_eq!(icons::HISTORY.id().as_str(), "history");
    assert_eq!(icons::DIFF.id().as_str(), "diff");
    assert_ne!(icons::HISTORY.definition(), icons::REFRESH.definition());
}

#[test]
fn every_generated_icon_contains_one_svg_document() {
    assert!(!ALL_ARTWORK.is_empty());
    assert!(
        ALL_ARTWORK
            .windows(2)
            .all(|artwork| artwork[0].0 < artwork[1].0)
    );

    for (resource_name, definition) in ALL_ARTWORK {
        let svg = std::str::from_utf8(definition.svg()).unwrap();
        assert!(svg.trim_start().starts_with("<svg"), "{resource_name}");
        assert!(svg.trim_end().ends_with("</svg>"), "{resource_name}");
    }
}

#[test]
#[should_panic(expected = "icon ID must be lowercase kebab-case ASCII")]
fn icon_id_rejects_non_canonical_values() {
    IconId::new("Invalid Icon");
}
