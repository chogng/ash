use super::*;
use ash_protocol::ProjectId;

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}
fn panel() -> Panel {
    let scopes = [
        MemoryScope::Profile,
        MemoryScope::Project {
            project_id: ProjectId::new("ash").unwrap(),
        },
    ]
    .into_iter()
    .map(|scope| MemoryScopeDescriptor {
        label: scope.storage_key(),
        policy: memories::MemoryPolicy::disabled(scope),
    })
    .collect();
    Panel::new(Page::Scopes {
        enabled: true,
        scopes,
        list: listing(0..30),
    })
}
fn listing(range: std::ops::Range<usize>) -> Listing {
    Listing {
        scope: MemoryScope::Profile,
        query: String::new(),
        revision: 1,
        entries: range
            .map(|i| Entry {
                id: memories::MemoryId::new(format!("entry-{i}")).unwrap(),
                title: format!("Decision {i}"),
                source: memories::MemorySource::User,
                updated: 0,
                excerpt: String::new(),
            })
            .collect(),
        cursor: Some("next".into()),
    }
}
fn command(outcome: ListSelectionOutcome<Command>) -> Command {
    match outcome {
        ListSelectionOutcome::Activate(command) => command,
        _ => panic!("expected command"),
    }
}
fn memory() -> Memory {
    Memory {
        memory_id: memories::MemoryId::new("entry-0").unwrap(),
        scope: MemoryScope::Profile,
        revision: 1,
        title: "Decision 0".into(),
        body: "Use Rust\n保留  两个空格".into(),
        source: memories::MemorySource::Model {
            session_id: ash_protocol::SessionId::new("s").unwrap(),
            thread_id: ash_protocol::ThreadId::new("t").unwrap(),
            turn_id: ash_protocol::TurnId::new("turn").unwrap(),
        },
        created_at_unix_ms: 0,
        updated_at_unix_ms: 0,
    }
}
#[test]
fn tabs_move_focus_and_load_the_selected_scope_without_losing_drafts() {
    let mut panel = panel();
    panel.handle_key(key(KeyCode::Tab));
    assert!(panel.selection.state().tabs_focused());
    assert_eq!(panel.selection.state().active_tab_index(), 1);
    assert!(matches!(
        panel.take_refresh(),
        Some(Command::Browse {
            scope: MemoryScope::Project { .. },
            ..
        })
    ));
}
#[test]
fn search_uses_the_server_and_pagination_appends_results() {
    let mut panel = panel();
    panel.handle_key(key(KeyCode::Char('/')));
    panel.paste("Rust".into());
    assert_eq!(panel.selection.state().visible_items().len(), 31);
    let first = command(panel.handle_key(key(KeyCode::Enter)));
    assert!(matches!(&first, Command::Browse { query, cursor: None, .. } if query == "Rust"));
    let mut list = listing(0..20);
    list.query = "Rust".into();
    panel.finish(first, Ok(Page::List(list)));
    let next = command(panel.activate(Action::More));
    assert!(
        matches!(&next, Command::Browse { query, cursor: Some(cursor), .. } if query == "Rust" && cursor == "next")
    );
    let mut list = listing(20..60);
    list.query = "Rust".into();
    list.cursor = None;
    panel.finish(next, Ok(Page::List(list)));
    assert_eq!(panel.listing().unwrap().entries.len(), 60);
    assert!(panel.listing().unwrap().cursor.is_none());
}
#[test]
fn failed_saves_keep_both_fields_and_retry_only_identical_commands() {
    let mut panel = panel();
    panel.handle_key(key(KeyCode::Char('n')));
    panel.paste("Decision".into());
    panel.handle_key(key(KeyCode::Tab));
    panel.paste("body\n内容".into());
    let save = command(panel.handle_key(KeyEvent::new(KeyCode::Char('s'), KeyModifiers::CONTROL)));
    panel.finish(
        save.clone(),
        Err(Failure {
            code: None,
            message: "Offline".into(),
        }),
    );
    assert_eq!(
        panel.editor.as_ref().unwrap().values(),
        ("Decision", "body\n内容")
    );
    let retry = command(panel.handle_key(KeyEvent::new(KeyCode::Char('s'), KeyModifiers::CONTROL)));
    assert_eq!(save, retry);
    panel.finish(
        retry,
        Err(Failure {
            code: None,
            message: "Offline".into(),
        }),
    );
    panel.paste(" changed".into());
    let changed =
        command(panel.handle_key(KeyEvent::new(KeyCode::Char('s'), KeyModifiers::CONTROL)));
    let (
        Command::Add {
            command_id: first, ..
        },
        Command::Add {
            command_id: second, ..
        },
    ) = (save, changed)
    else {
        panic!("add commands");
    };
    assert_ne!(first, second);
}
#[test]
fn dirty_close_requires_discard_and_late_results_cannot_replace_the_panel() {
    let mut panel = panel();
    panel.handle_key(key(KeyCode::Char('n')));
    panel.paste("draft".into());
    assert!(!panel.close());
    panel.handle_key(key(KeyCode::Esc));
    assert!(panel.editor.is_some());
    panel.finish(
        Command::Read {
            scope: MemoryScope::Profile,
            id: memory().memory_id,
        },
        Ok(Page::Read(memory())),
    );
    assert!(panel.detail.is_none());
    panel.handle_key(key(KeyCode::Esc));
    panel.handle_key(key(KeyCode::Down));
    panel.handle_key(key(KeyCode::Enter));
    assert!(panel.editor.is_none());
}
#[test]
fn conflicts_require_review_of_the_latest_revision_and_keep_the_draft() {
    let mut panel = panel();
    let read = command(panel.handle_key(key(KeyCode::Enter)));
    panel.finish(read, Ok(Page::Read(memory())));
    panel.handle_key(key(KeyCode::Char('e')));
    panel.handle_key(key(KeyCode::Tab));
    panel.paste(" draft".into());
    let save = command(panel.handle_key(KeyEvent::new(KeyCode::Char('s'), KeyModifiers::CONTROL)));
    panel.finish(
        save,
        Err(Failure {
            code: Some(-32133),
            message: "Changed".into(),
        }),
    );
    assert!(matches!(
        panel.handle_key(KeyEvent::new(KeyCode::Char('s'), KeyModifiers::CONTROL)),
        ListSelectionOutcome::Consumed
    ));
    let read = command(panel.handle_key(KeyEvent::new(KeyCode::Char('r'), KeyModifiers::CONTROL)));
    let mut latest = memory();
    latest.revision = 2;
    latest.body = "external change".into();
    panel.finish(read, Ok(Page::Read(latest)));
    assert!(panel.showing_latest);
    panel.handle_key(key(KeyCode::Char('u')));
    let save = command(panel.handle_key(KeyEvent::new(KeyCode::Char('s'), KeyModifiers::CONTROL)));
    assert!(
        matches!(save, Command::Update { memory, body, .. } if memory.revision == 2 && body.ends_with(" draft"))
    );
}
#[test]
fn wheel_scroll_preserves_keyboard_selection_and_hit_testing_uses_the_viewport() {
    let mut panel = panel();
    let selected = panel
        .selection
        .state()
        .selected_item()
        .unwrap()
        .id()
        .cloned();
    let area = Rect::new(2, 2, 72, 15);
    panel.scroll(area, Position::new(10, 10), 12);
    assert_eq!(
        panel.selection.state().selected_item().unwrap().id(),
        selected.as_ref()
    );
    let target = panel
        .target_at(Rect::default(), area, Position::new(10, 8))
        .unwrap();
    let Target::List(ListSelectionPointerTarget::Item(id)) = target else {
        panic!("visible row");
    };
    assert_ne!(Some(id), selected);
}

#[test]
fn refresh_preserves_identity_and_loaded_count_and_stale_pages_keep_the_list() {
    let mut panel = panel();
    let id = item_id(
        &MemoryScope::Profile,
        &memories::MemoryId::new("entry-25").unwrap(),
    );
    panel.selection.state_mut().focus_item(&id);
    let refresh = command(panel.handle_key(key(KeyCode::Char('r'))));
    assert!(matches!(refresh, Command::Browse { loaded: 30, .. }));
    panel.finish(refresh, Ok(Page::List(listing(1..31))));
    assert_eq!(
        panel.selection.state().selected_item().unwrap().id(),
        Some(&id)
    );
    let more = command(panel.activate(Action::More));
    panel.finish(
        more,
        Err(Failure {
            code: Some(-32134),
            message: "Refresh to continue".into(),
        }),
    );
    assert_eq!(panel.listing().unwrap().entries.len(), 30);
    assert_eq!(
        panel.selection.state().selected_item().unwrap().id(),
        Some(&id)
    );
    panel.changed(MemoryChanged {
        scope: MemoryScope::Profile,
        catalog_revision: 1,
    });
    assert!(panel.take_refresh().is_none());
    panel.changed(MemoryChanged {
        scope: MemoryScope::Profile,
        catalog_revision: 2,
    });
    assert!(panel.take_refresh().is_some());
}

#[test]
fn delete_and_policy_retries_reuse_the_same_command() {
    let mut panel = panel();
    panel.detail = Some(memory());
    for action in [Action::Delete, Action::ReadPolicy] {
        let first = command(panel.activate(action.clone()));
        panel.finish(
            first.clone(),
            Err(Failure {
                code: None,
                message: "Offline".into(),
            }),
        );
        let retry = command(panel.activate(action));
        assert_eq!(retry, first);
        panel.finish(
            retry,
            Err(Failure {
                code: None,
                message: "Offline".into(),
            }),
        );
    }
    let reload = command(panel.activate(Action::ReloadPolicy));
    assert!(matches!(reload, Command::ReadPolicy(MemoryScope::Profile)));
    let mut policy = memories::MemoryPolicy::disabled(MemoryScope::Profile);
    policy.revision = 2;
    panel.finish(reload, Ok(Page::Policy(policy)));
    let update = command(panel.activate(Action::WritePolicy));
    assert!(
        matches!(update, Command::Policy { policy, .. } if policy.revision == 2 && policy.model_write == memories::MemoryWriteMode::Enabled)
    );
}

#[test]
fn editor_fields_hit_the_full_row_and_show_pointer_feedback_without_moving_focus() {
    let mut panel = panel();
    panel.handle_key(key(KeyCode::Char('n')));
    let area = Rect::new(4, 2, 70, 18);
    let content = Panel::content_area(area);
    let body_label_y = content.y + 3;
    let target = Target::Field(Field::Body);
    for x in [area.x - 2, area.x, area.right() - 1] {
        assert_eq!(
            panel.target_at(Rect::default(), area, Position::new(x, body_label_y)),
            Some(target.clone())
        );
    }
    let context = crate::render::test_context();
    for pressed in [None, Some(&target)] {
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(80, 24)).unwrap();
        terminal
            .draw(|frame| panel.draw(frame, area, Some(&target), pressed, context))
            .unwrap();
        let cell = &terminal.backend().buffer()[(area.x, body_label_y)];
        assert_eq!(
            cell.fg,
            if pressed.is_some() {
                context.pressed_foreground()
            } else {
                context.hover_foreground()
            }
        );
        assert_eq!(panel.editor.as_ref().unwrap().field, Field::Title);
    }
    panel.click(&target, ListSelectionClick::Single);
    assert_eq!(panel.editor.as_ref().unwrap().field, Field::Body);
}
