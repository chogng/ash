use super::*;
use crate::keymap::KeyEvent;
use crossterm::event::KeyCode;
use crossterm::event::KeyModifiers;

#[test]
fn network_panel_ignores_a_superseded_result_and_preserves_domain_names() {
    let (mut panel, first) = Panel::new(Operation::Domains, Language::Chinese);
    let second = panel.begin(Operation::Diagnose);
    panel.complete(
        Reply {
            id: first.id,
            result: Err("stale".into()),
        },
        Language::Chinese,
    );
    assert_eq!(panel.pending.as_ref(), Some(&second.id));
    let report = Report {
        network: NetworkReadResult {
            revision: 0,
            http_mode:
                ash_app_server_protocol::protocol::diagnostics::HttpCompatibilityModeDto::Http2,
            targets: vec![
                ash_app_server_protocol::protocol::diagnostics::NetworkTargetDto {
                    id: "one".into(),
                    connection: "ChatGPT".into(),
                    display_name: "ChatGPT".into(),
                    host: "chatgpt.com".into(),
                    port: 443,
                    purpose: NetworkPurposeDto::Usage,
                    route: NetworkRouteDto::Direct,
                },
            ],
        },
        checks: vec![NetworkCheckDto {
            connection: "ChatGPT".into(),
            target_id: Some("one".into()),
            outcome: NetworkCheckOutcomeDto::Reachable { http_status: 401 },
        }],
    };
    panel.complete(
        Reply {
            id: second.id,
            result: Ok(report),
        },
        Language::Chinese,
    );
    assert!(panel.pending.is_none());
    panel.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    assert!(
        matches!(panel.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)), super::super::ConfigEditorOutcome::Action(ConfigSelectionAction::CopyRequiredDomains(text)) if text == "chatgpt.com")
    );
}
