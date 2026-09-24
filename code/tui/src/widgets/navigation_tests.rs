use super::Navigation;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;
use crossterm::event::KeyModifiers;

#[test]
fn navigation_aliases_repeat_but_modified_letters_and_releases_do_not_navigate() {
    for (letter, arrow, expected) in [
        ('j', KeyCode::Down, Navigation::Next),
        ('k', KeyCode::Up, Navigation::Previous),
    ] {
        for kind in [KeyEventKind::Press, KeyEventKind::Repeat] {
            for code in [KeyCode::Char(letter), arrow] {
                assert_eq!(
                    Navigation::from_key(KeyEvent::new_with_kind(code, KeyModifiers::NONE, kind)),
                    Some(expected)
                );
            }
        }
        for modifiers in [
            KeyModifiers::CONTROL,
            KeyModifiers::ALT,
            KeyModifiers::SHIFT,
        ] {
            assert_eq!(
                Navigation::from_key(KeyEvent::new(KeyCode::Char(letter), modifiers)),
                None
            );
        }
        assert_eq!(
            Navigation::from_key(KeyEvent::new_with_kind(
                arrow,
                KeyModifiers::NONE,
                KeyEventKind::Release
            )),
            None
        );
    }
}
