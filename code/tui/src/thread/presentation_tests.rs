use super::present_turn_error;
use super::recover_active_turn;
use ash_protocol::StableTurnError;
use ash_protocol::ThreadItem;
use ash_protocol::Turn;
use ash_protocol::TurnId;
use ash_protocol::TurnStatus;

#[test]
fn recovery_selects_the_oldest_nonterminal_turn_for_a_serial_queue() {
    let turns = vec![
        turn("completed", TurnStatus::Completed),
        turn("waiting", TurnStatus::WaitingForApproval),
        turn("running", TurnStatus::Running),
    ];

    assert_eq!(recover_active_turn(&turns).unwrap().as_str(), "waiting");
}

#[test]
fn recovery_does_not_reopen_terminal_turns() {
    let turns = vec![
        turn("completed", TurnStatus::Completed),
        turn("failed", TurnStatus::Failed),
        turn("interrupted", TurnStatus::Interrupted),
    ];

    assert_eq!(recover_active_turn(&turns), None);
}

#[test]
fn every_stable_turn_error_has_a_user_facing_message() {
    let errors = [
        StableTurnError::model_invocation_failed(),
        StableTurnError::context_overflow(),
        StableTurnError::provider_auth(),
        StableTurnError::invalid_request(),
        StableTurnError::invalid_response(),
        StableTurnError::completion_persistence_failed(),
        StableTurnError::interaction_deadline_elapsed(),
        StableTurnError::tool_repetition(),
        StableTurnError::usage_limited(),
    ];

    for error in errors {
        let message = present_turn_error(&error);
        assert!(!message.trim().is_empty());
        assert!(!message.contains(&format!("{:?}", error.code)));
    }
}

fn turn(id: &str, status: TurnStatus) -> Turn {
    Turn {
        advisor: None,
        turn_id: TurnId::new(id).unwrap(),
        status,
        kind: Default::default(),
        instructions: None,
        model: None,
        tool_profile: None,
        tool_mode: ash_protocol::ToolMode::Direct,
        approval_mode: ash_protocol::ApprovalMode::AskPermissions,
        usage: ash_protocol::ModelUsageSummary::default(),
        context_usage: None,
        items: Vec::<ThreadItem>::new(),
        plan: None,
        pending_interaction: None,
        error: (status == TurnStatus::Failed).then(StableTurnError::model_invocation_failed),
    }
}

#[test]
fn configuration_errors_offer_config_and_request_errors_show_the_cause() {
    for (error, expected) in [
        (
            StableTurnError::model_configuration(),
            "Check your provider and model configuration in /config.",
        ),
        (
            StableTurnError::provider_credentials(),
            "Credentials unavailable. Check your provider credentials in /config.",
        ),
        (
            StableTurnError::provider_http(401),
            "Authentication failed (401). Check your provider credentials in /config.",
        ),
        (
            StableTurnError::rate_limited(),
            "Too many requests (429). Try again later.",
        ),
        (
            StableTurnError::provider_http(500),
            "Provider request failed (500). Try again later.",
        ),
        (
            StableTurnError::connection_failed(),
            "Could not connect to the provider. Check your network and service address.",
        ),
    ] {
        assert_eq!(present_turn_error(&error), expected);
    }
}
