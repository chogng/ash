use serde_json::Map;
use serde_json::Value;

pub(super) const TASK_INSTRUCTIONS_SCHEMA_VERSION: u32 = 39;

fn strip_instructions(instructions: &mut Value) -> bool {
    let Some(fields) = instructions.as_object_mut() else {
        return false;
    };
    let mut changed = fields.remove("modeInstructions").is_some();
    if let Some(messages) = fields
        .get_mut("modelGuidance")
        .and_then(|guidance| guidance.get_mut("messages"))
        .and_then(Value::as_object_mut)
    {
        let agent_modes = messages.remove("agentModes");
        let collaboration_modes = messages.remove("collaborationModes");
        if agent_modes.is_some() || collaboration_modes.is_some() {
            messages
                .entry("taskCommands")
                .or_insert_with(|| Value::Object(Map::new()));
            changed = true;
        }
    }
    changed
}

/// Drops pre-39 Agent Mode keys from a stored Turn, acceptance, or start command.
pub fn discard_retired_turn_fields(turn: &mut Value) -> bool {
    let Some(fields) = turn.as_object_mut() else {
        return false;
    };
    let mode_removed = fields.remove("mode").is_some();
    let instructions_changed = fields
        .get_mut("instructions")
        .is_some_and(strip_instructions);
    mode_removed || instructions_changed
}

pub(super) fn start_command(receipt: &mut Value) -> Option<&mut Value> {
    receipt
        .get_mut("command")
        .filter(|command| command.get("type").and_then(Value::as_str) == Some("startTurn"))
}

pub(super) fn used_retired_execution(turn: &Value) -> bool {
    turn.get("mode")
        .is_some_and(|mode| mode.as_str() != Some("agent"))
        && turn
            .pointer("/instructions/taskCommand")
            .is_none_or(Value::is_null)
}

pub(super) fn strip_event(event: &mut Value) -> bool {
    match event.get("type").and_then(Value::as_str) {
        Some("turnAccepted") => discard_retired_turn_fields(event),
        Some("historyImported" | "forkHistoryImported") => {
            let mut changed = false;
            if let Some(turns) = event.get_mut("turns").and_then(Value::as_array_mut) {
                for turn in turns {
                    changed |= discard_retired_turn_fields(turn);
                }
            }
            changed
        }
        Some("forkTurnImported") => event
            .get_mut("turn")
            .is_some_and(discard_retired_turn_fields),
        Some("threadCreated") => event
            .get_mut("agent")
            .is_some_and(discard_retired_agent_fields),
        Some("agentContextSeedCommitted" | "delegationRequested") => event
            .get_mut("seed")
            .is_some_and(discard_retired_agent_fields),
        _ => false,
    }
}

/// Drops retired mode guidance from a stored Agent configuration.
pub fn discard_retired_agent_fields(agent: &mut Value) -> bool {
    agent
        .get_mut("baseInstructions")
        .is_some_and(strip_instructions)
}
