use super::*;
use crate::InMemoryThreadStore;
use crate::SequenceExpectation;
use crate::StartThreadRequest;
use crate::StartTurnRequest;
use crate::ThreadController;
use crate::thread_controller::PrepareModelInvocationRequest;
use ash_protocol::AgentCapabilityScope;
use ash_protocol::AgentConfiguration;
use ash_protocol::AgentRoleSnapshot;
use ash_protocol::CommandId;
use ash_protocol::ModelRequest;
use ash_protocol::ThreadId;
use ash_protocol::ToolDefinition;
use ash_protocol::ToolName;
use ash_protocol::TurnId;
use ash_protocol::TurnInstructions;
use ash_protocol::UserInput;
use std::hint::black_box;
use std::sync::Arc;
use std::time::Instant;

struct Fixture {
    controller: ThreadController,
    thread: ThreadId,
    turn: TurnId,
    tools: Vec<ToolDefinition>,
}
impl Fixture {
    fn new(
        tools: Vec<ToolDefinition>,
        agent: Option<AgentConfiguration>,
        instructions: TurnInstructions,
    ) -> Self {
        let controller = ThreadController::with_store(Arc::new(InMemoryThreadStore::default()));
        let thread = controller
            .start_thread(
                &crate::NoThreadWorktreeBinder,
                StartThreadRequest {
                    agent_id: None,
                    agent,
                    command_id: CommandId::new("benchmark-root").unwrap(),
                    title: "benchmark".into(),
                },
            )
            .unwrap();
        let turn = controller
            .start_turn(
                &thread.thread_id,
                StartTurnRequest {
                    command_id: CommandId::new("benchmark-turn").unwrap(),
                    expected_sequence: SequenceExpectation::Exact(1),
                    model: None,
                    kind: ash_protocol::TurnKind::Coding,
                    instructions,
                    policy_revision: "benchmark-v1".into(),
                    approval_mode: ash_protocol::ApprovalMode::default(),
                    tool_mode: ash_protocol::ToolMode::Direct,
                    tool_profile: None,
                    activated_skills: Vec::new(),
                    input: vec![UserInput::Text {
                        text: "Inspect the parser.".into(),
                    }],
                },
            )
            .unwrap();
        Self {
            controller,
            thread: thread.thread_id,
            turn: turn.turn_id,
            tools,
        }
    }
    fn request(&self) -> ModelRequest {
        let ModelInvocationPreparation::Ready(invocation) = self
            .controller
            .prepare_model_invocation(
                &self.thread,
                PrepareModelInvocationRequest {
                    turn_id: &self.turn,
                    harness_context: &HarnessContext::default(),
                    extension_fragments: Vec::new(),
                    evidence: Vec::new(),
                    tools: self.tools.clone(),
                    budget: ContextBudget::provider_managed(),
                },
            )
            .unwrap()
        else {
            panic!("benchmark context must fit")
        };
        ContextAssembler::assemble(invocation.context()).unwrap()
    }
}

#[test]
#[ignore = "offline instruction benchmark; run explicitly with --ignored --nocapture --test-threads=1"]
fn instruction_benchmark_composition() {
    const SAMPLES: usize = 1000;
    for (tool_count, role_bytes) in [(16, 1024), (128, 1024), (512, 1024), (128, 8192)] {
        let tools = (0..tool_count).map(|index| ToolDefinition {
            name: ToolName::new(format!("tool_{index}")).unwrap(), description: "A benchmark tool.".into(),
            parameters: serde_json::json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false}), strict: true,
        }).collect::<Vec<_>>();
        let base = ash_prompts::AGENT_INSTRUCTIONS.freeze();
        let composed = Fixture::new(
            tools.clone(),
            Some(AgentConfiguration {
                role: Some(AgentRoleSnapshot {
                    name: "benchmark".into(),
                    instructions: "x".repeat(role_bytes),
                    model: None,
                    definition: None,
                }),
                capability_scope: AgentCapabilityScope {
                    tools: tools.iter().map(|tool| tool.name.clone()).collect(),
                    delegation_tools: Vec::new(),
                    skills: Vec::new(),
                },
                base_instructions: Some(base.clone()),
            }),
            base,
        );
        let expected = composed.request();
        // The host inserts the same permission prefix in both variants.
        let permission_prefix =
            ash_prompts::permissions_instructions(ash_protocol::ApprovalMode::default())
                .into_iter()
                .map(|asset| asset.body().trim())
                .collect::<Vec<_>>()
                .join("\n\n")
                + "\n\n";
        let flat_body = expected
            .instructions
            .as_ref()
            .unwrap()
            .strip_prefix(&permission_prefix)
            .expect("host permissions precede Agent instructions")
            .to_owned();
        let flat = Fixture::new(
            tools,
            None,
            TurnInstructions::new("benchmark", "flat", "v1", flat_body).unwrap(),
        );
        assert_eq!(
            flat.request(),
            expected,
            "control must emit the exact same request"
        );
        let request_bytes = serde_json::to_vec(&expected).unwrap().len();
        for _ in 0..100 {
            black_box(flat.request());
            black_box(composed.request());
        }
        let mut times = [Vec::with_capacity(SAMPLES), Vec::with_capacity(SAMPLES)];
        for sample in 0..SAMPLES {
            for index in [sample % 2, 1 - sample % 2] {
                let fixture = if index == 0 { &flat } else { &composed };
                let started = Instant::now();
                let request = black_box(fixture.request());
                times[index].push(started.elapsed().as_nanos() as u64);
                black_box(request);
            }
        }
        for (variant, mut samples) in ["flat", "composed"].into_iter().zip(times) {
            let raw = samples.clone();
            samples.sort_unstable();
            println!(
                "{}",
                serde_json::json!({"benchmark":"instruction_composition","variant":variant,"tool_count":tool_count,"role_bytes":role_bytes,"request_bytes":request_bytes,"samples":SAMPLES,"samples_ns":raw,"warmup":100,"p50_ns":samples[SAMPLES/2],"p95_ns":samples[SAMPLES*95/100],"p99_ns":samples[SAMPLES*99/100],"debug_assertions":cfg!(debug_assertions),"network":false})
            );
        }
    }
}

#[test]
#[ignore = "offline time-context assembly benchmark; no model or network calls"]
fn time_context_benchmark() {
    const SAMPLES: usize = 1000;
    const WARMUP: usize = 100;
    let environment = "<environment_context>\ncurrent_date: 2026-09-12\n</environment_context>";
    let time = "<time_context>\nnow: 2026-09-12T19:29:47-07:00\ntimezone: America/Los_Angeles\n</time_context>";
    for tool_count in [16, 128] {
        let tools = (0..tool_count).map(|index| ToolDefinition {
            name: ToolName::new(format!("tool_{index}")).unwrap(),
            description: "A benchmark tool.".into(),
            parameters: serde_json::json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false}),
            strict: true,
        }).collect::<Vec<_>>();
        let fixture = Fixture::new(tools, None, ash_prompts::AGENT_INSTRUCTIONS.freeze());
        let snapshot = fixture.controller.read_thread(&fixture.thread).unwrap();
        let instructions = vec![InstructionFragment::new(
            InstructionSource::new("benchmark", "stable-instructions", "v1"),
            InstructionPlacement::System,
            InstructionRetention::Required,
            ash_prompts::AGENT_INSTRUCTIONS.freeze().body(),
        )];
        let build = |with_time| {
            let environment = if with_time {
                format!("{environment}\n{time}")
            } else {
                environment.to_owned()
            };
            let input = ContextInput::new(
                &snapshot,
                fixture.turn.clone(),
                instructions.clone(),
                fixture.tools.clone(),
                ContextBudget::provider_managed(),
            )
            .with_rendered_environment(environment);
            let ContextPreparation::Ready(plan) = ContextPlanner::prepare(&input).unwrap() else {
                panic!("context should fit")
            };
            let request = ContextAssembler::assemble(&plan).unwrap();
            let bytes = serde_json::to_vec(&request).unwrap();
            (request, bytes)
        };
        let (base, base_bytes) = build(false);
        let (injected, injected_bytes) = build(true);
        let prefix_end = base.prompt_cache_prefix_end.unwrap() as usize;
        assert_eq!(
            base.prompt_cache_prefix_end,
            injected.prompt_cache_prefix_end
        );
        assert_eq!(base.instructions, injected.instructions);
        assert_eq!(base.tools, injected.tools);
        assert_eq!(base.input[..=prefix_end], injected.input[..=prefix_end]);
        assert_ne!(base.input.last(), injected.input.last());
        for _ in 0..WARMUP {
            black_box(build(false));
            black_box(build(true));
        }
        let mut samples = [Vec::with_capacity(SAMPLES), Vec::with_capacity(SAMPLES)];
        for sample in 0..SAMPLES {
            for variant in [sample % 2, 1 - sample % 2] {
                let started = Instant::now();
                let result = black_box(build(variant == 1));
                samples[variant].push(started.elapsed().as_nanos() as u64);
                black_box(result);
            }
        }
        for (variant, raw) in samples.into_iter().enumerate() {
            let mut sorted = raw.clone();
            sorted.sort_unstable();
            println!(
                "{}",
                serde_json::json!({
                    "benchmark": "time_context_assembly", "variant": if variant == 0 {"baseline"} else {"time_suffix"},
                    "tool_count": tool_count, "samples": SAMPLES, "warmup": WARMUP,
                    "samples_ns": raw, "p50_ns": sorted[SAMPLES / 2], "p95_ns": sorted[SAMPLES * 95 / 100],
                    "request_bytes": if variant == 0 {base_bytes.len()} else {injected_bytes.len()},
                    "scope": "ContextInput creation + ContextPlanner + ContextAssembler + serde_json serialization; no host time sampling or model inference",
                    "preserves_reusable_prefix": true, "debug_assertions": cfg!(debug_assertions), "network": false
                })
            );
        }
        assert_eq!(
            fixture
                .controller
                .read_thread(&fixture.thread)
                .unwrap()
                .sequence,
            snapshot.sequence
        );
    }
}
