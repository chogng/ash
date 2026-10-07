use super::*;
use crate::test_support::hook_catalog;
use ash_app_server_protocol::protocol::config::HookMatcherDto;
use crossterm::event::KeyCode;
use crossterm::event::KeyModifiers;

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}
fn press(panel: &mut Panel, key: KeyEvent) -> Outcome {
    panel.handle_key(key, Rect::new(0, 0, 60, 12))
}
fn hook() -> HookConfigDto {
    HookConfigDto {
        id: "user:hook:review".into(),
        event: HookEventDto::PreToolUse,
        matcher: HookMatcherDto {
            tool_names: vec!["exec_command".into()],
        },
        action: HookActionDto::Process {
            program: "review-hook".into(),
            args: vec!["--fast".into()],
        },
        enablement: HookEnablementDto::Enabled,
    }
}
fn panel(hooks: Vec<HookConfigDto>) -> Panel {
    Panel::new(
        hook_catalog(hooks),
        &crate::TuiStartupContext::new("/workspace"),
    )
}
fn focus(panel: &mut Panel, id: &str) {
    assert!(
        panel
            .selection_mut()
            .unwrap()
            .focus_item(&ListSelectionItemId::new(id))
    );
}

#[test]
fn hooks_catalog_shows_all_events_and_counts_without_any_configuration() {
    let panel = panel(vec![]);
    assert_eq!(panel.page().visible_items().len(), 33);
    assert_eq!(panel.page().visible_items()[0].label(), "PreToolUse (0)");
    assert_eq!(
        panel.page().visible_items()[32].label(),
        "MessageDisplay (0)"
    );
    assert_eq!(
        panel.page().selected_item().unwrap().label(),
        "PreToolUse (0)"
    );
}

#[test]
fn hooks_browser_inspects_source_and_arguments_without_mutating_configuration() {
    let mut panel = panel(vec![hook()]);
    assert_eq!(panel.page().visible_items()[0].label(), "PreToolUse (1)");
    press(&mut panel, key(KeyCode::Enter));
    assert_eq!(panel.page().title(), "PreToolUse");
    press(&mut panel, key(KeyCode::Enter));
    assert_eq!(panel.page().title(), "user:hook:review");
    let detail = panel.detail().unwrap().0;
    assert!(
        detail
            .rows()
            .iter()
            .any(|row| row.label() == "Source file" && row.value() == "/profile/config.toml")
    );
    assert!(
        detail
            .rows()
            .iter()
            .any(|row| row.label() == "Arguments" && row.value() == "[\"--fast\"]")
    );
    assert!(
        matches!(press(&mut panel, key(KeyCode::Enter)), Outcome::Edit(path) if path == PathBuf::from("/profile/config.toml"))
    );
    press(&mut panel, key(KeyCode::Esc));
    assert_eq!(panel.page().title(), "PreToolUse");
    press(&mut panel, key(KeyCode::Esc));
    assert_eq!(
        panel.page().selected_item().unwrap().label(),
        "PreToolUse (1)"
    );
    assert!(matches!(
        press(&mut panel, key(KeyCode::Esc)),
        Outcome::Dismiss
    ));
}

#[test]
fn hooks_refresh_updates_counts_and_preserves_search_and_page_history() {
    let mut panel = panel(vec![]);
    press(&mut panel, key(KeyCode::Char('/')));
    panel.handle_paste("PreToolUse".into());
    assert!(!matches!(
        press(&mut panel, key(KeyCode::Char('r'))),
        Outcome::Command(_)
    ));
    press(&mut panel, key(KeyCode::Backspace));
    press(&mut panel, key(KeyCode::Esc));
    panel.update(hook_catalog(vec![hook()]));
    assert_eq!(panel.page().visible_items().len(), 1);
    assert_eq!(panel.page().visible_items()[0].label(), "PreToolUse (1)");
    press(&mut panel, key(KeyCode::Enter));
    press(&mut panel, key(KeyCode::Enter));
    panel.update(hook_catalog(vec![]));
    assert!(panel.page().visible_items().is_empty());
    press(&mut panel, key(KeyCode::Esc));
    assert_eq!(panel.page().title(), "PreToolUse");
    press(&mut panel, key(KeyCode::Esc));
    assert_eq!(panel.page().visible_items()[0].label(), "PreToolUse (0)");
    assert!(matches!(
        press(&mut panel, key(KeyCode::Char('r'))),
        Outcome::Command(Command::Refresh)
    ));
}

#[test]
fn hooks_configuration_routes_user_project_and_assistant_requests() {
    let mut panel = panel(vec![]);
    focus(&mut panel, "hook-event-SessionStart");
    press(&mut panel, key(KeyCode::Enter));
    panel
        .selection_mut()
        .unwrap()
        .focus_pointer(&crate::widgets::list_selection::ListSelectionPointerTarget::Action);
    press(&mut panel, key(KeyCode::Enter));
    assert_eq!(panel.page().title(), "Configure Hooks");
    assert!(
        matches!(press(&mut panel, key(KeyCode::Enter)), Outcome::Edit(path) if path == PathBuf::from("/profile/config.toml"))
    );
    focus(&mut panel, "edit-project-config");
    assert!(
        matches!(press(&mut panel, key(KeyCode::Enter)), Outcome::Edit(path) if path == PathBuf::from("/workspace/.ash/config.toml"))
    );
    focus(&mut panel, "ask-ash");
    press(&mut panel, key(KeyCode::Enter));
    assert_eq!(panel.page().title(), "Choose configuration scope");
    let Outcome::Draft(prompt) = press(&mut panel, key(KeyCode::Enter)) else {
        panic!("expected a draft")
    };
    assert!(prompt.contains("SessionStart"));
    assert!(prompt.contains("/profile/config.toml"));
    assert!(prompt.contains("(user)"));
}

#[test]
fn hooks_localizes_counts_details_and_assistant_draft_in_chinese() {
    let mut panel = panel(vec![hook()]);
    panel.localize(crate::nls::Language::Chinese);
    assert_eq!(panel.page().title(), "扩展");
    assert_eq!(panel.page().visible_items()[0].label(), "PreToolUse (1)");
    press(&mut panel, key(KeyCode::Enter));
    press(&mut panel, key(KeyCode::Enter));
    assert!(
        panel
            .detail()
            .unwrap()
            .0
            .rows()
            .iter()
            .any(|row| row.label() == "来源文件" && row.value() == "/profile/config.toml")
    );
    focus(&mut panel, "ask-ash");
    let Outcome::Draft(prompt) = press(&mut panel, key(KeyCode::Enter)) else {
        panic!("expected a draft")
    };
    assert!(prompt.starts_with("帮我配置"));
    assert!(prompt.contains("PreToolUse"));
}

#[test]
fn hooks_keeps_configured_legacy_events_visible_with_their_original_semantics() {
    let mut hook = hook();
    hook.event = HookEventDto::TurnCompleted;
    let mut panel = panel(vec![hook]);
    assert_eq!(panel.page().visible_items().len(), 34);
    focus(&mut panel, "hook-event-Turn completed");
    press(&mut panel, key(KeyCode::Enter));
    assert_eq!(panel.page().visible_items()[0].label(), "user:hook:review");
}

#[test]
fn remote_hooks_configuration_does_not_open_a_matching_local_path() {
    let mut context = crate::TuiStartupContext::new("/remote/workspace");
    context.connection = crate::TuiConnectionKind::Remote;
    let mut panel = Panel::new(hook_catalog(vec![hook()]), &context);
    panel
        .selection_mut()
        .unwrap()
        .focus_pointer(&crate::widgets::list_selection::ListSelectionPointerTarget::Action);
    press(&mut panel, key(KeyCode::Enter));
    assert!(panel.page().visible_items().iter().all(|row| {
        row.id()
            .map(|id| id == &ListSelectionItemId::new("ask-ash"))
            .unwrap_or(true)
    }));
}

#[test]
fn hooks_project_assistance_resolves_undiscovered_directory_identity() {
    let mut panel = panel(vec![]);
    panel
        .selection_mut()
        .unwrap()
        .focus_pointer(&crate::widgets::list_selection::ListSelectionPointerTarget::Action);
    press(&mut panel, key(KeyCode::Enter));
    focus(&mut panel, "ask-ash");
    press(&mut panel, key(KeyCode::Enter));
    focus(&mut panel, "edit-project-config");
    let Outcome::Draft(prompt) = press(&mut panel, key(KeyCode::Enter)) else {
        panic!("expected draft")
    };
    assert!(prompt.contains("/workspace/.ash/config.toml"));
    assert!(prompt.contains("Resolve the project directory's namespace through App Server"));
    assert!(!prompt.contains("()"));
}

#[test]
fn hooks_long_details_scroll_while_configuration_actions_remain_available() {
    let mut config = hook();
    config.action = HookActionDto::Process {
        program: "program".into(),
        args: vec!["a long argument ".repeat(20)],
    };
    let mut panel = panel(vec![config]);
    press(&mut panel, key(KeyCode::Enter));
    press(&mut panel, key(KeyCode::Enter));
    assert_eq!(panel.detail().unwrap().1, 0);
    press(&mut panel, key(KeyCode::PageDown));
    assert!(panel.detail().unwrap().1 > 0);
    assert!(matches!(
        press(&mut panel, key(KeyCode::Enter)),
        Outcome::Edit(_)
    ));
    press(&mut panel, key(KeyCode::PageUp));
    assert_eq!(panel.detail().unwrap().1, 0);
}
