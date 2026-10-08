use super::*;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::model::ContextReadResult;

struct ContextTransport {
    expected_scope: ContextReadScope,
    expected_detail: ContextReadDetail,
    model: Option<ash_protocol::ModelRef>,
    catalog: ModelListResult,
}
impl JsonRpcTransport for ContextTransport {
    fn round_trip(&mut self, request: &str) -> Result<String, ClientError> {
        let request: serde_json::Value = serde_json::from_str(request).unwrap();
        let result = match request["method"].as_str().unwrap() {
            "context/read" => {
                assert_eq!(
                    request["params"]["detail"],
                    serde_json::to_value(self.expected_detail).unwrap()
                );
                assert_eq!(
                    request["params"]["scope"],
                    serde_json::to_value(&self.expected_scope).unwrap()
                );
                serde_json::to_value(ContextReadResult {
                    tool_definitions: vec![],
                    context: ModelContextInspection {
                        compaction_policy: Default::default(),
                        model: self.model.clone(),
                        estimated_tokens: 400,
                        estimator_revision: "test".into(),
                        categories: vec![],
                        allocation: None,
                        latest_request: None,
                    },
                })
                .unwrap()
            }
            "model/list" => {
                assert!(self.model.is_some());
                serde_json::to_value(&self.catalog).unwrap()
            }
            method => panic!("unexpected method: {method}"),
        };
        Ok(
            serde_json::json!({ "jsonrpc": "2.0", "id": request["id"], "result": result })
                .to_string(),
        )
    }
}

#[test]
fn context_panel_reads_environment_before_any_request_and_preserves_thread_scope() {
    let session_id = SessionId::new("session").unwrap();
    let thread_id = ThreadId::new("thread").unwrap();
    for scope in [
        None,
        Some(RequestScope {
            session_id: &session_id,
            thread_id: &thread_id,
        }),
    ] {
        let expected_scope = match &scope {
            None => ContextReadScope::Environment,
            Some(scope) => ContextReadScope::Thread {
                session_id: scope.session_id.clone(),
                thread_id: scope.thread_id.clone(),
            },
        };
        let mut client = AppServerClient::new(ContextTransport {
            expected_scope,
            expected_detail: ContextReadDetail::Usage,
            model: None,
            catalog: ModelListResult {
                catalog_scopes: None,
                models: vec![],
            },
        });
        let panel = load_panel(&mut client, scope, ContextReadDetail::Usage).unwrap();
        assert_eq!(panel.inspection.estimated_tokens, 400);
        assert_eq!(panel.inspection.latest_request, None);
    }
}

#[test]
fn context_diagnostics_explicitly_requests_definitions() {
    let mut client = AppServerClient::new(ContextTransport {
        expected_scope: ContextReadScope::Environment,
        expected_detail: ContextReadDetail::Diagnostics,
        model: None,
        catalog: ModelListResult {
            catalog_scopes: None,
            models: vec![],
        },
    });
    let panel = load_panel(&mut client, None, ContextReadDetail::Diagnostics).unwrap();
    assert_eq!(panel.title(), "Developer: Context diagnostics");
}

#[test]
fn context_summary_categories_are_read_only_for_keyboard_and_pointer_input() {
    let mut panel = panel(
        ModelContextInspection {
            compaction_policy: Default::default(),
            model: None,
            estimated_tokens: 2_500,
            estimator_revision: "test".into(),
            allocation: None,
            latest_request: None,
            categories: [
                ModelContextCategory::SystemPrompt,
                ModelContextCategory::SystemTools,
                ModelContextCategory::MemoryFiles,
                ModelContextCategory::Skills,
                ModelContextCategory::Conversation,
            ]
            .into_iter()
            .enumerate()
            .map(
                |(index, category)| ash_protocol::ModelContextCategoryUsage {
                    category,
                    tokens: 500,
                    sources: vec![ash_protocol::ModelContextSourceUsage {
                        name: format!("source-{index}"),
                        item_count: None,
                        tokens: 500,
                    }],
                },
            )
            .collect(),
        },
        &ModelListResult {
            catalog_scopes: None,
            models: vec![],
        },
    );
    let body = Rect::new(0, 0, 80, 24);
    let list = panel.context_areas(body)[1];
    for index in 0..5 {
        let selected = ListSelectionItemId::new(format!("category-{index}"));
        for x in list.x..list.right() {
            assert!(
                panel
                    .pointer_target_at(body, Position::new(x, list.y + index))
                    .is_none()
            );
        }
        let before = panel.body_rows(body.width);
        for code in [
            crossterm::event::KeyCode::Enter,
            crossterm::event::KeyCode::Right,
            crossterm::event::KeyCode::Left,
        ] {
            panel.handle_key(
                KeyEvent::new(code, crossterm::event::KeyModifiers::NONE),
                body,
            );
            assert_eq!(panel.body_rows(body.width), before);
            let item = panel.pages.selected_item().unwrap();
            assert_eq!(item.id(), Some(&selected));
            assert!(!item.has_expandable_details());
        }
        panel.handle_key(
            KeyEvent::new(
                crossterm::event::KeyCode::Down,
                crossterm::event::KeyModifiers::NONE,
            ),
            body,
        );
    }
}

#[test]
fn context_loads_the_inspected_models_display_name_from_its_provider() {
    use ash_app_server_protocol::protocol::model::ModelCatalogEntry;
    use ash_protocol::ModelId;
    use ash_protocol::ModelInfo;
    use ash_protocol::ModelRef;
    use ash_protocol::ProviderId;

    let model = ModelRef::new(
        ProviderId::new("glm").unwrap(),
        ModelId::new("glm-5.3-flash").unwrap(),
    );
    let other = ModelRef::new(ProviderId::new("other").unwrap(), model.model.clone());
    let catalog = ModelListResult {
        catalog_scopes: None,
        models: vec![
            ModelCatalogEntry::from_info(other.clone(), &ModelInfo::new(other.model, "Other name")),
            ModelCatalogEntry::from_info(
                model.clone(),
                &ModelInfo::new(model.model.clone(), "GLM-5.3 Flash"),
            ),
        ],
    };
    for detail in [ContextReadDetail::Usage, ContextReadDetail::Diagnostics] {
        let mut client = AppServerClient::new(ContextTransport {
            expected_scope: ContextReadScope::Environment,
            expected_detail: detail,
            model: Some(model.clone()),
            catalog: catalog.clone(),
        });
        let panel = load_panel(&mut client, None, detail).unwrap();
        assert_eq!(&*panel.model, "GLM-5.3 Flash");
        let lines = panel.context_lines(80);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].width(), 80);
        assert!(lines[0].to_string().starts_with("GLM-5.3 Flash"));
        assert!(lines[0].to_string().ends_with("400 tokens used"));
    }
}
