use super::*;

fn type_key(view: &mut ReconnectView, code: KeyCode) -> bool {
    view.handle_key(KeyEvent::new(code, KeyModifiers::NONE))
}

fn screen(view: &ReconnectView, language: Language) -> String {
    view.lines(language, None)
        .into_iter()
        .map(|line| line.to_string())
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn reconnect_menu_and_dispatch_share_availability() {
    let mut view = ReconnectView::new();
    let menu = screen(&view, Language::English);
    assert!(!menu.contains("/help"));
    assert!(menu.contains("↑/↓ Select · Enter Run · Ctrl+C Quit"));
    assert!(menu.contains("/quit"));
    assert!(menu.contains("/status"));
    assert!(!menu.contains("/model"));

    for character in "help".chars() {
        type_key(&mut view, KeyCode::Char(character));
    }
    assert!(view.commands.catalog().command_named("help").is_none());
    assert!(!type_key(&mut view, KeyCode::Enter));

    type_key(&mut view, KeyCode::Esc);
    for character in "model".chars() {
        type_key(&mut view, KeyCode::Char(character));
    }
    let disabled = screen(&view, Language::Chinese);
    insta::assert_snapshot!(disabled, @"
正在重新连接 App Server…
> /model
› /model  需要连接 App Server。
  /memories  需要连接 App Server。
↑/↓ 选择 · Enter 执行 · Ctrl+C 退出
");
    assert!(!type_key(&mut view, KeyCode::Enter));
    assert!(screen(&view, Language::Chinese).starts_with("需要连接 App Server。"));

    type_key(&mut view, KeyCode::Esc);
    type_key(&mut view, KeyCode::Char('q'));
    assert!(type_key(&mut view, KeyCode::Enter));
}
