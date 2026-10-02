use super::ModelSummary;
use ash_app_server_protocol::protocol::config::ModelRefDto;
use ash_app_server_protocol::protocol::model::ModelCatalogEntry;
use ash_app_server_protocol::protocol::model::ModelListResult;
use ash_protocol::ModelAccess;
use ash_protocol::ModelCapabilities;
use ash_protocol::ModelId;
use ash_protocol::ModelRef;
use ash_protocol::ProviderId;
use ash_protocol::ReasoningEffort;

#[test]
fn model_summary_resolves_the_selected_models_access_path() {
    let model = ModelRefDto {
        provider: "openai".into(),
        model: "gpt-5.6".into(),
    };
    let mut selected = entry("openai", "gpt-5.6", ModelAccess::Subscription);
    selected.display_name = "GPT-5.6".into();
    selected.model_reasoning_effort = Some(ReasoningEffort::High);
    let catalog = ModelListResult {
        models: vec![selected],
    };

    let summary = ModelSummary::from_catalog(Some(model), None, Some(&catalog));

    assert_eq!(summary.model_label(), "openai/gpt-5.6");
    assert_eq!(summary.model_and_effort_label(), "GPT-5.6 (high)");
}

#[test]
fn missing_or_automatic_models_are_reported_without_guessing_access() {
    let configured = ModelSummary::from_catalog(
        Some(ModelRefDto {
            provider: "custom".into(),
            model: "unknown".into(),
        }),
        None,
        None,
    );
    let automatic = ModelSummary::from_catalog(None, None, None);

    assert_eq!(automatic.model_label(), "Automatic model");
    assert_eq!(configured.model_and_effort_label(), "unknown");
    assert_eq!(automatic.model_and_effort_label(), "Automatic model");
}

#[test]
fn model_reasoning_effort_overrides_catalog_value() {
    let model = ModelRefDto {
        provider: "openai".into(),
        model: "gpt-5.6".into(),
    };
    let mut selected = entry("openai", "gpt-5.6", ModelAccess::Subscription);
    selected.display_name = "GPT-5.6".into();
    selected.model_reasoning_effort = Some(ReasoningEffort::Medium);
    let catalog = ModelListResult {
        models: vec![selected],
    };

    let summary =
        ModelSummary::from_catalog(Some(model), Some(ReasoningEffort::High), Some(&catalog));

    assert_eq!(summary.model_and_effort_label(), "GPT-5.6 (high)");
    assert_eq!(
        summary.model_reasoning_effort(),
        Some(ReasoningEffort::High)
    );
}

fn entry(provider: &str, model: &str, _access: ModelAccess) -> ModelCatalogEntry {
    ModelCatalogEntry {
        discovered: None,
        model: ModelRef::new(
            ProviderId::new(provider).unwrap(),
            ModelId::new(model).unwrap(),
        ),
        display_name: model.into(),
        context_window: None,
        maximum_context_window: None,
        auto_compact_token_limit: None,
        available_context_window: None,
        capabilities: ModelCapabilities::UNKNOWN,
        supported_reasoning_efforts: Vec::new(),
        model_reasoning_effort: None,
        default_personality: None,
    }
}

#[test]
fn context_capacity_comes_only_from_the_matching_catalog_entry() {
    let mut selected = entry("provider", "model", ModelAccess::ApiKey);
    selected.available_context_window = Some(90_000);
    let catalog = ModelListResult {
        models: vec![selected],
    };
    let summary = ModelSummary::from_catalog(
        Some(ModelRefDto {
            provider: "provider".into(),
            model: "model".into(),
        }),
        None,
        Some(&catalog),
    );
    assert_eq!(summary.context_capacity(), Some(90_000));
    let other = ModelSummary::from_catalog(
        Some(ModelRefDto {
            provider: "provider".into(),
            model: "other".into(),
        }),
        None,
        Some(&catalog),
    );
    assert_eq!(other.context_capacity(), None);
}

#[derive(Clone)]
struct ConfigTransport {
    state: std::sync::Arc<
        std::sync::Mutex<(
            ash_app_server_protocol::protocol::config::ConfigReadResult,
            Vec<ash_app_server_protocol::protocol::config::ConfigUpdateParams>,
        )>,
    >,
}

impl ash_app_server_client::JsonRpcTransport for ConfigTransport {
    fn round_trip(&mut self, request: &str) -> Result<String, ash_app_server_client::ClientError> {
        use ash_app_server_protocol::protocol::config::ConfigCommandDispositionDto;
        use ash_app_server_protocol::protocol::config::ConfigCommandResult;
        use ash_app_server_protocol::protocol::config::ConfigUpdateParams;
        let request: serde_json::Value = serde_json::from_str(request).unwrap();
        let mut state = self.state.lock().unwrap();
        let result = match request["method"].as_str().unwrap() {
            "config/read" => serde_json::to_value(&state.0).unwrap(),
            "config/update" => {
                let params: ConfigUpdateParams =
                    serde_json::from_value(request["params"].clone()).unwrap();
                assert_eq!(params.expected_revision, state.0.revision);
                assert!(matches!(params.model, ash_protocol::Patch::Missing));
                assert!(matches!(params.tui, ash_protocol::Patch::Missing));
                assert!(matches!(
                    params.approval_review_model,
                    ash_protocol::Patch::Missing
                ));
                assert!(matches!(params.tool_mode, ash_protocol::Patch::Missing));
                let ash_protocol::Patch::Value(effort) = params.model_reasoning_effort else {
                    panic!("expected an effort patch")
                };
                state.0.model_reasoning_effort = Some(effort);
                state.0.revision += 1;
                state.1.push(params);
                serde_json::to_value(ConfigCommandResult {
                    revision: state.0.revision,
                    generation: state.0.generation,
                    disposition: ConfigCommandDispositionDto::Updated,
                })
                .unwrap()
            }
            method => panic!("unexpected method: {method}"),
        };
        Ok(serde_json::json!({"jsonrpc":"2.0","id":request["id"],"result":result}).to_string())
    }
}

#[test]
fn collaboration_effort_steps_use_supported_values_and_stop_at_boundaries() {
    let mut selected = entry("openai", "test-model", ModelAccess::ApiKey);
    selected.supported_reasoning_efforts = vec![
        ReasoningEffort::Low,
        ReasoningEffort::High,
        ReasoningEffort::Max,
    ];
    selected.model_reasoning_effort = Some(ReasoningEffort::High);
    let catalog = ModelListResult {
        models: vec![selected],
    };
    let mut config = crate::test_support::empty_config_snapshot();
    let model = ModelRefDto {
        provider: "openai".into(),
        model: "test-model".into(),
    };
    config.model = Some(model.clone());
    let transport = ConfigTransport {
        state: std::sync::Arc::new(std::sync::Mutex::new((config, vec![]))),
    };
    let mut client = ash_app_server_client::AppServerClient::new(transport.clone());
    for (command, expected, boundary, writes) in [
        (
            super::Command::IncreaseEffort,
            ReasoningEffort::Max,
            None,
            1,
        ),
        (
            super::Command::IncreaseEffort,
            ReasoningEffort::Max,
            Some("highest"),
            1,
        ),
        (
            super::Command::DecreaseEffort,
            ReasoningEffort::High,
            None,
            2,
        ),
        (
            super::Command::DecreaseEffort,
            ReasoningEffort::Low,
            None,
            3,
        ),
        (
            super::Command::DecreaseEffort,
            ReasoningEffort::Low,
            Some("lowest"),
            3,
        ),
        (
            super::Command::IncreaseEffort,
            ReasoningEffort::High,
            None,
            4,
        ),
    ] {
        let update = super::execute(&mut client, command, &catalog).unwrap();
        assert_eq!(update.summary.model(), Some(&model));
        assert_eq!(update.summary.model_reasoning_effort(), Some(expected));
        assert_eq!(update.config.model_reasoning_effort, Some(expected));
        if let Some(boundary) = boundary {
            let super::ModelNotice::ThinkingEffort(notice) = update.notice else {
                panic!("effort boundaries must use composer notices")
            };
            assert!(notice.contains(boundary));
        } else {
            assert!(matches!(update.notice, super::ModelNotice::Silent));
        }
        assert_eq!(transport.state.lock().unwrap().1.len(), writes);
    }
    assert!(
        super::execute(
            &mut client,
            super::Command::SetEffort {
                effort: ReasoningEffort::Medium
            },
            &catalog
        )
        .is_err()
    );
    assert_eq!(transport.state.lock().unwrap().1.len(), 4);
    transport.state.lock().unwrap().0.model_reasoning_effort = Some(ReasoningEffort::Medium);
    for command in [
        super::Command::DecreaseEffort,
        super::Command::IncreaseEffort,
    ] {
        assert!(super::execute(&mut client, command, &catalog).is_err());
    }
    assert_eq!(transport.state.lock().unwrap().1.len(), 4);
    let update = super::execute(
        &mut client,
        super::Command::SetEffort {
            effort: ReasoningEffort::Low,
        },
        &catalog,
    )
    .unwrap();
    assert_eq!(
        update.summary.model_reasoning_effort(),
        Some(ReasoningEffort::Low)
    );
    assert!(matches!(update.notice, super::ModelNotice::Silent));
    let choices = super::reasoning_effort::choices(&update.config, &catalog).unwrap();
    let selection = crate::widgets::list_selection::ListSelectionState::new(choices.model);
    assert_eq!(selection.selected_visible_index(), Some(0));
    assert_eq!(selection.visible_items().len(), 3);
}

#[test]
fn collaboration_effort_without_a_default_initializes_the_first_supported_level() {
    for command in [
        super::Command::DecreaseEffort,
        super::Command::IncreaseEffort,
    ] {
        let mut selected = entry("openai", "test-model", ModelAccess::ApiKey);
        selected.supported_reasoning_efforts = vec![ReasoningEffort::Low];
        let catalog = ModelListResult {
            models: vec![selected],
        };
        let mut config = crate::test_support::empty_config_snapshot();
        config.model = Some(ModelRefDto {
            provider: "openai".into(),
            model: "test-model".into(),
        });
        let transport = ConfigTransport {
            state: std::sync::Arc::new(std::sync::Mutex::new((config, vec![]))),
        };
        let mut client = ash_app_server_client::AppServerClient::new(transport.clone());
        let update = super::execute(&mut client, command.clone(), &catalog).unwrap();
        assert_eq!(
            update.config.model_reasoning_effort,
            Some(ReasoningEffort::Low)
        );
        assert_eq!(transport.state.lock().unwrap().1.len(), 1);
        let update = super::execute(&mut client, command, &catalog).unwrap();
        assert_eq!(
            update.config.model_reasoning_effort,
            Some(ReasoningEffort::Low)
        );
        assert_eq!(transport.state.lock().unwrap().1.len(), 1);
    }
}

#[test]
fn collaboration_effort_unsupported_models_do_not_write_config() {
    for has_model in [false, true] {
        let mut config = crate::test_support::empty_config_snapshot();
        config.model = has_model.then(|| ModelRefDto {
            provider: "custom".into(),
            model: "model".into(),
        });
        let catalog = ModelListResult {
            models: vec![entry("custom", "model", ModelAccess::ApiKey)],
        };
        let transport = ConfigTransport {
            state: std::sync::Arc::new(std::sync::Mutex::new((config, vec![]))),
        };
        let mut client = ash_app_server_client::AppServerClient::new(transport.clone());
        for command in [
            super::Command::DecreaseEffort,
            super::Command::IncreaseEffort,
        ] {
            let error = super::execute(&mut client, command, &catalog).unwrap_err();
            assert!(
                error.contains(if has_model {
                    "does not support"
                } else {
                    "Select a model"
                }),
                "{error}"
            );
        }
        assert!(transport.state.lock().unwrap().1.is_empty());
    }
}

#[test]
fn reasoning_effort_uses_each_provider_and_models_catalog_levels_and_order() {
    use crate::thread::composer::options::ComposerOption;
    use crate::widgets::list_selection::ListSelectionItemId;

    // The same model ID across providers and another model within one provider must not
    // share effort capabilities. The unusual order also catches a global enum ordering.
    let cases = [
        (
            "provider-a",
            "shared-model",
            vec![ReasoningEffort::Low, ReasoningEffort::High],
            ReasoningEffort::Low,
            ReasoningEffort::High,
        ),
        (
            "provider-b",
            "shared-model",
            vec![
                ReasoningEffort::None,
                ReasoningEffort::Medium,
                ReasoningEffort::Max,
            ],
            ReasoningEffort::Medium,
            ReasoningEffort::Max,
        ),
        (
            "provider-a",
            "other-model",
            vec![ReasoningEffort::ExtraHigh, ReasoningEffort::Minimal],
            ReasoningEffort::ExtraHigh,
            ReasoningEffort::Minimal,
        ),
    ];
    let catalog = ModelListResult {
        models: cases
            .iter()
            .map(|(provider, model, levels, default, _)| {
                let mut model = entry(provider, model, ModelAccess::ApiKey);
                model.supported_reasoning_efforts = levels.clone();
                model.model_reasoning_effort = Some(*default);
                model
            })
            .collect(),
    };
    let transport = ConfigTransport {
        state: std::sync::Arc::new(std::sync::Mutex::new((
            crate::test_support::empty_config_snapshot(),
            vec![],
        ))),
    };
    let mut client = ash_app_server_client::AppServerClient::new(transport.clone());
    for (provider, model, levels, default, next) in cases {
        let config = {
            let mut state = transport.state.lock().unwrap();
            state.0.model = Some(ModelRefDto {
                provider: provider.into(),
                model: model.into(),
            });
            state.0.model_reasoning_effort = None;
            state.0.clone()
        };
        let picker = super::ModelPickerData::new(catalog.clone(), config.clone());
        let choices = picker.effort_choices().unwrap();
        assert_eq!(choices.actions.len(), levels.len());
        for (index, level) in levels.iter().enumerate() {
            assert_eq!(
                choices.actions[&ListSelectionItemId::new(index.to_string())],
                ComposerOption::Effort(*level)
            );
        }
        let selection = crate::widgets::list_selection::ListSelectionState::new(choices.model);
        assert_eq!(
            selection.selected_visible_index(),
            levels.iter().position(|level| *level == default)
        );
        let update = super::execute(&mut client, super::Command::IncreaseEffort, &catalog).unwrap();
        assert_eq!(update.config.model, config.model);
        assert_eq!(update.config.model_reasoning_effort, Some(next));
        let update = super::execute(&mut client, super::Command::DecreaseEffort, &catalog).unwrap();
        assert_eq!(update.config.model_reasoning_effort, Some(default));
        assert_eq!(update.summary.model_reasoning_effort(), Some(default));
        let unsupported = catalog
            .models
            .iter()
            .flat_map(|model| &model.supported_reasoning_efforts)
            .find(|level| !levels.contains(level))
            .unwrap();
        let writes = transport.state.lock().unwrap().1.len();
        assert!(
            super::execute(
                &mut client,
                super::Command::SetEffort {
                    effort: *unsupported
                },
                &catalog,
            )
            .is_err()
        );
        assert_eq!(transport.state.lock().unwrap().1.len(), writes);
    }
}
