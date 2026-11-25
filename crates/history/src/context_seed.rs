use ash_protocol::AgentCapabilityScope;
use ash_protocol::AgentContextMode;
use ash_protocol::AgentContextSeed;
use ash_protocol::AgentId;
use ash_protocol::AgentMaterializedContext;
use ash_protocol::AgentRoleSnapshot;
use ash_protocol::ContentDigest;
use ash_protocol::ContextSeedDigest;
use ash_protocol::DelegatedPolicyCeiling;
use ash_protocol::DelegatedTask;
use ash_protocol::DelegationId;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use serde::Deserialize;
use serde::Serialize;
use serde::de::Error;
use serde_json::value::RawValue;

/// Hashes the immutable material of a delegation seed.
pub fn context_seed_digest(seed: &AgentContextSeed) -> serde_json::Result<ContextSeedDigest> {
    digest(seed, seed.agent.base_instructions.as_ref())
}

/// Verifies the original instructions before replacing the digest in the replay projection.
pub(super) fn project_seed(
    seed: &mut AgentContextSeed,
    original_event: &RawValue,
) -> serde_json::Result<()> {
    #[derive(Deserialize)]
    struct Event<'a> {
        #[serde(borrow)]
        seed: OriginalSeed<'a>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct OriginalSeed<'a> {
        #[serde(borrow)]
        base_instructions: &'a RawValue,
    }

    let original: Event<'_> = serde_json::from_str(original_event.get())?;
    if digest(seed, Some(original.seed.base_instructions))? != seed.digest {
        return Err(serde_json::Error::custom(
            "Agent context seed digest does not match its original instructions",
        ));
    }
    seed.digest = context_seed_digest(seed)?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SeedMaterial<'a, Instructions> {
    delegation_id: &'a DelegationId,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_id: &'a Option<AgentId>,
    parent_thread_id: &'a ThreadId,
    parent_turn_id: &'a TurnId,
    parent_sequence: u64,
    task: &'a DelegatedTask,
    role: &'a Option<AgentRoleSnapshot>,
    inheritance: &'a AgentContextMode,
    #[serde(skip_serializing_if = "<[AgentMaterializedContext]>::is_empty")]
    materialized_context: &'a [AgentMaterializedContext],
    policy_ceiling: &'a DelegatedPolicyCeiling,
    capability_scope: &'a AgentCapabilityScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    base_instructions: Option<Instructions>,
}

fn digest(
    seed: &AgentContextSeed,
    base_instructions: Option<impl Serialize>,
) -> serde_json::Result<ContextSeedDigest> {
    let bytes = serde_json::to_vec(&SeedMaterial {
        delegation_id: &seed.delegation_id,
        agent_id: &seed.agent_id,
        parent_thread_id: &seed.parent_thread_id,
        parent_turn_id: &seed.parent_turn_id,
        parent_sequence: seed.parent_sequence,
        task: &seed.task,
        role: &seed.agent.role,
        inheritance: &seed.inheritance,
        materialized_context: &seed.materialized_context,
        policy_ceiling: &seed.policy_ceiling,
        capability_scope: &seed.agent.capability_scope,
        base_instructions,
    })?;
    let digest = ContentDigest::sha256(&bytes);
    Ok(ContextSeedDigest::new(digest.as_str()).expect("SHA-256 encoding is valid"))
}
