use super::{MainSurface, MainSurfaceKind};

#[test]
fn agent_is_default_and_terminal_is_an_explicit_reversible_surface() {
    let mut surface = MainSurface::default();

    assert_eq!(surface.active(), MainSurfaceKind::Agent);
    assert!(!surface.is_terminal());
    surface.toggle_terminal();
    assert_eq!(surface.active(), MainSurfaceKind::Terminal);
    assert!(surface.is_terminal());
    surface.toggle_terminal();
    assert_eq!(surface.active(), MainSurfaceKind::Agent);
}

#[test]
fn terminal_returns_to_the_file_editor_that_opened_it() {
    let mut surface = MainSurface::default();

    surface.show_editor();
    assert_eq!(surface.active(), MainSurfaceKind::Editor);
    surface.toggle_terminal();
    assert_eq!(surface.active(), MainSurfaceKind::Terminal);
    surface.toggle_terminal();
    assert_eq!(surface.active(), MainSurfaceKind::Editor);

    surface.show_agent();
    assert_eq!(surface.active(), MainSurfaceKind::Agent);
}
