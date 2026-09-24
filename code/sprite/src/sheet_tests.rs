use super::compile_sprite_sheet;
use crate::Rgb;
use std::fs;

const SHEET: &str = "version 2\nsize 2 1\ncolor B #4085AC\ncolor K #000000\ncell a ▛ B K\ncell s space . B\n\nframe idle\nas\nend\n\nframe blink\naa\nend\n\naction click\nblink 75\nend\n";

#[test]
fn pixel_grid_format_is_rejected() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("pet.sprite");
    fs::write(&path, "version 1\nsize 16 16\n").unwrap();

    let error = compile_sprite_sheet(&path).unwrap_err();

    assert!(error.to_string().contains("line 1 must be 'version 2'"));
}

#[test]
fn named_terminal_cell_frames_and_actions_compile_without_reencoding() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("pet.sprite");
    fs::write(&path, SHEET).unwrap();

    let sheet = compile_sprite_sheet(&path).unwrap();
    let idle = sheet.frames()[0].sprite().as_sprite();

    assert_eq!(sheet.frames().len(), 2);
    assert_eq!(sheet.dimensions(), (2, 1));
    assert_eq!(sheet.frames()[0].name(), "idle");
    assert_eq!((idle.width(), idle.height()), (2, 1));
    assert_eq!(idle.cells()[0].symbol(), '▛');
    assert_eq!(
        idle.cells()[0].foreground(),
        Some(Rgb::new(0x40, 0x85, 0xac))
    );
    assert_eq!(idle.cells()[0].background(), Some(Rgb::new(0, 0, 0)));
    assert_eq!(idle.cells()[1].symbol(), ' ');
    assert_eq!(idle.cells()[1].foreground(), None);
    assert_eq!(
        idle.cells()[1].background(),
        Some(Rgb::new(0x40, 0x85, 0xac))
    );
    assert_eq!(sheet.idle_frame_index(), 0);
    assert_eq!(sheet.action("click").unwrap().steps()[0].frame_index(), 1);
    assert_eq!(sheet.action("click").unwrap().steps()[0].duration_ms(), 75);
}

#[test]
fn parser_rejects_unknown_cells_and_non_classic_block_glyphs() {
    let directory = tempfile::tempdir().unwrap();
    let unknown = directory.path().join("unknown.sprite");
    fs::write(
        &unknown,
        "version 2\nsize 1 1\ncolor B #4085AC\ncell a █ B .\n\nframe idle\nx\nend\n",
    )
    .unwrap();
    let unsupported = directory.path().join("unsupported.sprite");
    fs::write(
        &unsupported,
        "version 2\nsize 1 1\ncolor B #4085AC\ncell a 𜺨 B .\n\nframe idle\na\nend\n",
    )
    .unwrap();

    assert!(
        compile_sprite_sheet(&unknown)
            .unwrap_err()
            .to_string()
            .contains("undefined cell 'x'")
    );
    assert!(
        format!("{:#}", compile_sprite_sheet(&unsupported).unwrap_err())
            .contains("classic Unicode block character")
    );
}

#[test]
fn parser_rejects_invisible_cell_definitions() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("pet.sprite");
    fs::write(
        &path,
        "version 2\nsize 1 1\ncolor B #4085AC\ncell a space B .\n\nframe idle\na\nend\n",
    )
    .unwrap();

    let error = compile_sprite_sheet(&path).unwrap_err();

    assert!(format!("{error:#}").contains("space cells must define a background color"));
}

#[test]
fn parser_rejects_unknown_action_frames_and_invalid_timing() {
    let directory = tempfile::tempdir().unwrap();
    let unknown = directory.path().join("unknown.sprite");
    fs::write(
        &unknown,
        "version 2\nsize 1 1\ncolor B #4085AC\ncell a █ B .\n\nframe idle\na\nend\n\naction click\nmissing 75\nend\n",
    )
    .unwrap();
    let timing = directory.path().join("timing.sprite");
    fs::write(
        &timing,
        "version 2\nsize 1 1\ncolor B #4085AC\ncell a █ B .\n\nframe idle\na\nend\n\nframe press\na\nend\n\naction click\npress 80\nend\n",
    )
    .unwrap();

    assert!(
        compile_sprite_sheet(&unknown)
            .unwrap_err()
            .to_string()
            .contains("unknown frame 'missing'")
    );
    assert!(
        compile_sprite_sheet(&timing)
            .unwrap_err()
            .to_string()
            .contains("multiple of 25ms")
    );
}

#[test]
fn actions_return_to_idle_implicitly() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("pet.sprite");
    fs::write(
        &path,
        "version 2\nsize 1 1\ncolor B #4085AC\ncell a █ B .\n\nframe idle\na\nend\n\naction click\nidle 75\nend\n",
    )
    .unwrap();

    let error = compile_sprite_sheet(&path).unwrap_err();

    assert!(error.to_string().contains("must not reference idle"));
}

#[test]
fn every_sheet_requires_an_idle_frame() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("pet.sprite");
    fs::write(
        &path,
        "version 2\nsize 1 1\ncolor B #4085AC\ncell a █ B .\n\nframe wave\na\nend\n",
    )
    .unwrap();

    let error = compile_sprite_sheet(&path).unwrap_err();

    assert!(error.to_string().contains("must define frame 'idle'"));
}
