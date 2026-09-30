use super::Command;
use super::Outcome;
use super::PageView;
use super::Panel;
use crate::widgets::list_selection::ListSelectionItemId;
use ash_app_server_protocol::protocol::config::HookActionDto;
use ash_app_server_protocol::protocol::config::HookConfigDto;
use ash_app_server_protocol::protocol::config::HookEnablementDto;
use ash_app_server_protocol::protocol::config::HookEventDto;
use ash_app_server_protocol::protocol::config::HookMatcherDto;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use std::collections::BTreeMap;

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

fn hook() -> HookConfigDto {
    HookConfigDto {
        id: "review".into(),
        event: HookEventDto::AfterTool,
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

#[test]
fn hooks_panel_opens_details_toggles_and_edits() {
    let hooks = BTreeMap::from([("review".into(), hook())]);
    let mut panel = Panel::new(hooks);
    let PageView::Selection(root) = panel.page() else {
        panic!("expected Hooks list")
    };
    assert_eq!(root.title(), "Extensions");
    assert_eq!(root.visible_items()[0].label(), "review");

    panel
        .selection_mut()
        .unwrap()
        .focus_item(&ListSelectionItemId::new("review"));
    assert!(matches!(
        panel.handle_key(key(KeyCode::Enter)),
        Outcome::Consumed
    ));
    let PageView::Selection(detail) = panel.page() else {
        panic!("expected Hook details")
    };
    assert_eq!(detail.title(), "review");

    let result = panel.handle_key(key(KeyCode::Enter));
    assert!(
        matches!(result, Outcome::Command(Command::SetEnablement(id, HookEnablementDto::Disabled)) if id == "review")
    );
    panel
        .selection_mut()
        .unwrap()
        .focus_item(&ListSelectionItemId::new("hook-action-1"));
    assert!(matches!(
        panel.handle_key(key(KeyCode::Enter)),
        Outcome::Consumed
    ));
    let PageView::Selection(editor) = panel.page() else {
        panic!("expected Hook editor")
    };
    assert_eq!(editor.title(), "Edit Hook");
    panel.handle_key(key(KeyCode::Enter));
    let PageView::Selection(events) = panel.page() else {
        panic!("expected Hook event picker")
    };
    assert_eq!(events.title(), "Hook events");
    assert_eq!(events.visible_items().len(), 33);
    panel
        .selection_mut()
        .unwrap()
        .focus_item(&ListSelectionItemId::new("hook-event-5"));
    panel.handle_key(key(KeyCode::Enter));
    panel
        .selection_mut()
        .unwrap()
        .focus_item(&ListSelectionItemId::new("hook-action-4"));
    assert!(matches!(
        panel.handle_key(key(KeyCode::Enter)),
        Outcome::Command(Command::Upsert(hook))
            if hook.event == HookEventDto::Notification && hook.matcher.tool_names.is_empty()
    ));
}

#[test]
fn deleting_a_hook_requires_confirmation() {
    let hooks = BTreeMap::from([("review".into(), hook())]);
    let mut panel = Panel::new(hooks);
    panel
        .selection_mut()
        .unwrap()
        .focus_item(&ListSelectionItemId::new("review"));
    panel.handle_key(key(KeyCode::Enter));
    panel
        .selection_mut()
        .unwrap()
        .focus_item(&ListSelectionItemId::new("hook-action-2"));
    assert!(matches!(
        panel.handle_key(key(KeyCode::Enter)),
        Outcome::Consumed
    ));
    let PageView::Selection(confirm) = panel.page() else {
        panic!("expected delete confirmation")
    };
    assert_eq!(confirm.title(), "Delete Hook?");
    panel
        .selection_mut()
        .unwrap()
        .focus_item(&ListSelectionItemId::new("hook-action-1"));
    assert!(
        matches!(panel.handle_key(key(KeyCode::Enter)), Outcome::Command(Command::Remove(id)) if id == "review")
    );
}

#[test]
fn hooks_panel_localizes_titles_and_status_in_chinese() {
    let hooks = BTreeMap::from([("review".into(), hook())]);
    let mut panel = Panel::new(hooks);
    panel.localize(crate::nls::Language::Chinese);
    let PageView::Selection(root) = panel.page() else {
        panic!("expected Hooks list");
    };
    assert_eq!(root.title(), "扩展");
    assert_eq!(
        root.visible_items()[0].description(),
        Some("工具执行后  ·  已启用")
    );
    assert_eq!(
        crate::nls::localize(crate::nls::Language::Chinese, "browse and manage Hooks"),
        "浏览和管理钩子"
    );
    panel
        .selection_mut()
        .unwrap()
        .focus_item(&ListSelectionItemId::new("review"));
    panel.handle_key(key(KeyCode::Enter));
    panel
        .selection_mut()
        .unwrap()
        .focus_item(&ListSelectionItemId::new("hook-action-1"));
    panel.handle_key(key(KeyCode::Enter));
    panel
        .selection_mut()
        .unwrap()
        .focus_item(&ListSelectionItemId::new("hook-action-2"));
    panel.handle_key(key(KeyCode::Enter));
    let PageView::Prompt(prompt) = panel.page() else {
        panic!("expected program prompt")
    };
    assert_eq!(prompt.input().placeholder(), "程序");
}

#[test]
fn hooks_editor_builds_new_hook_and_requires_program() {
    let mut panel = Panel::new(BTreeMap::new());
    assert!(matches!(
        panel.handle_key(key(KeyCode::Enter)),
        Outcome::Consumed
    ));

    panel
        .selection_mut()
        .unwrap()
        .focus_item(&ListSelectionItemId::new("hook-action-0"));
    panel.handle_key(key(KeyCode::Enter));
    let PageView::Prompt(prompt) = panel.page() else {
        panic!("expected Hook ID prompt")
    };
    assert_eq!(prompt.title(), "Hook ID");
    for character in "review".chars() {
        panel.handle_key(key(KeyCode::Char(character)));
    }
    panel.handle_key(key(KeyCode::Enter));

    panel
        .selection_mut()
        .unwrap()
        .focus_item(&ListSelectionItemId::new("hook-action-5"));
    assert!(matches!(
        panel.handle_key(key(KeyCode::Enter)),
        Outcome::Consumed
    ));
    panel
        .selection_mut()
        .unwrap()
        .focus_item(&ListSelectionItemId::new("hook-action-3"));
    panel.handle_key(key(KeyCode::Enter));
    for character in "review-hook".chars() {
        panel.handle_key(key(KeyCode::Char(character)));
    }
    panel.handle_key(key(KeyCode::Enter));
    panel
        .selection_mut()
        .unwrap()
        .focus_item(&ListSelectionItemId::new("hook-action-5"));
    let Outcome::Command(Command::Upsert(saved)) = panel.handle_key(key(KeyCode::Enter)) else {
        panic!("expected Hook upsert");
    };
    assert_eq!(saved.id, "user:hook:review");
    assert_eq!(saved.enablement, HookEnablementDto::Disabled);
    assert!(
        matches!(&saved.action, HookActionDto::Process { program, .. } if program == "review-hook")
    );
    let PageView::Selection(editor) = panel.page() else {
        panic!("draft should remain until save completes")
    };
    assert_eq!(editor.title(), "Add Hook");
    panel.update(BTreeMap::from([(saved.id.clone(), saved)]));
    let PageView::Selection(detail) = panel.page() else {
        panic!("expected saved Hook details")
    };
    assert_eq!(detail.title(), "user:hook:review");
}
