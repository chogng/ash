use ash_app_server_protocol::protocol::registry::ClientMethod;
use ash_app_server_protocol::protocol::voice::VoiceStartParams;
use ash_app_server_protocol::protocol::voice::VoiceTaskLabels;
use ash_async_utils::CancellationSource;
use ash_protocol::CommandId;
use ash_protocol::ModelConnectionId;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use serde_json::json;

fn spec() -> VoiceStartParams {
    VoiceStartParams {
        resource_id: "media".into(),
        operation_id: "start".into(),
        device_id: "device".into(),
        session_id: SessionId::new("session").unwrap(),
        thread_id: ThreadId::new("thread").unwrap(),
        connection_id: ModelConnectionId::new("openai").unwrap(),
        model_id: None,
        voice: None,
        locale: "zh-CN".into(),
        input_mode: Default::default(),
        muted: false,
        task_labels: VoiceTaskLabels {
            queued: "queued".into(),
            running: "running".into(),
            waiting: "waiting".into(),
            completed: "completed".into(),
            failed: "failed".into(),
            stopped: "stopped".into(),
            rejected: "rejected".into(),
        },
    }
}

#[test]
fn voice_input_rejects_malformed_wire_controls_before_touching_media() {
    let server = crate::tests::server();
    let mut host = server.product_host_connection();
    crate::tests::initialize(&server, &mut host);
    for (sequence, control) in [
        (0_u64, json!({"type":"mute","muted":true})),
        (9_007_199_254_740_992, json!({"type":"mute","muted":true})),
        (1, json!({"type":"hold","id":"invalid\n"})),
        (1, json!({"type":"mode","mode":"unknown"})),
        (1, json!({"type":"mute","muted":"true"})),
        (1, json!({"type":"release","id":"hold","extra":true})),
    ] {
        assert_eq!(server.voice_operation(&host, ClientMethod::VoiceInput, &json!({"resourceId":"media","mediaEpoch":1,"inputSequence":sequence,"control":control})).unwrap_err().code, -32602);
    }
    assert!(!server.calls.has_active_audio());
    let mut legacy = serde_json::to_value(spec()).unwrap();
    legacy.as_object_mut().unwrap().remove("inputMode");
    legacy.as_object_mut().unwrap().remove("muted");
    let decoded: VoiceStartParams = serde_json::from_value(legacy).unwrap();
    assert_eq!(
        decoded.input_mode,
        ash_app_server_protocol::protocol::voice::VoiceInputMode::OpenMic
    );
    assert!(!decoded.muted);
}

#[test]
fn voice_rpc_rejects_non_product_hosts_and_closed_hosts_before_media_or_model_io() {
    let server = crate::tests::server();
    for mut connection in [server.connection(), server.browser_connection()] {
        crate::tests::initialize(&server, &mut connection);
        let result = server.voice_operation(&connection, ClientMethod::VoiceOptions, &json!({}));
        assert_eq!(result.unwrap_err().code, -32073);
        let result = server.voice_start(
            &connection,
            &serde_json::to_value(spec()).unwrap(),
            &CancellationSource::new().token(),
        );
        assert_eq!(result.unwrap_err().code, -32073);
    }
    let host = server.product_host_connection();
    host.mark_closed();
    assert_eq!(
        server
            .voice_operation(
                &host,
                ClientMethod::VoiceRead,
                &json!({"resourceId":"media"})
            )
            .unwrap_err()
            .code,
        -32073
    );
}

#[test]
fn voice_rpc_validates_wire_identities_and_original_thread_source_before_starting_devices() {
    let server = crate::tests::server();
    let mut host = server.product_host_connection();
    crate::tests::initialize(&server, &mut host);
    for field in ["resourceId", "operationId", "deviceId", "locale"] {
        let mut params = serde_json::to_value(spec()).unwrap();
        params[field] = json!("invalid\nvalue");
        assert_eq!(
            server
                .voice_start(&host, &params, &CancellationSource::new().token())
                .unwrap_err()
                .code,
            -32602
        );
    }
    let created = crate::tests::call(
        &server,
        &mut host,
        json!({"jsonrpc":"2.0","id":2,"method":"session/create","params":{"commandId":"session","title":"Voice","executionTarget":null}}),
    );
    let mut params = spec();
    params.thread_id = ThreadId::new(
        created["result"]["session"]["threads"][0]["threadId"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    let error = server
        .voice_start(
            &host,
            &serde_json::to_value(params).unwrap(),
            &CancellationSource::new().token(),
        )
        .unwrap_err();
    assert!(error.detail.unwrap().contains("active local Thread"));
    let cancelled = CancellationSource::new();
    cancelled.cancel();
    assert_eq!(
        server
            .voice_start(
                &host,
                &serde_json::to_value(spec()).unwrap(),
                &cancelled.token()
            )
            .unwrap_err()
            .code,
        -32800
    );
    assert!(!server.calls.has_active_audio());
}

#[test]
#[ignore = "requires pinned local Call/LiveKit executables and the explicit AudioHost IPC fixture"]
fn voice_rpc_real_room_records_speech_correlates_core_tasks_and_retires_old_media() {
    exercise_voice_core(VoiceCorePlacement::Profile);
}

#[test]
#[ignore = "requires pinned local Call/LiveKit executables and the explicit AudioHost IPC fixture"]
fn voice_rpc_real_room_keeps_media_in_profile_and_records_in_the_existing_thread_core() {
    exercise_voice_core(VoiceCorePlacement::Directory);
}

enum VoiceCorePlacement {
    Profile,
    Directory,
}

fn exercise_voice_core(placement: VoiceCorePlacement) {
    use ash_secrets::SecretStore;
    use base64::Engine;
    use futures::SinkExt;
    use futures::StreamExt;
    use std::sync::Arc;
    use std::time::Duration;
    use std::time::Instant;
    use tokio_tungstenite::tungstenite::Message;
    for variable in [
        "ASH_LIVEKIT_SERVER_PATH",
        "ASH_COLLABORATION_SERVER_PATH",
        "ASH_VOICE_HOST_PATH",
    ] {
        assert!(std::env::var_os(variable).is_some(), "missing {variable}");
    }
    let model_runtime = tokio::runtime::Runtime::new().unwrap();
    let listener = model_runtime
        .block_on(tokio::net::TcpListener::bind("127.0.0.1:0"))
        .unwrap();
    let base_url = format!("http://{}/v1", listener.local_addr().unwrap());
    let audio_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let model_audio_count = audio_count.clone();
    let (commentary, received_commentary) = std::sync::mpsc::channel();
    let model = model_runtime.spawn(async move {
        for epoch in 1..=3 {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
            let started: serde_json::Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(started["type"], "session.start");
            if epoch >= 2 {
                let instructions = started["session"]["instructions"].as_str().unwrap();
                assert!(instructions.contains("run tests") && instructions.contains("untrusted historical data"));
            }
            let model = started["session"]["model"].clone();
            socket.send(Message::Text(json!({"type":"session.started", "session":{"id":format!("live-{epoch}"), "model":model}}).to_string().into())).await.unwrap();
            let mut heard = false;
            let mut muted = true;
            while let Some(message) = socket.next().await {
                let Ok(message) = message else { break }; if message.is_close() { break; }
                let value: serde_json::Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
                if value["type"] == "session.input_audio.append" { assert!(!muted, "audio sent while model input is muted"); model_audio_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst); }
                match value["type"].as_str().unwrap() {
                    "session.input_audio.mute" => muted = true,
                    "session.input_audio.unmute" => muted = false,
                    "session.input_audio.append" if !heard && base64::engine::general_purpose::STANDARD.decode(value["audio"].as_str().unwrap()).unwrap().iter().any(|sample| *sample != 0) => {
                        heard = true;
                        for event in [json!({"type":"session.input_transcript.delta","delta":"run tests","start_ms":0,"end_ms":100}), json!({"type":"session.output_transcript.delta","delta":"I will check.","start_ms":100,"end_ms":200}), json!({"type":"session.delegation.created","delegation":{"id":"task","target":"client"},"offset_ms":100})] {
                            socket.send(Message::Text(event.to_string().into())).await.unwrap();
                        }
                    }
                    "session.commentary.append" => { commentary.send(value["content"].as_str().unwrap().to_owned()).unwrap(); }
                    "session.close" => {
                        socket.send(Message::Text(json!({"type":"session.closed","session":{"id":format!("live-{epoch}")},"reason":"client","usage":{"seconds":0.5}}).to_string().into())).await.unwrap(); break;
                    }
                    _ => {}
                }
            }
        }
    });
    let home = tempfile::tempdir().unwrap();
    let store =
        Arc::new(ash_config::ConfigStore::open(home.path().join("config.sqlite3")).unwrap());
    let mut config = model_provider_info::ModelProviderConfig::for_connection(
        ModelConnectionId::new("openai").unwrap(),
    );
    config.base_url = Some(base_url);
    store
        .apply(ash_config::ConfigCommandRequest {
            command_id: CommandId::new("configure-voice").unwrap(),
            expected_revision: ash_config::ConfigRevision::new(0),
            command: ash_config::UserConfigCommand::ConfigureConnection {
                connection: config.connection.clone(),
                config: config.clone(),
            },
        })
        .unwrap();
    let secrets = Arc::new(ash_secrets::MemorySecretStore::default());
    secrets
        .store(
            &ash_model_provider::provider_api_key_secret_key(&config.connection),
            &ash_secrets::SecretValue::new(b"fixture-key".to_vec()),
        )
        .unwrap();
    let runtime = Arc::new(ash_model_provider::ModelProviderRuntime::with_secrets(
        model_provider_info::ProviderConfigRegistry::builtin(),
        secrets,
    ));
    let queue = Arc::new(queue::QueueStore::open(&home.path().join("queue.sqlite3")).unwrap());
    let server = crate::tests::server()
        .with_queue_store(queue.clone(), None)
        .unwrap()
        .with_config_store(store)
        .with_home(Arc::new(ash_home::AshHome::new(
            ash_utils_absolute_path::AbsolutePathBuf::try_from(home.path()).unwrap(),
        )))
        .with_provider_runtime(runtime);
    let source = match placement {
        VoiceCorePlacement::Profile => None,
        VoiceCorePlacement::Directory => Some(Arc::new(
            crate::tests::server()
                .with_queue_store(queue.clone(), None)
                .unwrap(),
        )),
    };
    if let Some(source) = source.clone() {
        server.bind_voice_source(move |_, _| {
            let source = source.clone();
            async move { Ok(Some(source)) }
        });
    }
    let core = source.as_deref().unwrap_or(&server);
    let mut owner = server.product_host_connection();
    crate::tests::initialize(&server, &mut owner);
    let mut core_owner = core.product_host_connection();
    crate::tests::initialize(core, &mut core_owner);
    let created = crate::tests::call(
        core,
        &mut core_owner,
        json!({"jsonrpc":"2.0","id":2,"method":"session/create","params":{"commandId":"session","title":"Voice","executionTarget":null}}),
    );
    let mut params = spec();
    params.session_id =
        SessionId::new(created["result"]["session"]["sessionId"].as_str().unwrap()).unwrap();
    params.thread_id = ThreadId::new(
        created["result"]["session"]["threads"][0]["threadId"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    params.input_mode = ash_app_server_protocol::protocol::voice::VoiceInputMode::PushToTalk;
    let initial = core.threads.read_thread(&params.thread_id).unwrap();
    if source.is_some() {
        assert!(server.threads.read_thread(&params.thread_id).is_err());
    }
    let started = server
        .voice_start(
            &owner,
            &serde_json::to_value(&params).unwrap(),
            &CancellationSource::new().token(),
        )
        .unwrap();
    assert_eq!(started["state"], "connected");
    assert_eq!(started["listening"], false);
    std::thread::sleep(Duration::from_millis(150));
    assert_eq!(audio_count.load(std::sync::atomic::Ordering::SeqCst), 0);
    let input = |sequence, control| {
        server.voice_operation(&owner, ClientMethod::VoiceInput, &json!({"resourceId":params.resource_id,"mediaEpoch":started["mediaEpoch"],"inputSequence":sequence,"control":control}))
    };
    assert_eq!(
        input(1, json!({"type":"hold","id":"first"})).unwrap()["listening"],
        true
    );
    assert_eq!(
        input(2, json!({"type":"hold","id":"second"})).unwrap()["listening"],
        true
    );
    assert_eq!(
        input(3, json!({"type":"release","id":"first"})).unwrap()["listening"],
        true
    );
    assert_eq!(
        input(2, json!({"type":"mute","muted":true})).unwrap()["listening"],
        true
    );
    assert_eq!(
        input(3, json!({"type":"mute","muted":true}))
            .unwrap_err()
            .code,
        -32602
    );
    let deadline = Instant::now() + Duration::from_secs(15);
    let proposal = loop {
        let notifications = owner.outbound_notifications.drain();
        if let Some(value) = notifications
            .into_iter()
            .find(|value| value["method"] == "voice/delegation")
        {
            break value["params"].clone();
        }
        assert!(Instant::now() < deadline, "voice delegation did not arrive");
        std::thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(
        input(4, json!({"type":"mute","muted":true})).unwrap()["listening"],
        false
    );
    std::thread::sleep(Duration::from_millis(150));
    let quiet = audio_count.load(std::sync::atomic::Ordering::SeqCst);
    std::thread::sleep(Duration::from_millis(150));
    assert_eq!(audio_count.load(std::sync::atomic::Ordering::SeqCst), quiet);
    let capture = || {
        server.call_operation(&owner, ClientMethod::CallRead, &json!({"resourceId":format!("voice-{}-{}", params.resource_id, started["mediaEpoch"].as_u64().unwrap())})).unwrap()
    };
    assert_eq!(capture()["muted"], true);
    assert_eq!(
        input(5, json!({"type":"hold","id":"muted"}))
            .unwrap_err()
            .code,
        -32602
    );
    assert_eq!(
        input(5, json!({"type":"mute","muted":false})).unwrap()["listening"],
        false
    );
    assert_eq!(
        input(6, json!({"type":"hold","id":"expires"})).unwrap()["listening"],
        true
    );
    let expires = Instant::now() + Duration::from_secs(6);
    loop {
        let status = server
            .voice_operation(
                &owner,
                ClientMethod::VoiceRead,
                &json!({"resourceId":params.resource_id}),
            )
            .unwrap();
        assert_eq!(
            status["state"], "connected",
            "voice failed while awaiting hold expiry: {status}"
        );
        if status["listening"] == false {
            break;
        }
        assert!(Instant::now() < expires, "hold did not expire");
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(capture()["muted"], true);
    assert_eq!(
        input(7, json!({"type":"renew","id":"expires"})).unwrap()["listening"],
        false
    );
    let snapshot = core.threads.read_thread(&params.thread_id).unwrap();
    assert_eq!(snapshot.turns, initial.turns);
    assert_eq!(snapshot.items, initial.items);
    assert_eq!(snapshot.voice_transcripts.len(), 2);
    assert_eq!(snapshot.voice_transcripts[0].text, "run tests");
    assert_eq!(snapshot.voice_transcripts[1].text, "I will check.");
    queue
        .enqueue(&queue::QueueInput {
            command_id: CommandId::new(proposal["commandId"].as_str().unwrap()).unwrap(),
            session_id: params.session_id.clone(),
            thread_id: params.thread_id.clone(),
            directory: home.path().to_string_lossy().into_owned(),
            input: vec![
                ash_protocol::UserInput::Context {
                    name: "Voice request".into(),
                    content: proposal["transcript"].as_str().unwrap().into(),
                },
                ash_protocol::UserInput::Text {
                    text: "Handle the request I just spoke.".into(),
                },
            ],
            mode: Default::default(),
            model: None,
            reasoning_effort: None,
            tool_mode: ash_protocol::ToolMode::Direct,
            approval_mode: ash_protocol::ApprovalMode::Manual,
            steer_turn: None,
        })
        .unwrap();
    assert_eq!(
        received_commentary
            .recv_timeout(Duration::from_secs(15))
            .unwrap(),
        "queued"
    );
    let submitted = crate::tests::call(
        core,
        &mut core_owner,
        json!({"jsonrpc":"2.0","id":3,"method":"session/request","params":{"commandId":proposal["commandId"],"sessionId":params.session_id,"request":{"type":"startTurn","threadId":params.thread_id,"expectedSequence":snapshot.sequence,"input":[{"type":"context","name":"Voice request","content":proposal["transcript"]},{"type":"text","text":"Handle the request I just spoke."}]}}}),
    );
    assert!(submitted.get("error").is_none(), "{submitted}");
    let spoken = received_commentary
        .recv_timeout(Duration::from_secs(15))
        .unwrap();
    assert!(!spoken.is_empty());
    let control = json!({"resourceId":params.resource_id,"mediaEpoch":started["mediaEpoch"],"operationId":"interrupt"});
    let next = server
        .voice_operation(&owner, ClientMethod::VoiceInterrupt, &control)
        .unwrap();
    assert_eq!(next["state"], "connected");
    assert_eq!(next["inputMode"], "pushToTalk");
    assert_eq!(next["listening"], false);
    assert_eq!(
        input(8, json!({"type":"hold","id":"retired"}))
            .unwrap_err()
            .code,
        -32602
    );
    assert!(next["mediaEpoch"].as_u64().unwrap() > started["mediaEpoch"].as_u64().unwrap());
    assert_eq!(
        server
            .voice_operation(&owner, ClientMethod::VoiceStop, &control)
            .unwrap_err()
            .code,
        -32602
    );
    let other = server.product_host_connection();
    assert!(
        server
            .voice_operation(
                &other,
                ClientMethod::VoiceRead,
                &json!({"resourceId":params.resource_id})
            )
            .is_err()
    );
    assert_eq!(next["usageMilliseconds"], 500);
    let stopped = server.voice_operation(&owner, ClientMethod::VoiceStop, &json!({ "resourceId":params.resource_id, "mediaEpoch":next["mediaEpoch"], "operationId":"stop" })).unwrap();
    assert_eq!(stopped["state"], "ended");
    assert_eq!(stopped["usageMilliseconds"], 1000);
    // The old receipt belongs to a retired epoch and must never reopen media.
    let replay = server.voice_start(
        &owner,
        &serde_json::to_value(&params).unwrap(),
        &CancellationSource::new().token(),
    );
    assert_eq!(replay.unwrap_err().code, -32000);
    let mut again = params.clone();
    again.operation_id = "fresh-start".into();
    let restarted = server
        .voice_start(
            &owner,
            &serde_json::to_value(again).unwrap(),
            &CancellationSource::new().token(),
        )
        .unwrap();
    assert_eq!(restarted["state"], "connected");
    assert_eq!(restarted["usageMilliseconds"], 1000);
    server.close_connection(owner);
    let deadline = Instant::now() + Duration::from_secs(15);
    while server.calls.has_active_audio() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(20));
    }
    model_runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(15), model)
            .await
            .unwrap()
            .unwrap();
    });
}

#[test]
fn voice_options_exclude_a_default_connection_until_its_direct_credential_is_ready() {
    use ash_secrets::SecretStore;
    use std::sync::Arc;
    let home = tempfile::tempdir().unwrap();
    let config =
        Arc::new(ash_config::ConfigStore::open(home.path().join("config.sqlite3")).unwrap());
    let secrets = Arc::new(ash_secrets::MemorySecretStore::default());
    let runtime = Arc::new(ash_model_provider::ModelProviderRuntime::with_secrets(
        model_provider_info::ProviderConfigRegistry::builtin(),
        secrets.clone(),
    ));
    let server = crate::tests::server()
        .with_config_store(config)
        .with_provider_runtime(runtime);
    let owner = server.product_host_connection();
    let before = server
        .voice_operation(&owner, ClientMethod::VoiceOptions, &json!({}))
        .unwrap();
    assert_eq!(before["connections"], json!([]));
    secrets
        .store(
            &ash_model_provider::provider_api_key_secret_key(
                &ModelConnectionId::new("openai").unwrap(),
            ),
            &ash_secrets::SecretValue::new(b"fixture-voice-key".to_vec()),
        )
        .unwrap();
    let after = server
        .voice_operation(&owner, ClientMethod::VoiceOptions, &json!({}))
        .unwrap();
    assert_eq!(after["connections"][0]["connectionId"], "openai");
    assert!(
        after["connections"][0]["models"]
            .as_array()
            .unwrap()
            .iter()
            .all(|model| model["defaultVoice"].is_string())
    );
    assert!(!server.calls.has_active_audio());
}

#[test]
fn voice_start_cancel_retires_a_pending_directory_core_lookup_before_media_or_provider_io() {
    use std::sync::Arc;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;
    let server = Arc::new(crate::tests::server());
    let (entered, ready) = mpsc::channel();
    server.bind_voice_source(move |_, cancellation| {
        entered.send(()).unwrap();
        async move {
            cancellation.cancelled().await;
            Err("directory lookup cancelled".into())
        }
    });
    let mut owner = server.product_host_connection();
    crate::tests::initialize(&server, &mut owner);
    thread::scope(|scope| {
        let dispatcher = super::request_dispatch::RequestDispatcher::start(scope).unwrap();
        let (responses, received) = mpsc::channel();
        let output = responses.clone();
        dispatcher
            .dispatch(
                server.clone(),
                &owner,
                json!({"jsonrpc":"2.0","id":2,"method":"voice/start","params":spec()}).to_string(),
                move |message| {
                    output
                        .send(serde_json::from_str::<serde_json::Value>(&message).unwrap())
                        .unwrap();
                    Ok(())
                },
            )
            .unwrap();
        ready.recv_timeout(Duration::from_secs(3)).unwrap();
        dispatcher.dispatch(server.clone(), &owner, json!({"jsonrpc":"2.0","id":3,"method":"voice/start/cancel","params":{"operationId":"start"}}).to_string(), move |message| { responses.send(serde_json::from_str::<serde_json::Value>(&message).unwrap()).unwrap(); Ok(()) }).unwrap();
        let mut responses = [
            received.recv_timeout(Duration::from_secs(3)).unwrap(),
            received.recv_timeout(Duration::from_secs(3)).unwrap(),
        ];
        responses.sort_by_key(|value| value["id"].as_u64().unwrap());
        assert_eq!(responses[0]["error"]["code"], -32800, "{:?}", responses);
        assert_eq!(responses[1]["result"], serde_json::Value::Null);
        assert!(server.calls.sessions.lock().unwrap().is_empty());
        dispatcher.finish().unwrap();
    });
}
