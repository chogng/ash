use super::automatic_recap_model;
use crate::model_catalog::short_text_reasoning_effort;
use ash_app_server_protocol::protocol::model::ModelCatalogEntry;
use ash_protocol::ModelId;
use ash_protocol::ModelInfo;
use ash_protocol::ModelPurpose;
use ash_protocol::ModelRef;
use ash_protocol::ProviderId;
use ash_protocol::ReasoningEffort;

fn entry(provider: &str, name: &str, recommended: bool) -> ModelCatalogEntry {
    let model = ModelRef::new(
        ProviderId::new(provider).unwrap(),
        ModelId::new(name).unwrap(),
    );
    let mut info = ModelInfo::new(model.model.clone(), name);
    if recommended {
        info.recommended_for.push(ModelPurpose::ThreadRecap);
    }
    ModelCatalogEntry::from_info(model, &info)
}

#[test]
fn recap_effort_uses_the_explicit_choice_or_a_supported_low_cost_level() {
    let mut model = entry("openai", "gpt-6-luna", true);
    model.supported_reasoning_efforts = [ReasoningEffort::Low, ReasoningEffort::High]
        .into_iter()
        .map(Into::into)
        .collect();

    assert_eq!(
        short_text_reasoning_effort(Some(&model), Some(ReasoningEffort::High)),
        Some(ReasoningEffort::High)
    );
    assert_eq!(
        short_text_reasoning_effort(Some(&model), None),
        Some(ReasoningEffort::Low)
    );
    assert_eq!(
        short_text_reasoning_effort(Some(&model), Some(ReasoningEffort::Max)),
        Some(ReasoningEffort::Low)
    );
}

#[test]
fn recap_automatic_prefers_luna_and_stays_on_the_conversation_provider() {
    let claude = entry("anthropic", "haiku", true);
    let previous_luna = entry("openai", "gpt-5.6-luna", true);
    let luna = entry("openai", "gpt-6-luna", true);
    let sol = entry("openai", "gpt-6.1-sol", false);
    let entries = [
        claude.clone(),
        previous_luna.clone(),
        luna.clone(),
        sol.clone(),
    ];
    assert_eq!(
        automatic_recap_model(&entries, &sol.model, |_| true),
        Some(&luna.model)
    );
    assert_eq!(
        automatic_recap_model(&entries, &sol.model, |model| model != &luna.model),
        Some(&previous_luna.model)
    );
    assert_eq!(
        automatic_recap_model(&entries, &claude.model, |_| true),
        Some(&claude.model)
    );
    assert_eq!(
        automatic_recap_model(&entries, &sol.model, |model| model == &sol.model
            || model == &claude.model),
        None
    );
}

#[test]
fn shared_recap_presence_waits_for_every_view_and_restarts_after_a_turn() {
    use super::RecapPresence;
    use super::RecapTurnChange;
    use ash_protocol::ThreadId;
    use std::sync::{Arc, Weak};

    let presence = Arc::new(RecapPresence::default());
    let thread = ThreadId::new("conversation").unwrap();
    let report = |connection, surface: &str, focused| {
        presence.set(
            Weak::new(),
            thread.clone(),
            connection,
            surface.into(),
            focused,
        );
    };
    let job = || presence.watches.lock().unwrap()[&thread].job.clone();

    report(1, "ide", Some(true));
    report(2, "agents", Some(true));
    report(1, "ide", Some(false));
    assert!(job().is_none());
    presence.close_connection(2);
    let first = job().unwrap();
    report(1, "ide", Some(false));
    assert_eq!(job().unwrap().id(), first.id());
    presence.turn_changed(&thread, 4, RecapTurnChange::Started);
    assert!(first.token().is_cancelled());
    assert!(job().is_none());
    presence.turn_changed(&thread, 6, RecapTurnChange::Finished);
    presence.turn_changed(&thread, 4, RecapTurnChange::Started);
    let after_turn = job().unwrap();
    report(3, "agents", Some(true));
    assert!(after_turn.token().is_cancelled());
    assert!(job().is_none());
    report(3, "agents", None);
    assert!(job().is_some());
    presence.turn_changed(&thread, 8, RecapTurnChange::Started);
}
