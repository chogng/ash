use super::*;
use crate::render::test_context;
use crate::widgets::list_selection::ListSelectionState;
use crate::widgets::list_selection::draw_body_with_pointer;
use ash_app_server_client::ClientError;
use ash_app_server_protocol::protocol::model::ModelCatalogEntry;
use ash_app_server_protocol::protocol::provider::{
    ProviderApiKeyPolicyDto, ProviderCatalogEntryDto, ProviderListResult,
};
use ash_protocol::{ModelAccess, ModelId, ModelInfo, ModelRef, ProviderId};
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

struct RecordingTransport {
    responses: VecDeque<String>,
    requests: Arc<Mutex<Vec<serde_json::Value>>>,
}

impl JsonRpcTransport for RecordingTransport {
    fn round_trip(&mut self, request: &str) -> Result<String, ClientError> {
        self.requests
            .lock()
            .unwrap()
            .push(serde_json::from_str(request).unwrap());
        self.responses
            .pop_front()
            .ok_or_else(|| ClientError::Transport("no response".into()))
    }
}

fn response(id: u64, result: serde_json::Value) -> String {
    serde_json::json!({"jsonrpc":"2.0","id":id,"result":result}).to_string()
}

#[test]
fn model_picker_loads_ready_kimi_desktop_models_from_its_own_connection() {
    let model_ref = ModelRef::new(
        ProviderId::new("kimi-desktop").unwrap(),
        ModelId::new("k2d8-preview").unwrap(),
    );
    let mut info = ModelInfo::new(model_ref.model.clone(), "K2 Preview");
    info.access = ModelAccess::Subscription;
    let desktop_model = ModelCatalogEntry::from_info(model_ref, &info);
    let providers = ProviderListResult {
        providers: vec![ProviderCatalogEntryDto {
            connection: "kimi-desktop".into(),
            provider: "kimi-desktop".into(),
            display_name: "Kimi Desktop".into(),
            access: ModelAccess::Subscription,
            active: true,
            configured: true,
            ready: true,
            api_key_policy: ProviderApiKeyPolicyDto::Unsupported,
            api_key_configured: false,
        }],
    };
    let requests = Arc::new(Mutex::new(Vec::new()));
    let mut client = AppServerClient::new(RecordingTransport {
        requests: Arc::clone(&requests),
        responses: VecDeque::from([
            response(1, serde_json::json!({"models":[]})),
            response(2, serde_json::to_value(providers).unwrap()),
            response(
                3,
                serde_json::to_value(ProviderModelsListResult::Models {
                    models: vec![desktop_model],
                })
                .unwrap(),
            ),
        ]),
    });
    let catalog = load_catalog(&mut client).unwrap();
    assert_eq!(catalog.models.len(), 1);
    assert_eq!(catalog.models[0].model.provider.as_str(), "kimi-desktop");
    let choices =
        super::super::model_choices(&catalog, &crate::test_support::empty_config_snapshot())
            .unwrap();
    assert!(choices.actions.values().any(|action| matches!(
        action,
        super::super::ModelSelectionAction::Select { preference, .. }
            if preference == "kimi-desktop/k2d8-preview"
    )));
    let view = ListSelectionState::new(choices.model);
    let mut terminal = Terminal::new(TestBackend::new(44, 7)).unwrap();
    terminal
        .draw(|frame| {
            draw_body_with_pointer(frame, frame.area(), &view, None, None, test_context())
        })
        .unwrap();
    crate::tui_assert_snapshot!("kimi_desktop_model_picker", terminal.backend().to_string());
    let requests = requests.lock().unwrap();
    assert_eq!(requests[0]["method"], "model/list");
    assert_eq!(requests[1]["method"], "provider/list");
    assert_eq!(requests[2]["method"], "provider/models/list");
    assert_eq!(requests[2]["params"]["connection"], "kimi-desktop");
}

#[test]
fn model_picker_combines_distinct_desktop_and_cli_connections() {
    let provider = |connection: &str| ProviderCatalogEntryDto {
        connection: connection.into(),
        provider: connection.into(),
        display_name: connection.into(),
        access: ModelAccess::Subscription,
        active: true,
        configured: true,
        ready: true,
        api_key_policy: ProviderApiKeyPolicyDto::Unsupported,
        api_key_configured: false,
    };
    let model = |connection: &str, id: &str| {
        let model_ref = ModelRef::new(
            ProviderId::new(connection).unwrap(),
            ModelId::new(id).unwrap(),
        );
        let mut info = ModelInfo::new(model_ref.model.clone(), id);
        info.access = ModelAccess::Subscription;
        ModelCatalogEntry::from_info(model_ref, &info)
    };
    let requests = Arc::new(Mutex::new(Vec::new()));
    let mut client = AppServerClient::new(RecordingTransport {
        requests: Arc::clone(&requests),
        responses: VecDeque::from([
            response(1, serde_json::json!({"models":[]})),
            response(
                2,
                serde_json::to_value(ProviderListResult {
                    providers: vec![provider("kimi-desktop"), provider("kimi-cli")],
                })
                .unwrap(),
            ),
            response(
                3,
                serde_json::to_value(ProviderModelsListResult::Models {
                    models: vec![model("kimi-desktop", "desktop-k2")],
                })
                .unwrap(),
            ),
            response(
                4,
                serde_json::to_value(ProviderModelsListResult::Models {
                    models: vec![model("kimi-cli", "cli-k2")],
                })
                .unwrap(),
            ),
        ]),
    });
    let catalog = load_catalog(&mut client).unwrap();
    let choices =
        super::super::model_choices(&catalog, &crate::test_support::empty_config_snapshot())
            .unwrap();
    assert!(choices.actions.values().any(|action| matches!(action, super::super::ModelSelectionAction::Select { preference, .. } if preference == "kimi-cli/cli-k2")));
    let view = ListSelectionState::new(choices.model);
    let mut terminal = Terminal::new(TestBackend::new(44, 7)).unwrap();
    terminal
        .draw(|frame| {
            draw_body_with_pointer(frame, frame.area(), &view, None, None, test_context())
        })
        .unwrap();
    crate::tui_assert_snapshot!("kimi_external_model_picker", terminal.backend().to_string());
    let requests = requests.lock().unwrap();
    assert_eq!(requests[2]["params"]["connection"], "kimi-desktop");
    assert_eq!(requests[3]["params"]["connection"], "kimi-cli");
}
