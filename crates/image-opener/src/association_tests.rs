use super::Association;

#[test]
fn uses_the_effective_prog_id_when_two_handlers_share_an_app_id() {
    let handlers = [
        Association {
            app_id: Some("Package!App".into()),
            prog_id: Some("AppXOther".into()),
            ..Association::default()
        },
        Association {
            app_id: Some("Package!App".into()),
            prog_id: Some("AppXImage".into()),
            ..Association::default()
        },
    ];
    let default = Association {
        app_id: Some("package!app".into()),
        prog_id: Some("appximage".into()),
        ..Association::default()
    };
    assert_eq!(default.default_index(handlers.iter()), Some(1));
}

#[test]
fn uses_a_desktop_executable_only_when_it_identifies_one_handler() {
    let desktop_handler = || Association {
        target: Some(r"C:\Program Files\Image Viewer\viewer.exe".into()),
        ..Association::default()
    };
    let default = desktop_handler();
    assert_eq!(default.default_index([desktop_handler()].iter()), Some(0));
    assert_eq!(
        default.default_index([desktop_handler(), desktop_handler()].iter()),
        None
    );
    let packaged_default = Association {
        app_id: Some("DifferentPackage!App".into()),
        ..default
    };
    assert_eq!(
        packaged_default.default_index([desktop_handler()].iter()),
        None
    );
}
