use super::*;
#[test]
fn cancelling_a_wait_stops_the_worker_without_publishing_a_completed_item() {
    let state = Arc::new(extension_api::ExtensionState::default());
    let items = Arc::new(ExtensionItemStore::new(state));
    let wait = Sleep(items.clone());
    let definition = wait.definition();
    let binding = tools::ToolBinding::new(
        tools::ToolRegistryGeneration::new(1),
        tools::ToolBindingId::new("sleep@1").unwrap(),
        definition.name().clone(),
        definition.digest(),
        tools::ToolRuntimeKey::new("wait").unwrap(),
    );
    let source = async_utils::CancellationSource::new();
    let session = protocol::SessionId::new("s").unwrap();
    let thread = protocol::ThreadId::new("t").unwrap();
    let invocation = ToolInvocation::new(
        tools::ToolOperationId::new("wait").unwrap(),
        protocol::ToolCallId::new("call").unwrap(),
        protocol::TurnId::new("turn").unwrap(),
        binding,
        ToolPayload::FunctionArguments(json!({"duration_ms":60000})),
        tools::ToolExecutionContext::new(
            tools::EnvId::new("wait").unwrap(),
            source.token(),
            tools::ToolRuntimeAuthority::Unrestricted,
        )
        .with_session_id(session.clone())
        .with_thread_id(thread.clone()),
    );
    let worker = std::thread::spawn(move || pollster::block_on(wait.execute(invocation)));
    std::thread::sleep(Duration::from_millis(10));
    let cancelled = Instant::now();
    source.cancel();
    let result = worker.join().unwrap();
    assert!(cancelled.elapsed() < Duration::from_secs(1));
    assert!(
        matches!(result,ToolExecutionOutcome::Returned(output) if output.status()==tools::ToolOutputStatus::Error)
    );
    let result = extension_api::ItemContributor::contribute(
        items.as_ref(),
        extension_api::ThreadContext {
            session_id: &session,
            thread_id: &thread,
            sequence: 1,
        },
    )
    .unwrap();
    assert!(result.is_empty());
}

#[test]
fn timer_yields_before_completion_and_rejects_invalid_durations() {
    use std::task::Context;
    use std::task::Waker;
    let items = Arc::new(ExtensionItemStore::new(Arc::new(
        extension_api::ExtensionState::default(),
    )));
    let wait = Sleep(items);
    let definition = wait.definition();
    let binding = tools::ToolBinding::new(
        tools::ToolRegistryGeneration::new(1),
        tools::ToolBindingId::new("sleep@1").unwrap(),
        definition.name().clone(),
        definition.digest(),
        tools::ToolRuntimeKey::new("wait").unwrap(),
    );
    let source = async_utils::CancellationSource::new();
    let invocation = |arguments| {
        ToolInvocation::new(
            tools::ToolOperationId::new("wait").unwrap(),
            protocol::ToolCallId::new("call").unwrap(),
            protocol::TurnId::new("turn").unwrap(),
            binding.clone(),
            ToolPayload::FunctionArguments(arguments),
            tools::ToolExecutionContext::new(
                tools::EnvId::new("wait").unwrap(),
                source.token(),
                tools::ToolRuntimeAuthority::Unrestricted,
            )
            .with_session_id(protocol::SessionId::new("session").unwrap())
            .with_thread_id(protocol::ThreadId::new("thread").unwrap()),
        )
    };
    let mut future = wait.execute(invocation(json!({"duration_ms":100})));
    assert!(
        future
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending()
    );
    drop(future);
    for arguments in [
        json!({"duration_ms":-1}),
        json!({"duration_ms":43200001}),
        json!({"duration_ms":1,"extra":true}),
    ] {
        assert!(
            matches!(pollster::block_on(wait.execute(invocation(arguments))), ToolExecutionOutcome::Returned(output) if output.status() == tools::ToolOutputStatus::Error)
        );
    }
    assert!(
        matches!(pollster::block_on(wait.execute(invocation(json!({"duration_ms":0})))), ToolExecutionOutcome::Returned(output) if output.status() == tools::ToolOutputStatus::Success)
    );
    extension_items::ExtensionItem {
        extension: "sleep".into(),
        id: "long-wait".into(),
        title: "Completed".into(),
        body: String::new(),
        status: extension_items::ExtensionItemStatus::Completed,
        content: extension_items::ExtensionItemContent::Sleep {
            duration_ms: 43200000,
        },
    }
    .validate()
    .unwrap();
}
