use super::Args;
use super::check_rust_output;
use super::constant_name;
use super::raster_dimensions;
use super::terminal_dimensions;
use super::write_action;
use ash_sprite::compile_sprite_sheet;
use clap::Parser;
use std::fs;

#[test]
fn default_terminal_dimensions_compensate_for_tall_cells() {
    assert_eq!(terminal_dimensions(8, 8, None, None).unwrap(), (8, 4));
    assert_eq!(terminal_dimensions(16, 16, None, None).unwrap(), (16, 8));
    assert_eq!(
        terminal_dimensions(32, 16, Some(12), None).unwrap(),
        (12, 3)
    );
    assert_eq!(terminal_dimensions(32, 16, None, Some(3)).unwrap(), (12, 3));
}

#[test]
fn image_raster_uses_two_by_four_source_samples_per_terminal_cell() {
    assert_eq!(raster_dimensions(8, 4).unwrap(), (16, 16));
    assert_eq!(raster_dimensions(8, 5).unwrap(), (16, 20));
}

#[test]
fn rust_constant_names_are_explicit_and_stable() {
    assert_eq!(constant_name("WELCOME_PET").unwrap(), "WELCOME_PET");
    assert!(constant_name("WelcomePet").is_err());
    assert!(constant_name("9PET").is_err());
}

#[test]
fn check_requires_a_rust_output_path() {
    assert!(Args::try_parse_from(["ash-sprite", "pet.svg", "--check"]).is_err());
}

#[test]
fn named_sprite_preview_selection_is_positional() {
    let args = Args::try_parse_from(["ash-sprite", "pet.sprite", "frames"]).unwrap();

    assert_eq!(args.preview.as_deref(), Some("frames"));
}

#[test]
fn non_terminal_action_preview_lists_timing_and_returns_to_idle() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("pet.sprite");
    fs::write(
        &path,
        "version 2\nsize 1 1\ncolor B #4085AC\ncell a █ B .\n\nframe idle\na\nend\n\nframe press\na\nend\n\naction click\npress 75\nend\n",
    )
    .unwrap();
    let sheet = compile_sprite_sheet(&path).unwrap();
    let mut output = Vec::new();

    write_action(
        &mut output,
        &sheet,
        sheet.action("click").unwrap().steps(),
        false,
    )
    .unwrap();

    let output = String::from_utf8(output).unwrap();
    assert!(output.starts_with("press 75ms\n"));
    assert!(output.contains("\nidle\n"));
}

#[test]
fn rust_output_check_rejects_stale_generated_source() {
    let directory = tempfile::tempdir().unwrap();
    let output = directory.path().join("asset.rs");
    fs::write(&output, "expected").unwrap();

    check_rust_output(&output, "expected").unwrap();
    let error = check_rust_output(&output, "changed").unwrap_err();

    assert!(error.to_string().contains("is out of date"));
}
