use super::*;
use std::collections::BTreeMap;

struct StartPlanTransport {
    requests: Mutex<Vec<ClientRequest>>,
    verification_required: bool,
    expired: bool,
}

impl OperationClient for StartPlanTransport {
    fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
        self.requests.lock().unwrap().push(request.clone());
        if request.url().contains("/api/coding/paas/v4/") {
            return Ok(ClientResponse::new(
                429,
                vec![],
                br#"{"error":{"code":"1113","message":"Coding Plan is unavailable"}}"#.to_vec(),
            ));
        }
        let body = if request.url().contains("billing/balance") {
            json!({"code":0,"data":{"server_time":1000,
                "plans":[{"user_plan_id":"plan","name":"Start Plan","status":"active","starts_at":900,"ends_at":if self.expired {999} else {2000}}],
                "balances":[{"bucket_id":"bucket","user_plan_id":"plan","show_name":"GLM-5.3-Flash","capabilities":["model:glm-5.3-flash"],
                    "total_units":1000,"used_units":250,"available_units":750,"period_start":900,"period_end":2000,"expires_at":2000}]}})
        } else if request.url().contains("client/configs") {
            json!({"code":0,"data":{"configs":{"captcha":{"enabled":true,"skip_model_request":!self.verification_required}}}})
        } else {
            assert_eq!(
                request.url(),
                "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages"
            );
            let body: Value = serde_json::from_slice(request.body()).unwrap();
            assert_eq!(body["model"], "glm-5.3-flash");
            assert_eq!(
                body["system"][0]["text"],
                "You are ZCode, an interactive coding agent"
            );
            assert!(
                body["system"][1]["text"]
                    .as_str()
                    .unwrap()
                    .contains("# Harness")
            );
            assert!(body["system"][0].get("cache_control").is_none());
            assert!(body["system"][1].get("cache_control").is_none());
            let tool_result = body["messages"].as_array().unwrap().last().unwrap()["content"][0]["type"]
                == "tool_result";
            let (content, stop) = if body.get("tools").is_some() && !tool_result {
                (
                    json!([{"type":"tool_use","id":"call-echo","name":"start_plan_echo","input":{"text":"ECHO_OK"}}]),
                    "tool_use",
                )
            } else {
                (
                    json!([{"type":"text","text":if tool_result {"ECHO_OK"} else {"OK"}}]),
                    "end_turn",
                )
            };
            json!({"id":"msg-1","type":"message","role":"assistant","model":"glm-5.3-flash", "content":content,"stop_reason":stop,"usage":{"input_tokens":2,"output_tokens":1}})
        };
        Ok(ClientResponse::new(
            200,
            vec![],
            serde_json::to_vec(&body).unwrap(),
        ))
    }
    fn execute_streaming(
        &self,
        request: &ClientRequest,
        sink: &mut dyn OperationStreamSink,
    ) -> Result<ClientResponse, ClientError> {
        let response = self.execute(request)?;
        if response.status() != 200 {
            return Ok(response);
        }
        let body: Value = serde_json::from_slice(response.body()).unwrap();
        sink.emit(streaming::response_stream(&body).as_bytes())?;
        Ok(ClientResponse::new(200, vec![], vec![]))
    }
}

fn runtime(transport: Arc<StartPlanTransport>, provider: GlmProvider) -> ModelProviderRuntime {
    let secrets = Arc::new(MemorySecretStore::default());
    let id = match provider {
        GlmProvider::BigModelStartPlan => "bigmodel-start-plan",
        GlmProvider::ZaiStartPlan => "zai-start-plan",
        _ => panic!("expected Start Plan"),
    };
    secrets.store(&SecretKey::new(format!("provider/{id}/current/oauth")).unwrap(),
        &SecretValue::new(serde_json::to_vec(&json!({"account_id":"account", "email":null,"display_name":null,"model_key":"zcode-jwt","revision":1})).unwrap())).unwrap();
    ModelProviderRuntime::with_client_and_secrets(
        ProviderConfigRegistry::builtin(),
        transport.clone(),
        secrets.clone(),
    )
    .with_glm_accounts([GlmOAuth::with_client(provider, secrets, transport)])
}

#[test]
fn disconnecting_coding_plan_selects_start_plan_for_the_next_invocation() {
    let transport = Arc::new(StartPlanTransport {
        requests: Mutex::new(vec![]),
        verification_required: false,
        expired: false,
    });
    let secrets = Arc::new(MemorySecretStore::default());
    for owner in ["bigmodel", "bigmodel-start-plan"] {
        secrets.store(&SecretKey::new(format!("provider/{owner}/current/oauth")).unwrap(),
            &SecretValue::new(serde_json::to_vec(&json!({"account_id":"account", "email":null,"display_name":null,"model_key":owner,"revision":1})).unwrap())).unwrap();
    }
    let coding = GlmOAuth::with_client(GlmProvider::BigModel, secrets.clone(), transport.clone());
    let start = GlmOAuth::with_client(
        GlmProvider::BigModelStartPlan,
        secrets.clone(),
        transport.clone(),
    );
    let login = login::LoginService::new_with_drivers([
        coding.clone() as Arc<dyn login::InteractiveLoginDriver>,
        start.clone() as Arc<dyn login::InteractiveLoginDriver>,
    ])
    .unwrap();
    let runtime = ModelProviderRuntime::with_client_and_secrets(
        ProviderConfigRegistry::builtin(),
        transport.clone(),
        secrets.clone(),
    )
    .with_glm_accounts([coding, start]);
    let model_ref = model_ref("glm", "glm-5.3-flash");
    let selected = runtime.preferred_connections(&BTreeMap::new()).unwrap();
    assert_eq!(
        selected[&model_ref.provider].connection.as_str(),
        "bigmodel-coding-plan"
    );
    let model = runtime
        .build_model(&selected[&model_ref.provider], &model_ref)
        .unwrap();
    assert!(matches!(
        model.invoke(&ModelRequest::text("hello")),
        Err(ModelProviderError::Api(ApiError::RateLimited { .. }))
    ));
    assert_eq!(transport.requests.lock().unwrap().len(), 1);

    login.logout_provider("bigmodel-coding-plan").unwrap();
    let selected = runtime.preferred_connections(&BTreeMap::new()).unwrap();
    assert_eq!(
        selected[&model_ref.provider].connection.as_str(),
        "bigmodel-start-plan"
    );
    let model = runtime
        .build_model(&selected[&model_ref.provider], &model_ref)
        .unwrap();
    assert_eq!(
        model.invoke(&ModelRequest::text("hello")).unwrap().text(),
        "OK"
    );
    let requests = transport.requests.lock().unwrap();
    assert_eq!(requests.len(), 4);
    assert!(
        requests[1..]
            .iter()
            .all(|request| !request.url().contains("/api/coding/paas/v4/"))
    );
    assert!(requests[1..].iter().all(|request| {
        request.headers().iter().any(|header| {
            header.name() == "Authorization" && header.value() == "Bearer bigmodel-start-plan"
        })
    }));
}

#[test]
fn start_plan_invokes_an_entitled_model_through_anthropic_for_both_regions() {
    for (provider, connection) in [
        (GlmProvider::BigModelStartPlan, "bigmodel-start-plan"),
        (GlmProvider::ZaiStartPlan, "zai-start-plan"),
    ] {
        let transport = Arc::new(StartPlanTransport {
            requests: Mutex::new(vec![]),
            verification_required: false,
            expired: false,
        });
        let runtime = runtime(transport.clone(), provider);
        let model = runtime
            .build_model(
                &provider_config(connection),
                &model_ref("glm", "glm-5.3-flash"),
            )
            .unwrap();
        assert_eq!(
            model.invoke(&ModelRequest::text("hello")).unwrap().text(),
            "OK"
        );
        let requests = transport.requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        let device = requests[0]
            .headers()
            .iter()
            .find(|header| header.name() == "X-Device-Mid")
            .unwrap()
            .value();
        assert_eq!(device.len(), 36);
        for request in requests.iter() {
            assert!(
                request
                    .headers()
                    .iter()
                    .any(|header| header.name() == "Authorization"
                        && header.value() == "Bearer zcode-jwt")
            );
            assert!(
                request
                    .headers()
                    .iter()
                    .any(|header| header.name() == "X-Device-Mid" && header.value() == device)
            );
            assert!(
                request
                    .headers()
                    .iter()
                    .any(|header| header.name() == "User-Agent"
                        && header.value().starts_with("Ash/"))
            );
        }
    }
}

#[test]
fn start_plan_does_not_send_prompts_when_expired_or_verification_is_required() {
    for (expired, verification_required, count) in [(true, false, 1), (false, true, 2)] {
        let transport = Arc::new(StartPlanTransport {
            requests: Mutex::new(vec![]),
            verification_required,
            expired,
        });
        let runtime = runtime(transport.clone(), GlmProvider::BigModelStartPlan);
        let model = runtime
            .build_model(
                &provider_config("bigmodel-start-plan"),
                &model_ref("glm", "glm-5.3-flash"),
            )
            .unwrap();
        assert!(model.invoke(&ModelRequest::text("hello")).is_err());
        assert_eq!(transport.requests.lock().unwrap().len(), count);
    }
}

#[test]
fn start_plan_preserves_ash_instructions_and_tool_continuations() {
    let transport = Arc::new(StartPlanTransport {
        requests: Mutex::new(vec![]),
        verification_required: false,
        expired: false,
    });
    let runtime = runtime(transport.clone(), GlmProvider::BigModelStartPlan);
    let model = runtime
        .build_model(
            &provider_config("bigmodel-start-plan"),
            &model_ref("glm", "glm-5.3-flash"),
        )
        .unwrap();
    let mut request =
        ModelRequest::text("Call start_plan_echo with ECHO_OK, then return the result.");
    request.instructions =
        Some("You are Ash. Use the supplied tools and respect denied calls.".into());
    request.tools.push(ToolDefinition {
        name: ToolName::new("start_plan_echo").unwrap(),
        description: "Returns the supplied text".into(),
        parameters: json!({"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false}),
        strict: true,
    });
    request.tool_choice = ash_api::ToolChoice::Function(request.tools[0].name.clone());
    let original = request.clone();
    let first = model.invoke(&request).unwrap();
    assert_eq!(request, original);
    assert_eq!(first.stop_reason, StopReason::ToolUse);
    let call = first.tool_calls().next().unwrap().clone();
    request
        .input
        .push(ash_api::InputItem::Message(ash_api::Message {
            role: ash_api::MessageRole::Assistant,
            content: vec![],
            tool_calls: vec![call.clone()],
        }));
    request
        .input
        .push(ash_api::InputItem::ToolResult(ash_api::ToolResult {
            call_id: call.id,
            name: call.name,
            content: vec![ash_api::ContentPart::Text("ECHO_OK".into())],
            is_error: false,
        }));
    request.tool_choice = ash_api::ToolChoice::Auto;
    assert_eq!(model.invoke(&request).unwrap().text(), "ECHO_OK");
    let requests = transport.requests.lock().unwrap();
    let model_calls: Vec<Value> = requests
        .iter()
        .filter(|r| r.url().ends_with("/v1/messages"))
        .map(|r| serde_json::from_slice(r.body()).unwrap())
        .collect();
    assert_eq!(model_calls.len(), 2);
    for body in &model_calls {
        assert_eq!(body["system"].as_array().unwrap().len(), 3);
        assert_eq!(
            body["system"][2]["text"],
            original.instructions.as_deref().unwrap()
        );
        assert_eq!(body["system"][2]["cache_control"]["type"], "ephemeral");
        assert_eq!(
            body["tools"][0]["input_schema"],
            original.tools[0].parameters
        );
        assert!(body.get("metadata").is_none());
        assert_eq!(
            body["messages"][0]["content"][0]["text"],
            "Call start_plan_echo with ECHO_OK, then return the result."
        );
    }
    assert_eq!(model_calls[0]["messages"].as_array().unwrap().len(), 1);
    assert_eq!(model_calls[0]["tool_choice"]["type"], "tool");
    assert_eq!(model_calls[1]["messages"].as_array().unwrap().len(), 3);
    assert_eq!(
        model_calls[1]["messages"][1]["content"][0]["id"],
        "call-echo"
    );
    assert_eq!(
        model_calls[1]["messages"][2]["content"][0]["tool_use_id"],
        "call-echo"
    );
    assert_eq!(model_calls[1]["tool_choice"]["type"], "auto");
}

#[tokio::test]
async fn start_plan_catalog_contains_only_models_granted_by_the_current_balance() {
    let transport = Arc::new(StartPlanTransport {
        requests: Mutex::new(vec![]),
        verification_required: false,
        expired: false,
    });
    let runtime = runtime(transport, GlmProvider::BigModelStartPlan);
    let binding = runtime
        .catalog_binding(&provider_config("bigmodel-start-plan"))
        .unwrap()
        .unwrap();
    let manager = runtime.models_manager();
    manager
        .refresh(binding.scope().clone(), binding.source())
        .await
        .unwrap();
    let models = manager
        .list_discovered(
            &[binding.scope().clone()],
            &ash_models_manager::CatalogQuery::all(),
        )
        .unwrap();
    assert_eq!(
        models
            .iter()
            .map(|model| model.model().model.as_str())
            .collect::<Vec<_>>(),
        ["glm-5.3-flash"]
    );
}

struct StartPlanTokenizer {
    requests: Mutex<Vec<ModelRequest>>,
}

impl LocalTokenizerService for StartPlanTokenizer {
    fn supports(&self, model: &ModelRef) -> bool {
        model.provider.as_str() == "glm"
    }

    fn count_input_tokens(
        &self,
        _: &ModelRef,
        request: &ModelRequest,
    ) -> Result<LocalTokenizationOutcome, LocalTokenizerError> {
        self.requests.lock().unwrap().push(request.clone());
        Ok(LocalTokenizationOutcome::Count(LocalTokenCount::new(
            400,
            "start-plan-tokenizer",
        )?))
    }
}

#[test]
fn start_plan_local_input_accounting_includes_the_required_prelude() {
    let transport = Arc::new(StartPlanTransport {
        requests: Mutex::new(vec![]),
        verification_required: false,
        expired: false,
    });
    let tokenizer = Arc::new(StartPlanTokenizer {
        requests: Mutex::new(vec![]),
    });
    let runtime = runtime(transport.clone(), GlmProvider::BigModelStartPlan)
        .with_local_tokenizers(tokenizer.clone());
    let model = runtime
        .build_model(
            &provider_config("bigmodel-start-plan"),
            &model_ref("glm", "glm-5.3-flash"),
        )
        .unwrap();
    let mut request = ModelRequest::text("hello");
    request.instructions = Some("You are Ash.".into());
    let ContextTokenMeasurementOutcome::Measured(measurement) =
        model.measure_input(&request).unwrap()
    else {
        panic!("expected local count");
    };
    assert_eq!(measurement.measured_input().get(), 400);
    let requests = tokenizer.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    let instructions = requests[0].instructions.as_deref().unwrap();
    assert!(instructions.starts_with("You are ZCode, an interactive coding agent"));
    assert!(instructions.contains("# Harness"));
    assert!(instructions.ends_with("You are Ash."));
    assert_eq!(requests[0].input, request.input);
    assert!(transport.requests.lock().unwrap().is_empty());
    assert_eq!(request.instructions.as_deref(), Some("You are Ash."));
}

#[test]
#[ignore = "Real BigModel Start Plan requests using an isolated Ash browser login"]
fn live_bigmodel_start_plan_ash_login_streams_and_continues_tools() {
    let home = std::env::var_os("ASH_START_PLAN_VALIDATION_HOME")
        .expect("explicit isolated Ash login directory required");
    let secrets = Arc::new(
        ash_secrets::FileSecretStore::open(std::path::PathBuf::from(home).join("secrets")).unwrap(),
    );
    assert!(
        secrets
            .load(&SecretKey::new("provider/bigmodel-start-plan/current/oauth").unwrap())
            .unwrap()
            .is_some(),
        "Ash browser login must exist"
    );
    let auth = GlmOAuth::production(GlmProvider::BigModelStartPlan, secrets.clone()).unwrap();
    let runtime = ModelProviderRuntime::with_secrets(ProviderConfigRegistry::builtin(), secrets)
        .with_glm_accounts([auth]);
    let model = runtime
        .build_model(
            &provider_config("bigmodel-start-plan"),
            &model_ref("glm", "glm-5.3-flash"),
        )
        .unwrap();
    let invoke = |request: &ModelRequest| {
        let response = model.invoke(request);
        let category = match &response {
            Ok(_) => "success".to_owned(),
            Err(ModelProviderError::Api(ApiError::HttpStatus(status))) => format!("HTTP {status}"),
            Err(ModelProviderError::Credential(_)) => "credential or entitlement".to_owned(),
            Err(_) => "model transport or response".to_owned(),
        };
        assert!(
            response.is_ok(),
            "Ash Start Plan request failed: {category}"
        );
        response.unwrap()
    };
    let mut request = ModelRequest::text("Reply with OK.");
    request.max_output_tokens = Some(1024);
    request.instructions = Some("You are Ash. Use only the supplied tools. When asked your product name, reply with Ash. Follow the requested output exactly.".into());
    assert_eq!(invoke(&request).text().trim(), "OK");
    request.input = ModelRequest::text("Call start_plan_echo with text ASH_START_PLAN_TOOL_OK. After getting the tool result, reply with the exact result and nothing else.").input;
    request.tools.push(ToolDefinition {
        name: ToolName::new("start_plan_echo").unwrap(),
        description: "Returns the supplied text verbatim.".into(),
        parameters: json!({"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false}),
        strict: true,
    });
    request.tool_choice = ash_api::ToolChoice::Function(request.tools[0].name.clone());
    let first = invoke(&request);
    let calls: Vec<_> = first.tool_calls().cloned().collect();
    assert_eq!(calls.len(), 1);
    let call = calls[0].clone();
    assert_eq!(call.name.as_str(), "start_plan_echo");
    assert_eq!(call.arguments, json!({"text":"ASH_START_PLAN_TOOL_OK"}));
    request
        .input
        .push(ash_api::InputItem::Message(ash_api::Message {
            role: ash_api::MessageRole::Assistant,
            content: vec![],
            tool_calls: vec![call.clone()],
        }));
    request
        .input
        .push(ash_api::InputItem::ToolResult(ash_api::ToolResult {
            call_id: call.id,
            name: call.name,
            content: vec![ash_api::ContentPart::Text("ASH_START_PLAN_TOOL_OK".into())],
            is_error: false,
        }));
    request.tool_choice = ash_api::ToolChoice::Auto;
    let second = invoke(&request);
    assert_eq!(second.text().trim(), "ASH_START_PLAN_TOOL_OK");
    request
        .input
        .push(ash_api::InputItem::Message(ash_api::Message::text(
            ash_api::MessageRole::Assistant,
            second.text(),
        )));
    request.input.push(ash_api::InputItem::Message(ash_api::Message::text(ash_api::MessageRole::User, "What is your product name? Reply with the single word specified by your system instructions.")));
    request.tools.clear();
    assert_eq!(invoke(&request).text().trim(), "Ash");
}

#[test]
#[ignore = "Real BigModel Start Plan request; read-only ZCode credentials"]
fn live_bigmodel_start_plan_uses_the_ash_model_pipeline() {
    use sha2::Digest;
    let base = std::env::var_os("ZCODE_DATA_BASE_DIR")
        .or_else(|| std::env::var_os("HOME"))
        .expect("ZCode credential directory must be available");
    let path = std::path::PathBuf::from(base).join(".zcode/v2/credentials.json");
    let fingerprint = || {
        sha2::Sha256::digest(
            SecretValue::new(std::fs::read(&path).expect("ZCode credentials must exist")).expose(),
        )
    };
    let before = fingerprint();
    let secrets = Arc::new(MemorySecretStore::default());
    let auth = GlmOAuth::production(GlmProvider::BigModelStartPlan, secrets.clone()).unwrap();
    let runtime = ModelProviderRuntime::with_secrets(ProviderConfigRegistry::builtin(), secrets)
        .with_glm_accounts([auth]);
    let model = runtime
        .build_model(
            &provider_config("bigmodel-start-plan"),
            &model_ref("glm", "glm-5.3-flash"),
        )
        .unwrap();
    let mut request = ModelRequest::text("Reply with OK.");
    request.max_output_tokens = Some(1024);
    let response = model.invoke(&request);
    assert!(
        before == fingerprint(),
        "ZCode credentials must remain unchanged"
    );
    let category = match &response {
        Ok(_) => "success".to_owned(),
        Err(ModelProviderError::Api(ApiError::HttpStatus(status))) => format!("HTTP {status}"),
        Err(ModelProviderError::Credential(_)) => "credential or entitlement".to_owned(),
        Err(_) => "model transport or response".to_owned(),
    };
    assert!(
        response.is_ok(),
        "Ash Start Plan request failed: {category}"
    );
    assert!(!response.unwrap().text().trim().is_empty());
}
