use super::TerminalPaneViews;

#[test]
fn activation_saves_and_restores_each_pane_input_view() {
    let mut views = TerminalPaneViews::<u8, usize>::default();

    views.activate(1);
    *views.active_view_mut() = 10;
    views.activate(2);
    *views.active_view_mut() = 20;
    views.activate(1);
    assert_eq!(views.active(), Some(&1));
    assert_eq!(views.active_view(), &10);
    assert_eq!(views.inactive(&2), Some(&20));
}

#[test]
fn removing_an_active_view_clears_active_identity() {
    let mut views = TerminalPaneViews::<u8, usize>::default();
    views.activate(1);

    views.remove(&1);

    assert_eq!(views.active(), None);
}
