use super::terminal_sprite_rust_source;
use super::terminal_sprite_sheet_rust_source;
use crate::compile_sprite_sheet;
use crate::pack_half_blocks_rgba;
use std::fs;

#[test]
fn rust_assets_use_the_packed_cell_data() {
    let pixels = vec![[0x40, 0x85, 0xac, 0xff]; 4];
    let sprite = pack_half_blocks_rgba(2, 2, &pixels, 128).unwrap();

    let source = terminal_sprite_rust_source("PET", &sprite);

    assert!(source.contains("pub(super) static PET: TerminalSprite<'static> ="));
    assert!(source.contains("    2,"));
    assert!(source.contains("    1,"));
    assert!(source.contains("SpriteCell::new('█', Some(Rgb::new(0x40, 0x85, 0xac)), None)"));
    assert!(source.contains("use ash_sprite::TerminalSprite;"));
}

#[test]
fn named_frames_and_actions_are_embedded_in_one_static_sheet() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("pet.sprite");
    fs::write(
        &path,
        "version 2\nsize 1 1\ncolor B #4085AC\ncell a █ B .\n\nframe idle\na\nend\n\nframe press\na\nend\n\naction click\npress 75\nend\n",
    )
    .unwrap();
    let sheet = compile_sprite_sheet(&path).unwrap();

    let source = terminal_sprite_sheet_rust_source("PET", &sheet);

    assert!(source.contains("static PET_IDLE_CELLS: &[SpriteCell]"));
    assert!(source.contains("static PET_PRESS_CELLS: &[SpriteCell]"));
    assert!(source.contains("TerminalSpriteFrame::new(\"idle\", TerminalSprite::new(1, 1"));
    assert!(source.contains("TerminalSpriteActionStep::new(1, 75)"));
    assert!(source.contains("TerminalSpriteAction::new(\"click\", PET_CLICK_STEPS)"));
    assert!(source.contains("pub(super) static PET: TerminalSpriteSheet<'static>"));
}

#[test]
fn two_color_rust_cells_are_emitted_in_rustfmt_ready_form() {
    let blue = [0x40, 0x85, 0xac, 0xff];
    let black = [0x00, 0x00, 0x00, 0xff];
    let sprite = pack_half_blocks_rgba(1, 2, &[blue, black], 128).unwrap();

    let source = terminal_sprite_rust_source("PET", &sprite);

    assert!(source.contains("        SpriteCell::new(\n"));
    assert!(source.contains("            Some(Rgb::new(0x40, 0x85, 0xac)),\n"));
    assert!(source.contains("            Some(Rgb::new(0x00, 0x00, 0x00)),\n"));
}
