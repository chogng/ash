use super::*;
use crate::ContextInspectionRequest;
use crate::ContextInspectionScope;
use ash_protocol::ModelContextCategory;

struct InspectionModel;
impl ModelService for InspectionModel {
    fn invoke(
        &self,
        _: ModelSelection<'_>,
        _: &ModelRequest,
        _: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        panic!("context inspection must not invoke a model");
    }
    fn context_budget(&self, _: ModelSelection<'_>) -> Result<ContextBudget, CoreError> {
        Ok(ContextBudget::core_managed(
            ContextTokenCount::new(100_000),
            ContextTokenCount::new(2_000),
            ContextTokenCount::new(1_000),
            ContextCompactionLimit::Tokens(ContextTokenCount::new(93_000)),
        ))
    }
}

struct SkillCatalog;
impl ash_extension_api::TurnInputContributor for SkillCatalog {
    fn contribute(
        &self,
        context: ash_extension_api::TurnInputContext<'_>,
    ) -> Result<Vec<ash_extension_api::PromptFragment>, ash_extension_api::ExtensionError> {
        assert!(context.activated_skills().is_empty());
        Ok(vec![ash_extension_api::PromptFragment::new(
            ash_extension_api::PromptFragmentSource::new("skill-catalog", "available", "1"),
            ash_extension_api::PromptFragmentLayer::Skill,
            ash_extension_api::PromptFragmentRetention::BestEffort,
            "loaded skill metadata",
        )])
    }
}

#[test]
fn context_inspection_counts_loaded_categories_before_a_request_without_execution() {
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    let mut extensions = ash_extension_api::ExtensionRegistryBuilder::new();
    extensions.turn_input_contributor("skills", Arc::new(SkillCatalog));
    let executor = TurnExecutor::new(
        threads.clone(),
        Arc::new(InspectionModel),
        Arc::new(WeatherTool),
        Arc::new(SandboxActionPolicyService),
    )
    .with_instructions(Arc::new(HarnessInstructions::new(
        "host system",
        Some("loaded AGENTS.md".into()),
    )))
    .with_extensions(Arc::new(extensions.build()));
    let read = |scope| {
        executor
            .inspect_context(ContextInspectionRequest {
                scope,
                model: Some(ModelRef::new(
                    ProviderId::new("test").unwrap(),
                    ModelId::new("model").unwrap(),
                )),
                instructions: crate::test_turn_instructions(),
                approval_mode: ash_protocol::ApprovalMode::Manual,
                tool_mode: ash_protocol::ToolMode::Direct,
            })
            .unwrap()
    };
    let environment_inspection = read(ContextInspectionScope::Environment);
    assert_eq!(environment_inspection.tool_definitions.len(), 1);
    assert_eq!(
        environment_inspection.tool_definitions[0].name.as_str(),
        "weather"
    );
    let environment = &environment_inspection.context;
    assert_eq!(environment.latest_request, None);
    assert_eq!(
        environment.estimated_tokens,
        environment
            .categories
            .iter()
            .map(|category| category.tokens)
            .sum::<u64>()
    );
    for category in &environment.categories {
        match category.category {
            ModelContextCategory::Conversation => assert_eq!(category.tokens, 0),
            ModelContextCategory::SystemPrompt
            | ModelContextCategory::SystemTools
            | ModelContextCategory::MemoryFiles
            | ModelContextCategory::Skills => assert!(category.tokens > 0, "{category:?}"),
        }
    }
    let allocation = environment.allocation.as_ref().unwrap();
    assert_eq!(
        (
            allocation.context_window,
            allocation.auto_compact_at,
            allocation.auto_compact_buffer,
            allocation.reserved_output,
            allocation.safety_margin
        ),
        (100_000, 90_000, 7_000, 2_000, 1_000)
    );
    assert_eq!(allocation.auto_compact_window, 93_000);
    assert_eq!(
        allocation.context_window,
        allocation.auto_compact_at
            + allocation.auto_compact_buffer
            + allocation.reserved_output
            + allocation.safety_margin
    );
    assert!(threads.list_threads().unwrap().is_empty());
    let thread_id = ThreadId::new("inspection-thread").unwrap();
    threads
        .create_thread(CreateThreadRequest {
            execution_target: None,
            agent_id: ash_protocol::AgentId::new("agent").unwrap(),
            origin: Default::default(),
            agent: None,
            session_id: SessionId::new("inspection-session").unwrap(),
            thread_id: thread_id.clone(),
            title: "context".into(),
        })
        .unwrap();
    let before = threads.read_thread(&thread_id).unwrap();
    let inspected = read(ContextInspectionScope::Thread(&thread_id));
    assert_eq!(environment_inspection, inspected);
    let after = threads.read_thread(&thread_id).unwrap();
    assert_eq!(before.sequence, after.sequence);
    assert!(after.turns.is_empty());
}

#[test]
fn context_inspection_reads_existing_history_without_mutating_or_compacting_it() {
    let (threads, thread_id, _) = started_turn_with_history();
    let before = threads.read_thread(&thread_id).unwrap();
    let executor = TurnExecutor::without_tools(threads.clone(), Arc::new(InspectionModel));
    let inspected = executor
        .inspect_context(ContextInspectionRequest {
            scope: ContextInspectionScope::Thread(&thread_id),
            model: None,
            instructions: crate::test_turn_instructions(),
            approval_mode: ash_protocol::ApprovalMode::Manual,
            tool_mode: ash_protocol::ToolMode::Direct,
        })
        .unwrap();
    assert!(
        inspected
            .context
            .categories
            .iter()
            .find(|category| category.category == ModelContextCategory::Conversation)
            .unwrap()
            .tokens
            > 0
    );
    assert!(inspected.context.allocation.is_none());
    let after = threads.read_thread(&thread_id).unwrap();
    assert_eq!(before.sequence, after.sequence);
    assert_eq!(before.items, after.items);
    assert_eq!(before.context_checkpoints, after.context_checkpoints);
}
