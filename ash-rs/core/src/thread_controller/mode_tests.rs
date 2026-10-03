use super::*;
use crate::CreateThreadRequest;
use crate::InMemoryThreadStore;
use crate::SequenceExpectation;
use crate::StartTurnRequest;
use ash_protocol::ApprovalMode;
use ash_protocol::CommandId;
use ash_protocol::SessionId;
use ash_protocol::UserInput;
use std::sync::Arc;

struct Fixture {
    store: Arc<InMemoryThreadStore>,
    threads: ThreadController,
    thread: ThreadId,
    turn: TurnId,
}

impl Fixture {
    fn new(mode: CollaborationMode) -> Self {
        let store = Arc::new(InMemoryThreadStore::default());
        let threads = ThreadController::with_store(store.clone());
        let thread = ThreadId::new("mode-thread").unwrap();
        threads
            .create_thread(CreateThreadRequest {
                execution_target: None,
                agent_id: ash_protocol::AgentId::new("mode-agent").unwrap(),
                origin: Default::default(),
                agent: None,
                session_id: SessionId::new("mode-session").unwrap(),
                thread_id: thread.clone(),
                title: "mode".into(),
            })
            .unwrap();
        let turn = threads
            .start_turn(
                &thread,
                StartTurnRequest {
                    command_id: CommandId::new("mode-start").unwrap(),
                    expected_sequence: SequenceExpectation::Any,
                    model: None,
                    reasoning_effort: None,
                    advisor: None,
                    kind: TurnKind::Coding,
                    mode,
                    instructions: ash_prompts::AGENT_INSTRUCTIONS
                        .freeze()
                        .with_shared(
                            &TurnInstructions::new(
                                "test",
                                "role",
                                "1",
                                "Preserve the selected role.",
                            )
                            .unwrap(),
                        )
                        .with_model_guidance(ash_protocol::ModelInstructionSelection::Generic {
                            model: None,
                        })
                        .with_mode(&mode_instructions(mode)),
                    policy_revision: "mode-policy".into(),
                    approval_mode: ApprovalMode::Manual,
                    tool_mode: ash_protocol::ToolMode::Direct,
                    tool_profile: None,
                    activated_skills: Vec::new(),
                    input: vec![UserInput::Text {
                        text: "investigate".into(),
                    }],
                },
            )
            .unwrap()
            .turn_id;
        Self {
            store,
            threads,
            thread,
            turn,
        }
    }

    fn change(
        &self,
        from: CollaborationMode,
        to: CollaborationMode,
        authority: ModeChangeAuthority,
    ) -> Result<ChangeTurnModeResult, CoreError> {
        self.threads.change_turn_mode(
            &self.thread,
            &self.turn,
            ChangeTurnModeRequest {
                expected_mode: from,
                mode: to,
                mode_instructions: mode_instructions(to),
                authority,
            },
        )
    }
}

fn mode_instructions(mode: CollaborationMode) -> TurnInstructions {
    TurnInstructions::new("test", "approach", "1", format!("Approach: {mode:?}")).unwrap()
}

#[test]
fn mode_switch_preserves_rules_and_permissions_across_replay() {
    let fixture = Fixture::new(CollaborationMode::Agent);
    let before = fixture.threads.read_thread(&fixture.thread).unwrap();
    let result = fixture
        .change(
            CollaborationMode::Agent,
            CollaborationMode::Plan,
            ModeChangeAuthority::Agent,
        )
        .unwrap();
    assert!(result.changed);
    let after = fixture.threads.read_thread(&fixture.thread).unwrap();
    let mut expected = before.turns[0].clone();
    expected.mode = CollaborationMode::Plan;
    expected.instructions = Some(
        expected
            .instructions
            .unwrap()
            .with_mode(&mode_instructions(CollaborationMode::Plan)),
    );
    assert_eq!(after.turns[0], expected);
    assert_eq!(
        fixture
            .threads
            .read_thread_at_sequence(&fixture.thread, before.sequence)
            .unwrap()
            .turns[0]
            .mode,
        CollaborationMode::Agent
    );
    let reopened = ThreadController::with_store(fixture.store);
    assert_eq!(reopened.read_thread(&fixture.thread).unwrap(), after);
}

#[test]
fn analysis_mode_requires_user_authority_to_start_execution() {
    for from in [CollaborationMode::Plan, CollaborationMode::Ask] {
        let fixture = Fixture::new(from);
        let sequence = fixture
            .threads
            .read_thread(&fixture.thread)
            .unwrap()
            .sequence;
        for to in [
            CollaborationMode::Agent,
            CollaborationMode::Debug,
            CollaborationMode::Multitask,
        ] {
            assert!(matches!(
                fixture.change(from, to, ModeChangeAuthority::Agent),
                Err(CoreError::Policy(_))
            ));
        }
        assert_eq!(
            fixture
                .threads
                .read_thread(&fixture.thread)
                .unwrap()
                .sequence,
            sequence
        );
        let result = fixture
            .change(from, CollaborationMode::Agent, ModeChangeAuthority::User)
            .unwrap();
        assert_eq!(result.mode, CollaborationMode::Agent);
    }
}

#[test]
fn same_mode_is_idempotent_and_stale_decisions_are_rejected() {
    let fixture = Fixture::new(CollaborationMode::Plan);
    let sequence = fixture
        .threads
        .read_thread(&fixture.thread)
        .unwrap()
        .sequence;
    let unchanged = fixture
        .change(
            CollaborationMode::Plan,
            CollaborationMode::Plan,
            ModeChangeAuthority::Agent,
        )
        .unwrap();
    assert!(!unchanged.changed);
    assert_eq!(unchanged.sequence, sequence);
    fixture
        .change(
            CollaborationMode::Plan,
            CollaborationMode::Ask,
            ModeChangeAuthority::Agent,
        )
        .unwrap();
    assert!(matches!(
        fixture.change(
            CollaborationMode::Plan,
            CollaborationMode::Agent,
            ModeChangeAuthority::User
        ),
        Err(CoreError::Policy(_))
    ));
    assert_eq!(
        fixture.threads.read_thread(&fixture.thread).unwrap().turns[0].mode,
        CollaborationMode::Ask
    );
}

#[test]
fn mode_switch_rejects_terminal_turns() {
    let fixture = Fixture::new(CollaborationMode::Agent);
    fixture
        .threads
        .complete_turn(&fixture.thread, &fixture.turn, "done".into())
        .unwrap();
    assert!(matches!(
        fixture.change(
            CollaborationMode::Agent,
            CollaborationMode::Debug,
            ModeChangeAuthority::User
        ),
        Err(CoreError::Policy(_))
    ));
}
