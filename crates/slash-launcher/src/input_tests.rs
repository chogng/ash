use crate::SlashLauncherInput;

#[test]
fn leading_slash_opens_the_launcher_for_the_first_token() {
    let query = SlashLauncherInput::at_cursor("/commit", 4).query().unwrap();
    assert_eq!(query.text, "com");
    assert_eq!(query.range, 0..7);
    assert_eq!(
        SlashLauncherInput::at_cursor("/", 1).query().unwrap().text,
        ""
    );
}

#[test]
fn launcher_stays_closed_outside_the_leading_token() {
    assert!(
        SlashLauncherInput::at_cursor("hello /com", 10)
            .query()
            .is_none()
    );
    assert!(
        SlashLauncherInput::at_cursor("/commit now", 11)
            .query()
            .is_none()
    );
    assert!(
        SlashLauncherInput::at_cursor("/commit\nnow", 11)
            .query()
            .is_none()
    );
    assert!(
        SlashLauncherInput::at_cursor("/commit", 0)
            .query()
            .is_none()
    );
}

#[test]
fn launcher_rejects_a_cursor_inside_a_utf8_codepoint() {
    assert!(SlashLauncherInput::at_cursor("/技", 2).query().is_none());
}
